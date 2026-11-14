// Local-only diagnostic: ephemeral signed relay evidence, no account or live agent.
// Pollen, the viewer's own agent, is a Guest (Viewing only) in private #launch,
// so a send addressed to it offers "Ask in a Solo chat". The relay here answers
// a Solo create (kind 9007) with the chat its tags name, as a real relay does.
// Match the host entry: establish layer order before product component imports.
import "../../src/shared/styles/globals.css";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  signed,
  metadata,
  roster,
  message,
  bounds,
  summary,
  profile,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import { PublishRejected } from "../../src/features/relay/outbox";
import type { LiveCallbacks } from "../../src/features/relay/live";
import { matchesEvent } from "../../src/features/relay/projection";
import { threadBinding } from "../../src/features/relay/thread-window";
import { agentAvatars } from "../../src/features/agents/avatar-packs";
import { localAgentsFixture } from "../../src/features/agents/local-testing";
import { setDefaultAgent } from "../../src/features/solo/default-agent";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { PagesService } from "../../src/features/pages/service";
import { PanelsService } from "../../src/features/panels/service";
import { ConversationService } from "../../src/features/conversation/service";
import {
  provideNavigation,
  type PageNavigation,
} from "../../src/features/navigation/service";
import { ChannelsPage } from "../../src/bundled/channels/ChannelsPage";
import { PrimarySidebar } from "../../src/app/shell/PrimarySidebar";
import { ChannelNavigationProvider } from "../../src/features/channel-navigation/ChannelNavigationState";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { Button } from "../../src/shared/design-system/ui/Button";
import * as mentions from "../../src/bundled/mentions";
import { MESSAGE_TOKENS_TAG } from "../../src/features/messages/message-tokens";
import {
  composerSchema,
  projectComposerDocument,
} from "../../src/features/messages/composer-document";
import {
  composerTokenText,
  type ComposerToken,
} from "../../src/features/messages/composer-token";
import { writeView } from "../../src/shared/view-state";

const params = new URLSearchParams(location.search);
// `guest=outside`: Pollen isn't in #launch at all.
const outside = params.get("guest") === "outside";
// `guest=cold`: the app starts from #launch's saved membership, as on launch,
// and the relay answers for its roster only after "Confirm membership".
const cold = params.get("guest") === "cold";
// `guest=other`: Pollen is Viewing only in #launch, but someone else owns it.
const other = params.get("guest") === "other";
// `refuse`: the relay refuses role changes, as for a viewer no longer an admin.
const refuse = params.has("refuse");
// `refuse-create`: the relay refuses to make a Solo chat (kind 9007).
const refuseCreate = params.has("refuse-create");
// `chips`: #launch's saved draft holds a skill and a folder chip.
const chips = params.has("chips");
let confirmMembership = () => {};
const confirmed = cold
  ? new Promise<void>((resolve) => {
      confirmMembership = resolve;
    })
  : undefined;

const viewer = keypair(),
  authority = keypair(),
  agent = keypair();
const origin = "https://guest-agent-solo-ask.example";
const launch = crypto.randomUUID(),
  design = crypto.randomUUID();
const rootMessage = message(
  viewer,
  launch,
  "Should we launch on Thursday?",
  1_700_000_000,
);
const reply = message(
  viewer,
  launch,
  "Thursday works if the final review is complete. Morgan owns the checklist.",
  1_700_000_001,
  [["e", rootMessage.id, "", "reply"]],
);
const ownerSignature = bytesToHex(
  schnorr.sign(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`nostr:agent-auth:${agent.pubkey}:`),
      ),
    ),
    (other ? authority : viewer).secret,
  ),
);
const events: RelayEvent[] = [
  metadata(authority, launch, "launch", undefined, [
    ["private"],
    ["t", "stream"],
  ]),
  signed(authority, {
    kind: 39001,
    content: "",
    created_at: 1_700_000_000,
    tags: [
      ["d", launch],
      ["p", viewer.pubkey, "owner"],
    ],
  }),
  signed(authority, {
    kind: 39002,
    content: "",
    created_at: 1_700_000_000,
    tags: [
      ["d", launch],
      ["p", viewer.pubkey, "", "owner"],
      ...(outside ? [] : [["p", agent.pubkey, "", "guest"]]),
    ],
  }),
  metadata(authority, design, "design", undefined, [["t", "stream"]]),
  roster(authority, design, [viewer.pubkey]),
  rootMessage,
  reply,
  summary(authority, launch, rootMessage.id, {
    reply_count: 1,
    participants: [viewer.pubkey],
  }),
  profile(viewer, { name: "You" }),
  signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Pollen", bot: true }),
    created_at: 1_700_000_000,
    tags: [["auth", (other ? authority : viewer).pubkey, "", ownerSignature]],
  }),
];
const local = localAgentsFixture(
  other
    ? []
    : [
        {
          pubkey: agent.pubkey,
          name: "Pollen",
          relayUrl: origin,
          owner: viewer.pubkey,
          picture: agentAvatars[1]?.url ?? "",
        },
      ],
);
const launchSaved = events.filter(
  (event) =>
    event.kind >= 39000 &&
    event.kind <= 39002 &&
    event.tags.some(([tag, value]) => tag === "d" && value === launch),
);
/** Messages the relay took in Solo chats, with their signed chips. */
const soloMessages: { channel: string; content: string; tokens?: string }[] =
  [];
