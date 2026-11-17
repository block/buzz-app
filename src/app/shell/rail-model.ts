import { useEffect, useSyncExternalStore } from "react";
import { canMessageAgent } from "../../features/agents/choices";
import { hiddenSoloChats } from "../../features/channel-navigation/solo-navigation-model";
import { soloNavigationFor } from "../../features/channel-navigation/solo-navigation";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import {
  conversationIndex,
  type ConversationQuery,
} from "../../features/conversation/conversation-index";
import { dmLabel } from "../../features/conversation/dm-label";
import type { NavigationScope } from "../../features/navigation/targets";
import type { RegisteredPage } from "../../features/pages/service";
import type { ChannelList, Profile } from "../../features/relay/contracts";
import { archiveHides } from "../../features/relay/identity-archives";
import { selectProfiles } from "../../features/relay/profile-selection";
import { sameRoster } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { subscribeView, viewRevision } from "../../shared/view-state";
import { LAYOUT_KEY, parseRailLayout } from "./rail-layout";
import { PINS_KEY, parseRailEntries, type RailEntry } from "./rail-pins";
import { railSections } from "./rail-sections";

/** Solo's chats, most recent first: the index keeps them in order. */
export const soloView: ConversationQuery = {
  filter: "all",
  unread: false,
  home: "solo",
};
const teamView: ConversationQuery = {
  filter: "all",
  unread: false,
  home: "team",
  sort: "recent",
};
type Inputs = Readonly<{
  pages: readonly RegisteredPage[];
  sidebarSections: SidebarSections | undefined;
}>;
type Names = (pubkey: string, fallback: string) => string;

/** People as rail rows: never the viewer, an agent, or someone archived. */
export function personEntries(
  session: RelaySession,
  viewer: string,
  profiles: Iterable<readonly [string, Profile]>,
  agents: ReadonlySet<string>,
  resolveName: Names,
): RailEntry[] {
  return [...profiles]
    .filter(
      ([key, profile]) =>
        key !== viewer &&
        !profile.isAgent &&
        !profile.nameIsFallback &&
        !agents.has(key) &&
        !archiveHides(session.archives, key, viewer),
    )
    .map(([pubkey, profile]) => ({
      id: `person:${pubkey}`,
      label: resolveName(pubkey, profile.name),
      kind: "person",
      picture: profile.picture,
      target: { kind: "person", pubkey },
    }));
}

/** Recomputes a part only when one of the values it was made from changes. */
function part<T>() {
  let made: readonly unknown[] | undefined;
  let value: T;
  return (from: readonly unknown[], make: () => T) => {
    if (!made || from.some((item, index) => item !== made?.[index])) {
      made = from;
      value = make();
    }
    return value;
  };
}

