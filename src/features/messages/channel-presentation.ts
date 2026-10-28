import type {
  ChannelMessage,
  ChannelWindow,
  Profile,
} from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { rowProfileIds } from "../relay/membership";
import { knownAgentPubkeys } from "../agents/known";
import type { AgentLibrary } from "../agents/library";
import { profileKey } from "../profiles/target";
import { scanMarkdown, MAX_MARKDOWN_LENGTH } from "../relay/message-content";
import type { ReferenceChannel } from "./ReferenceText";
import {
  membershipRows,
  withoutStartingAgents,
  type TimelineRow,
} from "./membership-rows";
import { activityGroups, type ActivityGroup } from "./activity-groups";
import { continuesMessageGroup } from "./message-grouping";

// FOUNDATION: a channel-owned display projection of canonical query snapshots.
// Publish complete immutable generations before notification. Reads never reconcile.
// No protocol projection, network demand, virtualizer or view-retention policy lives here.
type Listener = () => void;
const emptyProfiles: ReadonlyMap<string, Profile> = new Map();
const emptyChannels: readonly ReferenceChannel[] = [];
const emptyIds: readonly string[] = [];
export type RowPermissions = Readonly<{
  listed: boolean;
  cached: boolean;
  archived: boolean;
  readOnly: boolean;
}>;
export type RowDirectory = Readonly<{
  profiles: ReadonlyMap<string, Profile>;
  channels: readonly ReferenceChannel[];
  named: readonly ReferenceChannel[];
  agents: AgentLibrary["identities"];
}>;
export type ChannelRowPresentation = Readonly<{
  row: TimelineRow;
  previousId: string | undefined;
  nextId: string | undefined;
  stackPrevious: boolean;
  stackNext: boolean;
  day: boolean;
  last: boolean;
  profileIds: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  agentPubkeys: ReadonlySet<string>;
  directory: RowDirectory;
  permissions: RowPermissions;
}>;
export type ChannelPresentationHeader = Omit<ChannelWindow, "rows"> &
  Readonly<{
    rowCount: number;
    newestId: string | undefined;
  }>;
export type ChannelPresentationView = Readonly<{
  window: ChannelWindow;
  rawRows: readonly ChannelMessage[];
  rows: readonly TimelineRow[];
  ids: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  agentPubkeys: ReadonlySet<string>;
  activity: readonly ActivityGroup[];
}>;
type NameSelection = {
  ids: readonly string[];
  current: ReadonlyMap<string, string | undefined>;
  generation: object;
  listeners: Set<Listener>;
};
const sameArray = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const sameMap = <T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>) =>
  a.size === b.size &&
  [...a].every(([key, value]) => b.has(key) && b.get(key) === value);
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key));
const sameReference = (a: ReferenceChannel, b: ReferenceChannel | undefined) =>
  a.id === b?.id &&
  a.name === b.name &&
  a.channelType === b.channelType &&
  a.private === b.private &&
  a.archived === b.archived;
function retainReferences(
  next: readonly ReferenceChannel[],
  old: readonly ReferenceChannel[],
) {
  return next.length === old.length &&
    next.every((row, i) => sameReference(row, old[i]))
    ? old
    : next;
}
/** Explicit locators are display dependencies, never signed mention intent.
 * Use the renderer's existing bounded CommonMark scan and exact profile validator.
 * Plain prose has no link/definition/autolink delimiter and needs no scan. */
function explicitProfileKeys(row: TimelineRow): readonly string[] {
  if (
    row.membership ||
    row.content.length > MAX_MARKDOWN_LENGTH ||
    (!row.content.includes("[") && !row.content.includes("<"))
  )
    return emptyIds;
  const scan = scanMarkdown(row.content);
  if (scan.tooDeep) return emptyIds;
  return scan.links.flatMap((node) => {
    const url =
      node.type === "link"
        ? node.url
        : typeof node.identifier === "string"
          ? scan.definitions.get(node.identifier.toLowerCase())
          : undefined;
    const key = url && profileKey(url);
    return key ? [key] : [];
  });
}
function dependencies(row: TimelineRow): readonly string[] {
  return [
    ...new Set([
      ...(row.membershipRows ?? [row]).flatMap(rowProfileIds),
      ...explicitProfileKeys(row),
      ...row.reactions.flatMap((reaction) =>
        reaction.events.map((event) => event.authorId),
      ),
    ]),
  ].sort();
}
function sameMembership(a: TimelineRow | undefined, b: TimelineRow) {
  return (
    !!a?.membershipRows &&
    !!b.membershipRows &&
    a.createdAt === b.createdAt &&
    sameArray(a.membershipRows, b.membershipRows)
  );
}
function namesFor(
  ids: readonly string[],
  names: ReadonlyMap<string, string | undefined>,
) {
  return new Map(ids.map((id) => [id, names.get(id)]));
}