Object.assign(window, { soloMessages });
/** Solo chats the relay has created, for the walk to count. */
const soloCreates: {
  id: string;
  name: string;
  about: string;
  members: string[];
  labels: string[];
}[] = [];
Object.assign(window, { soloCreates });
let clock = 1_700_000_100;
/** The relay applies a kind 9000 to its signed roster. An agent with an
 * owner is stored as `bot`, the relay's ordinary role for agents. */
function grant(event: RelayEvent) {
  const [, id] = event.tags.find(([tag]) => tag === "h") ?? [];
  const [, key] = event.tags.find(([tag]) => tag === "p") ?? [];
  const [, role = "member"] = event.tags.find(([tag]) => tag === "role") ?? [];
  const at = events.findIndex(
    (item) =>
      item.kind === 39002 &&
      item.tags.some(([tag, value]) => tag === "d" && value === id),
  );
  const old = events[at];
  if (!old || !key) return;
  events[at] = signed(authority, {
    kind: 39002,
    content: "",
    created_at: clock++,
    tags: [
      ...old.tags.filter(([tag, value]) => !(tag === "p" && value === key)),
      ["p", key, "", role === "member" && key === agent.pubkey ? "bot" : role],
    ],
  });
}
/** The relay makes the chat a kind 9007 names: its creator owns it, and the
 * `p` members join in the create (agents as `bot`). */
function create(event: RelayEvent) {
  const id = event.tags.find(([tag]) => tag === "h")?.[1] ?? "";
  const name = event.tags.find(([tag]) => tag === "name")?.[1] ?? "";
  const members = event.tags.flatMap(([tag, value]) =>
    tag === "p" && value ? [value] : [],
  );
  const labels = event.tags.filter(([tag]) => tag === "t");
  const about = event.tags.find(([tag]) => tag === "about")?.[1] ?? "";
  soloCreates.push({
    id,
    name,
    about,
    members,
    labels: labels.map(([, label]) => label ?? ""),
  });
  events.push(
    metadata(authority, id, name, clock++, [
      ["private"],
      ["t", "stream"],
      ...labels,
      ["P", event.pubkey],
      ...(about ? [["about", about]] : []),
    ]),
    signed(authority, {
      kind: 39002,
      content: "",
      created_at: clock++,
      tags: [
        ["d", id],
        ["p", event.pubkey, "", "owner"],
        ...members.map((key) => ["p", key, "", "bot"]),
      ],
    }),
  );
}
let live: LiveCallbacks | undefined;
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: authority.pubkey,
    scope: origin,
    channelIdentity: true,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
    query: async (filters) => {
      if (
        confirmed &&
        launchSaved.some((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        )
      )
        await confirmed;
      const found = events.filter((event) =>
        filters.some(
          (filter) =>
            matchesEvent(event, filter) ||
            // The chooser's directory search: name prefix, like the relay.
            (filter.search !== undefined &&
              event.kind === 0 &&
              matchesEvent(event, {
                ...filter,
                search: undefined,
                search_mode: undefined,
              }) &&
              String(JSON.parse(event.content).name ?? "")
                .toLowerCase()
                .startsWith(filter.search.toLowerCase())) ||
            (filter.include_summaries &&
              event.kind === 39005 &&
              event.tags.some(
                ([key, value]) =>
                  key === "h" && filter["#h"]?.includes(value ?? ""),
              )),
        ),
      );
      for (const filter of filters) {
        if (filter.thread_window) {
          found.push(
            signed(authority, {
              kind: 39007,
              content: JSON.stringify({
                version: 1,
                direction: "older",
                has_more: false,
                next_cursor: null,
              }),
              tags: [
                ["h", filter["#h"]?.[0] ?? ""],
                ["e", filter["#e"]?.[0] ?? ""],
                ["d", await threadBinding(filter, origin, viewer.pubkey)],
              ],
            }),
          );
        } else
          for (const id of filter["#h"] ?? [])
            if (filter.kinds?.includes(9))
              found.push(
                bounds(authority, id, "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              );
      }
      return found;
    },
    // The members panel's role change, used by "Make member and send".
    memberAdministration: {
      sign: async (event) => signed(viewer, event),
      publish: async (event) => {
        if (refuse)
          throw new PublishRejected(
            "Only channel owners and admins can change roles.",
          );
        grant(event);
      },
    },
    writer: {
      // "Add to channel and send" publishes a kind 9000 here.
      kinds: [9, 9007, 9000],
      sign: async (event) => signed(viewer, event),
      publish: async (event) => {
        if (event.kind === 9000) {
          grant(event);
          return;
        }
        if (event.kind === 9007) {
          if (refuseCreate)
            throw new PublishRejected("Solo chats are off in this community.");
          create(event);
        }
        const channel = event.tags.find(([tag]) => tag === "h")?.[1];
        if (event.kind === 9 && soloCreates.some((chat) => chat.id === channel))
          soloMessages.push({
            channel: channel ?? "",
            content: event.content,
            ...Object.fromEntries(
              event.tags
                .filter(([tag]) => tag === MESSAGE_TOKENS_TAG)
                .map(([, value]) => ["tokens", value]),
            ),
          });
        events.push(event);
      },
    },
  },
  {
    agentChoices: local,
    outboxStorage: { load: () => [], save() {} },
    ...(cold
      ? {
          prepared: true,
          persistence: {
            readStartup: async () => ({
              discovery: {
                savedAt: Date.now(),
                relayAuthor: authority.pubkey,
                events: launchSaved,
              },
            }),
            read: async () => [],
            write: async () => {},
            remove: async () => {},
            retain: async () => {},
            clear: async () => {},
            close() {},
          },
        }
      : {}),
  },
);
if (cold) await owner.restore();
if (chips) {
  const chip = (semantic: ComposerToken) =>
    composerSchema.nodes.token.create({
      source: composerTokenText(semantic),
      semantic,
    });
  writeView(
    owner.session.scope,
    `draft:${launch}`,
    projectComposerDocument(
      composerSchema.nodes.doc.create(
        null,
        composerSchema.nodes.paragraph.create(null, [
          composerSchema.text("Use "),
          chip({
            kind: "skill",
            id: "/work/skills/review/SKILL.md",
            label: "review",
            target: agent.pubkey,
          }),
          composerSchema.text(" in "),
          chip({ kind: "folder", id: "/work/launch", label: "launch" }),
        ]),
      ),
    ).draft,
  );
}
live?.state({ status: "connected", routes: [] });
// Someone else's agent is never the viewer's Bestie.
if (!other) setDefaultAgent(owner.session.scope, agent.pubkey);
const snapshot = {
  status: "ready" as const,
  generation: 1,
  session: owner.session,
  scope: owner.session.scope,
  viewer: viewer.pubkey,
};
const relay = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: async () => {},
};
const ctx = new Context();
ctx.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const panels = new PanelsService(ctx),
  pages = new PagesService(ctx),
  conversation = new ConversationService(ctx);