function createRailModel(session: RelaySession) {
  const partition = session.scope;
  const viewer = session.viewer ?? "";
  const scope: NavigationScope = {
    viewer,
    communityOrigin: partition.slice(0, -(viewer.length + 1)),
  };
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  let inputs: Inputs = { pages: [], sidebarSections: undefined };
  let stop: (() => void) | undefined;
  let stopSections: (() => void) | undefined;
  // Names change without their source changing identity.
  let names = 0;
  let roster: ChannelList | undefined;
  /** Rows a change left alone stay the same objects, so only theirs redraw. */
  let rows = new Map<string, RailEntry>();

  /** The agents the rail lists stay loaded while something reads it. */
  const ensureAgents = () => {
    const choices = session.agentChoices.snapshot();
    if (choices.pending || choices.archives.status === "idle")
      session.agentChoices.ensure(true, true);
  };
  const watchSections = () => {
    stopSections?.();
    stopSections = stop && inputs.sidebarSections?.subscribe(changed);
  };
  function start() {
    const solo = soloNavigationFor(session);
    const stops = [
      session.channels.ensureList(),
      session.channels.subscribeList(changed),
      session.profiles.subscribe(changed),
      session.archives.subscribe(changed),
      session.agentChoices.retain(),
      session.agentChoices.subscribe(() => {
        ensureAgents();
        changed();
      }),
      session.names?.subscribe?.(() => {
        names++;
        changed();
      }),
      conversationIndex(session).watch(soloView, changed),
      conversationIndex(session).watch(teamView, changed),
      solo?.subscribe(changed),
      subscribeView(partition, (key) => {
        if (!key || key === LAYOUT_KEY || key === PINS_KEY) changed();
      }),
    ];
    stop = () => {
      for (const end of stops) end?.();
    };
    ensureAgents();
    watchSections();
  }

  const parts = {
    channels: part<ReturnType<typeof listed>>(),
    layout: part<ReturnType<typeof parseRailLayout>>(),
    pins: part<RailEntry[]>(),
    named: part<ReturnType<typeof selectProfiles>>(),
    entries: part<ReturnType<typeof entriesOf>>(),
    sections: part<ReturnType<typeof railSections>>(),
    solo: part<ReturnType<typeof listed>["channels"]>(),
    team: part<ReturnType<typeof listed>["channels"]>(),
    model: part<ReturnType<typeof modelOf>>(),
  };
  const listed = (list: ChannelList) => {
    const channels = list.channels.filter(
      (channel) =>
        !channel.archived && !channel.huddle && !channel.metadataPending,
    );
    return {
      channels,
      channelsById: new Map(channels.map((channel) => [channel.id, channel])),
    };
  };
  const resolveName: Names = (pubkey, fallback) =>
    session.names?.resolve(pubkey, fallback) ?? fallback;
  function entriesOf(
    channels: ReturnType<typeof listed>["channels"],
    profiles: ReadonlyMap<string, Profile>,
    agents: ReturnType<RelaySession["agentChoices"]["snapshot"]>,
    pins: readonly RailEntry[],
    pages: readonly RegisteredPage[],
  ) {
    const channelEntries = channels.map((channel): RailEntry => {
      const dm = channel.channelType === "dm";
      const other = dm ? channel.participants?.[0] : undefined;
      return {
        id: `channel:${channel.id}`,
        label: dm
          ? dmLabel(channel.participants, profiles, resolveName, channel.name)
          : channel.name,
        kind: dm
          ? "person"
          : channel.channelType === "solo"
            ? "chat"
            : "channel",
        picture: other ? profiles.get(other)?.picture : undefined,
        target: {
          version: 1,
          kind: "conversation",
          scope,
          channelId: channel.id,
        },
      };
    });
    const agentEntries = agents.selectable.filter(canMessageAgent).map(
      (agent): RailEntry => ({
        id: `agent:${agent.pubkey}`,
        label: agent.managedName ?? agent.name,
        picture: agent.avatar,
        kind: "agent",
        target: { kind: "person", pubkey: agent.pubkey },
      }),
    );
    // Only pinned people need labels: the open picker lists everyone itself.
    const people = personEntries(
      session,
      scope.viewer,
      pins.flatMap((pin) => {
        if (pin.target.kind !== "person") return [];
        const profile = profiles.get(pin.target.pubkey);
        return profile ? [[pin.target.pubkey, profile] as const] : [];
      }),
      new Set(agents.identities.map((agent) => agent.pubkey)),
      resolveName,
    );
    const pageEntries = pages.map(
      (page): RailEntry => ({
        id: page.key,
        label: page.title,
        kind: "page",
        target: {
          version: 1,
          kind: "page",
          pluginId: page.pluginId,
          pageId: page.id,
          scope,
        },
      }),
    );
    const kept = (entries: RailEntry[]) =>
      entries.map((entry) => {
        const old = rows.get(entry.id);
        return old &&
          old.label === entry.label &&
          old.kind === entry.kind &&
          old.picture === entry.picture
          ? old
          : entry;
      });
    const entries = [
      ...kept(channelEntries),
      ...kept(agentEntries),
      ...kept(people),
      ...kept(pageEntries),
    ];
    rows = new Map(entries.map((entry) => [entry.id, entry]));
    return {
      agentEntries: entries.slice(
        channelEntries.length,
        channelEntries.length + agentEntries.length,
      ),
      entries,
      byId: rows as ReadonlyMap<string, RailEntry>,
    };
  }
  const modelOf = (
    listing: ReturnType<typeof listed>,
    built: ReturnType<typeof entriesOf>,
    agents: ReturnType<RelaySession["agentChoices"]["snapshot"]>,
    layout: ReturnType<typeof parseRailLayout>,
    pins: readonly RailEntry[],
    sections: ReturnType<typeof railSections>,
    soloChats: ReturnType<typeof listed>["channels"],
    teamChats: ReturnType<typeof listed>["channels"],
  ) => ({
    ...listing,
    ...built,
    agents,
    layout,
    pins,
    sections,
    soloChats,
    teamChats,
  });

  function snapshot() {
    const next = session.channels.list();
    if (!roster || !sameRoster(roster, next)) roster = next;
    const listing = parts.channels([roster], () => listed(next));
    const layoutRevision = viewRevision(partition, LAYOUT_KEY);
    const layout = parts.layout([layoutRevision], () =>
      parseRailLayout(JSON.parse(layoutRevision ?? "null")),
    );
    const pinsRevision = viewRevision(partition, PINS_KEY);
    const pins = parts.pins([pinsRevision], () =>
      parseRailEntries(JSON.parse(pinsRevision ?? "[]")),
    );
    // The rail names DM participants and pinned people, so only their
    // profiles change it. Each row's artwork follows its own people.
    const profiles = parts
      .named([listing, pins], () =>
        selectProfiles(session.profiles, [
          ...new Set([
            ...listing.channels.flatMap((channel) =>
              channel.channelType === "dm" ? (channel.participants ?? []) : [],
            ),
            ...pins.flatMap((pin) =>
              pin.target.kind === "person" ? [pin.target.pubkey] : [],
            ),
          ]),
        ]),
      )
      .snapshot();
    const agents = session.agentChoices.snapshot();
    const built = parts.entries(
      [
        listing,
        profiles,
        agents,
        pins,
        inputs.pages,
        names,
        session.archives.snapshot(),
      ],
      () => entriesOf(listing.channels, profiles, agents, pins, inputs.pages),
    );
    const contributed = inputs.sidebarSections?.snapshot();
    const sections = parts.sections([layout, contributed], () =>
      railSections(
        layout,
        contributed?.map((section) => ({
          id: section.key,
          title: section.title,
        })),
      ),
    );
    const soloOrder = conversationIndex(session).keys(soloView);
    const regions = soloNavigationFor(session)?.snapshot().regions;
    // A plugin that hides its Solo region lists its chats in its own UI.
    const soloChats = parts.solo([soloOrder, listing, regions], () => {
      const hidden = hiddenSoloChats(regions ?? []);
      return soloOrder.flatMap((key) => {
        const channel = listing.channelsById.get(key.slice(2));
        return channel && !hidden.has(channel.id) ? [channel] : [];
      });
    });
    const teamOrder = conversationIndex(session).keys(teamView);
    const teamChats = parts.team([teamOrder, listing], () =>
      teamOrder.flatMap((key) => {
        const channel = listing.channelsById.get(key.slice(2));
        return channel ? [channel] : [];
      }),
    );
    return parts.model(
      [listing, built, agents, layout, pins, sections, soloChats, teamChats],
      () =>
        modelOf(
          listing,
          built,
          agents,
          layout,
          pins,
          sections,
          soloChats,
          teamChats,
        ),
    );
  }

  return {
    snapshot,
    /** Watches the session while anything reads the model, and not after. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stop?.();
        stop = undefined;
        watchSections();
      };
    },
    /** What the app, not the session, contributes: its pages and sections. */
    provide(next: Inputs) {
      if (
        next.pages === inputs.pages &&
        next.sidebarSections === inputs.sidebarSections
      )
        return;
      inputs = next;
      watchSections();
      changed();
    },
  };
}

const models = new WeakMap<RelaySession, ReturnType<typeof createRailModel>>();
/** One model of the app sidebar per session: its cards and its section list
 * read it and only draw. */
export function railModel(session: RelaySession) {
  let model = models.get(session);
  if (!model) {
    model = createRailModel(session);
    models.set(session, model);
  }
  return model;
}

export function useRailModel(session: RelaySession) {
  const model = railModel(session);
  return useSyncExternalStore(model.subscribe, model.snapshot);
}
/** The app shell hands the model its pages and contributed sections. */
export function useRailInputs(
  session: RelaySession,
  pages: readonly RegisteredPage[],
  sidebarSections: SidebarSections | undefined,
) {
  useEffect(
    () => railModel(session).provide({ pages, sidebarSections }),
    [session, pages, sidebarSections],
  );
}