/** One instance per mounted channel presentation. It holds only its current bounded
 * canonical window, not historical DOM or a process-global channel cache. */
export function createChannelPresentation(
  session: RelaySession,
  channelId: string,
  options: { chat: boolean; viewer: string | undefined },
) {
  let root: {
    header: ChannelPresentationHeader;
    view: ChannelPresentationView;
    cells: ReadonlyMap<string, ChannelRowPresentation>;
    names: ReadonlyMap<string, string | undefined>;
    members: readonly string[];
  };
  let reverse = new Map<string, Set<string>>();
  let indexed = false;
  const headerListeners = new Set<Listener>();
  const viewListeners = new Set<Listener>();
  const rowListeners = new Map<string, Set<Listener>>();
  const selections = new Set<NameSelection>();
  let consumers = 0;
  let stops: (() => void)[] = [];
  let epoch = 0;
  let refreshing = false;
  let pending = false;
  let previousWindow: ChannelWindow | undefined;
  let previousProfiles: ReadonlyMap<string, Profile> = emptyProfiles;
  let previousChoices:
    | ReturnType<RelaySession["agentChoices"]["snapshot"]>
    | undefined;
  let previousLibrary:
    | ReturnType<RelaySession["agentLibrary"]["snapshot"]>
    | undefined;
  let profileIds = new Set<string>();
  let channels: readonly ReferenceChannel[] = emptyChannels;
  let named: readonly ReferenceChannel[] = emptyChannels;
  let permissions: RowPermissions = Object.freeze({
    listed: false,
    cached: false,
    archived: false,
    readOnly: false,
  });

  function reconcile() {
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    try {
      do {
        pending = false;
        const window = session.channels.window(channelId);
        const allProfiles = session.profiles.snapshot();
        const choices = session.agentChoices.snapshot();
        const library = session.agentLibrary.snapshot();
        const list = session.channels.list();
        const channel = list.channels.find((entry) => entry.id === channelId);
        const members = channel?.members ?? emptyIds;
        const nextPermissions: RowPermissions = {
          listed: !!channel,
          cached: !!channel?.cached,
          archived: !!channel?.archived,
          readOnly: !!channel?.readOnly,
        };
        const permissionsChanged = Object.keys(nextPermissions).some(
          (key) =>
            nextPermissions[key as keyof RowPermissions] !==
            permissions[key as keyof RowPermissions],
        );
        if (permissionsChanged) permissions = Object.freeze(nextPermissions);
        const nextChannels = retainReferences(list.channels, channels);
        const joined = new Set(nextChannels.map((entry) => entry.id));
        const taken = new Set(
          nextChannels
            .filter((entry) => !entry.archived)
            .map((entry) => entry.name),
        );
        const open = session.channels.openDirectory?.() ?? emptyChannels;
        const nextNamed = open.length
          ? retainReferences(
              [
                ...nextChannels,
                ...open.filter(
                  (entry) => !joined.has(entry.id) && !taken.has(entry.name),
                ),
              ],
              named,
            )
          : nextChannels;
        const referencesChanged =
          channels !== nextChannels || named !== nextNamed;
        channels = nextChannels;
        named = nextNamed;
        const canonicalChanged =
          !indexed || previousWindow?.rows !== window.rows;
        if (canonicalChanged)
          profileIds = new Set(window.rows.flatMap(rowProfileIds));
        const selected = new Map<string, Profile>();
        for (const id of profileIds) {
          const profile = allProfiles.get(id);
          if (profile) selected.set(id, profile);
        }
        const profiles =
          root && sameMap(root.view.profiles, selected)
            ? root.view.profiles
            : selected;
        const agentKeys = knownAgentPubkeys(profiles, choices);
        const agentPubkeys =
          root && sameSet(root.view.agentPubkeys, agentKeys)
            ? root.view.agentPubkeys
            : agentKeys;
        const raw = options.chat
          ? withoutStartingAgents(
              window.rows,
              options.viewer,
              agentPubkeys,
              !window.hasMore && !window.historyLimited,
            )
          : window.rows;
        const rawRows =
          root && sameArray(root.view.rawRows, raw) ? root.view.rawRows : raw;
        let rows = root?.view.rows;
        if (!rows || rawRows !== root.view.rawRows || !indexed) {
          const next = membershipRows(rawRows).map((row) => {
            const prior = root?.cells.get(row.id)?.row;
            return sameMembership(prior, row)
              ? (prior as TimelineRow)
              : row.membershipRows
                ? Object.freeze({
                    ...row,
                    membershipRows: Object.freeze([...row.membershipRows]),
                  })
                : row;
          });
          rows =
            root && sameArray(root.view.rows, next)
              ? root.view.rows
              : Object.freeze(next);
        }
        const nextIds = rows.map((row) => row.id);
        const ids =
          root && sameArray(root.view.ids, nextIds)
            ? root.view.ids
            : Object.freeze(nextIds);
        const groups = options.chat ? activityGroups(rows) : [];
        const activity =
          root &&
          groups.length === root.view.activity.length &&
          groups.every((group, i) =>
            sameArray(group.ids, root.view.activity[i]?.ids ?? emptyIds),
          )
            ? root.view.activity
            : groups;
        const dirty = new Set<string>();
        const nextReverse =
          canonicalChanged || rows !== root?.view.rows
            ? new Map<string, Set<string>>()
            : reverse;
        const rowDependencies = new Map<string, readonly string[]>();
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          if (!row) continue;
          const prior = root?.cells.get(row.id);
          const dep = prior?.row === row ? prior.profileIds : dependencies(row);
          rowDependencies.set(row.id, dep);
          if (nextReverse !== reverse)
            for (const id of dep) {
              const dependents = nextReverse.get(id) ?? new Set<string>();
              dependents.add(row.id);
              nextReverse.set(id, dependents);
            }
          if (
            !prior ||
            prior.row !== row ||
            prior.previousId !== rows[index - 1]?.id ||
            prior.nextId !== rows[index + 1]?.id ||
            prior.last !== (index === rows.length - 1)
          ) {
            dirty.add(row.id);
            if (rows[index - 1]) dirty.add(rows[index - 1]?.id ?? "");
            if (rows[index + 1]) dirty.add(rows[index + 1]?.id ?? "");
          }
          // Markdown may decode entities/escapes into references. The existing
          // parsed consumer owns text filtering; raw bytes cannot prove absence.
          if (permissionsChanged || referencesChanged) dirty.add(row.id);
        }
        const changedProfiles = new Set([
          ...previousProfiles.keys(),
          ...profiles.keys(),
        ]);
        for (const id of changedProfiles)
          if (previousProfiles.get(id) !== profiles.get(id)) {
            for (const row of reverse.get(id) ?? []) dirty.add(row);
            for (const row of nextReverse.get(id) ?? []) dirty.add(row);
          }
        if (choices !== previousChoices || library !== previousLibrary) {
          for (const [id, dependents] of nextReverse) {
            const oldAgent = root?.view.agentPubkeys.has(id) ?? false;
            const before = previousLibrary?.identities.find(
              (entry) => entry.pubkey === id,
            );
            const after = library.identities.find(
              (entry) => entry.pubkey === id,
            );
            if (oldAgent !== agentPubkeys.has(id) || before !== after)
              for (const row of dependents) dirty.add(row);
          }
        }
        const cells = new Map(root?.cells);
        const retained = new Set(ids);
        for (const id of cells.keys())
          if (!retained.has(id)) {
            cells.delete(id);
            dirty.add(id);
          }
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          if (!row || !dirty.has(row.id)) continue;
          const prior = root?.cells.get(row.id);
          const dep = rowDependencies.get(row.id) ?? emptyIds;
          const chosen = new Map<string, Profile>();
          for (const id of dep) {
            const profile = profiles.get(id);
            if (profile) chosen.set(id, profile);
          }
          const rowProfiles =
            prior && sameMap(prior.profiles, chosen) ? prior.profiles : chosen;
          const keys = new Set(dep.filter((id) => agentPubkeys.has(id)));
          const rowAgents =
            prior && sameSet(prior.agentPubkeys, keys)
              ? prior.agentPubkeys
              : keys;
          const referenceAgents = library.identities.filter((entry) =>
            dep.includes(entry.pubkey),
          );
          const chosenAgents =
            prior && sameArray(prior.directory.agents, referenceAgents)
              ? prior.directory.agents
              : referenceAgents;
          const directory =
            prior &&
            prior.directory.profiles === rowProfiles &&
            prior.directory.channels === channels &&
            prior.directory.named === named &&
            prior.directory.agents === chosenAgents
              ? prior.directory
              : Object.freeze({
                  profiles: rowProfiles,
                  channels,
                  named,
                  agents: chosenAgents,
                });
          const previous = rows[index - 1];
          const next = rows[index + 1];
          const nextCell: ChannelRowPresentation = Object.freeze({
            row,
            previousId: previous?.id,
            nextId: next?.id,
            stackPrevious: continuesMessageGroup(previous, row),
            stackNext: !!next && continuesMessageGroup(row, next),
            day:
              !previous ||
              new Date(previous.createdAt * 1000).toDateString() !==
                new Date(row.createdAt * 1000).toDateString(),
            last: index === rows.length - 1,
            profileIds:
              prior && sameArray(prior.profileIds, dep)
                ? prior.profileIds
                : Object.freeze([...dep]),
            profiles: rowProfiles,
            agentPubkeys: rowAgents,
            directory,
            permissions,
          });
          if (
            prior &&
            Object.keys(nextCell).every(
              (key) =>
                nextCell[key as keyof ChannelRowPresentation] ===
                prior[key as keyof ChannelRowPresentation],
            )
          )
            continue;
          cells.set(row.id, nextCell);
        }
        const wantedNames = new Set<string>([
          ...profileIds,
          ...(channel?.members ?? []),
          ...choices.identities.map((entry) => entry.pubkey),
          ...library.identities.map((entry) => entry.pubkey),
        ]);
        for (const ids of rowDependencies.values())
          for (const id of ids) wantedNames.add(id);
        for (const selection of selections)
          for (const id of selection.ids) wantedNames.add(id);
        const lookup = session.names?.scope(members);
        const names = new Map<string, string | undefined>();
        for (const id of wantedNames) names.set(id, lookup?.(id)?.name);
        const nameValues =
          root && sameMap(root.names, names) ? root.names : names;
        const { rows: _, ...metadata } = window;
        const header: ChannelPresentationHeader = Object.freeze({
          ...metadata,
          rowCount: window.rows.length,
          newestId: window.rows.at(-1)?.id,
        });
        const nextHeader =
          root &&
          Object.keys(header).length === Object.keys(root.header).length &&
          Object.keys(header).every(
            (key) =>
              header[key as keyof ChannelPresentationHeader] ===
              root.header[key as keyof ChannelPresentationHeader],
          )
            ? root.header
            : header;
        const view = Object.freeze({
          window,
          rawRows,
          rows,
          ids,
          profiles,
          agentPubkeys,
          activity,
        });
        const nextView =
          root &&
          Object.keys(view).every(
            (key) =>
              view[key as keyof ChannelPresentationView] ===
              root.view[key as keyof ChannelPresentationView],
          )
            ? root.view
            : view;
        const prior = root;
        // Every row and every dependent name selection is published before ANY callback.
        root = Object.freeze({
          header: nextHeader,
          view: nextView,
          cells,
          names: nameValues,
          members,
        });
        const nameCallbacks: {
          selection: NameSelection;
          listener: Listener;
        }[] = [];
        for (const selection of selections) {
          if (!prior || prior.names !== nameValues) {
            const next = namesFor(selection.ids, nameValues);
            if (!sameMap(selection.current, next)) {
              selection.current = next;
              nameCallbacks.push(
                ...[...selection.listeners].map((listener) => ({
                  selection,
                  listener,
                })),
              );
            }
          }
          selection.generation = root;
        }
        reverse = nextReverse;
        indexed = true;
        previousWindow = window;
        previousProfiles = profiles;
        previousChoices = choices;
        previousLibrary = library;
        if (prior) {
          if (prior.header !== nextHeader)
            for (const listener of [...headerListeners])
              if (headerListeners.has(listener)) listener();
          if (prior.view !== nextView)
            for (const listener of [...viewListeners])
              if (viewListeners.has(listener)) listener();
          for (const id of dirty)
            if (prior.cells.get(id) !== cells.get(id))
              for (const listener of [...(rowListeners.get(id) ?? [])])
                listener();
          for (const { selection, listener } of nameCallbacks)
            if (selection.listeners.has(listener)) listener();
        }
      } while (pending);
    } finally {
      refreshing = false;
    }
  }
  function acquire() {
    consumers++;
    if (consumers !== 1) return;
    const generation = ++epoch;
    const changed = () => {
      if (consumers && generation === epoch) reconcile();
    };
    stops = [
      session.channels.subscribeWindow(channelId, changed),
      session.channels.subscribeList(changed),
      session.profiles.subscribe(changed),
      session.agentChoices.subscribe(changed),
      session.agentLibrary.subscribe(changed),
    ];
    if (session.names) stops.push(session.names.subscribe(changed));
    reconcile();
  }
  function release() {
    if (--consumers) return;
    epoch++;
    for (const stop of stops) stop();
    stops = [];
    // Last immutable snapshots remain valid for a StrictMode subscription probe;
    // mutable dependency indexes/upstream closures retire and rebuild on reconnect.
    reverse.clear();
    reverse = new Map();
    indexed = false;
  }
  function subscribe(listeners: Set<Listener>, listener: Listener) {
    listeners.add(listener);
    acquire();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      release();
    };
  }
  function captureNames(ids: readonly string[], generation: typeof root) {
    if (ids.every((id) => generation.names.has(id)))
      return namesFor(ids, generation.names);
    // Dynamic verified owners can be outside static row dependencies. Capture
    // this whole private selection with the published membership scope, then
    // discard the live lookup. Construction registers/mutates no shared owner.
    const lookup = session.names?.scope(generation.members);
    return new Map(ids.map((id) => [id, lookup?.(id)?.name]));
  }
  reconcile();
  return {
    session,
    channelId,
    header: () => root.header,
    view: () => root.view,
    row: (id: string) => root.cells.get(id),
    subscribeHeader: (listener: Listener) =>
      subscribe(headerListeners, listener),
    subscribeView: (listener: Listener) => subscribe(viewListeners, listener),
    subscribeRow(id: string, listener: Listener) {
      const listeners = rowListeners.get(id) ?? new Set<Listener>();
      rowListeners.set(id, listeners);
      const stop = subscribe(listeners, listener);
      return () => {
        stop();
        if (!listeners.size) rowListeners.delete(id);
      };
    },
    names(ids: readonly string[]) {
      const selection: NameSelection = {
        ids,
        current: captureNames(ids, root),
        generation: root,
        listeners: new Set(),
      };
      const snapshot = () => {
        // An uncommitted selector can miss notifications. Refresh only its
        // private immutable memo for React's consistency recheck; never publish,
        // subscribe, reconcile or notify from a getter.
        const generation = root;
        if (selection.generation !== generation) {
          const next = captureNames(ids, generation);
          if (!sameMap(selection.current, next)) selection.current = next;
          selection.generation = generation;
        }
        return selection.current;
      };
      return {
        snapshot,
        subscribe(listener: Listener) {
          selection.listeners.add(listener);
          selections.add(selection);
          acquire();
          if (ids.some((id) => !root.names.has(id))) reconcile();
          else {
            const current = namesFor(ids, root.names);
            if (!sameMap(selection.current, current)) {
              selection.current = current;
              listener();
            }
          }
          selection.generation = root;
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            selection.listeners.delete(listener);
            if (!selection.listeners.size) selections.delete(selection);
            release();
          };
        },
      };
    },
  };
}
export type ChannelPresentation = ReturnType<typeof createChannelPresentation>;