const navigation = provideNavigation(ctx);
ctx.provide("relay", relay);
// The real mention chooser (a host-owned feature).
await ctx
  .extend({ pluginOwner: { id: "buzz.mentions", revision: "fixture" } })
  .plugin(mentions)
  .await();
function Fixture() {
  useKeyboardFocusVisibility();
  const state = useSyncExternalStore(
    navigation.navigation.subscribe,
    navigation.navigation.snapshot,
  );
  const [request, setRequest] = useState<PageNavigation>();
  useLayoutEffect(() => {
    const next = navigation.request(state.attempt, {
      valid: () => true,
      subscribe: () => () => {},
    });
    setRequest(next.request);
    return next.dispose;
  }, [state.attempt]);
  const open = (channelId: string) =>
    void navigation.navigation.open({
      version: 1,
      kind: "conversation",
      scope: { communityOrigin: origin, viewer: viewer.pubkey },
      channelId,
    });
  return (
    <ToastProvider>
      <ChannelNavigationProvider relay={relay}>
        <div style={{ display: "flex", height: "100vh", minWidth: 0 }}>
          <PrimarySidebar
            relay={relay}
            navigator={navigation.navigation}
            target={state.attempt.entry.target}
          >
            {null}
          </PrimarySidebar>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-standard p-2">
              <span className="text-caption text-secondary">
                Local fixture · synthetic conversation
              </span>
              <Button size="xs" onClick={() => open(launch)}>
                Launch channel
              </Button>
              <Button size="xs" onClick={() => open(design)}>
                Design channel
              </Button>
              {cold && (
                <Button size="xs" onClick={confirmMembership}>
                  Confirm membership
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1">
              <ChannelsPage
                relay={relay}
                panels={panels}
                pages={pages}
                navigator={navigation.navigation}
                navigation={request}
                extensions={conversation}
              />
            </div>
          </div>
        </div>
      </ChannelNavigationProvider>
    </ToastProvider>
  );
}
const element = document.getElementById("root");
if (element) createRoot(element).render(<Fixture />);
