// Local-only browser fixture. Every event is signed with ephemeral test keys; no network relay.
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { ChannelWorkspaceFixture } from "./channel-workspace";
import { provideNavigation } from "../../src/features/navigation/service";
import { PanelsService } from "../../src/features/panels/service";
import { PagesService } from "../../src/features/pages/service";
import { createRelaySession } from "../../src/features/relay/session";
import { matchesEvent } from "../../src/features/relay/projection";
import {
  keypair,
  message,
  metadata,
  roster,
  profile,
  bounds,
  summary,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import type { LiveCallbacks } from "../../src/features/relay/live";
import "../../src/shared/styles/globals.css";

const viewer = keypair(),
  relay = keypair(),
  member = keypair(),
  agent = keypair();
const scope = `https://bubbles.invalid:${viewer.pubkey}`;
const rosters = {
  team: [viewer.pubkey, member.pubkey, agent.pubkey],
  solo: [viewer.pubkey, agent.pubkey],
};
const history: Record<string, RelayEvent[]> = {
  team: [
    message(member, "team", "Anyone looked at the release notes?", 10),
    message(
      member,
      "team",
      "They cover the changelog wording, the migration note for older desktop builds, whether the plugin catalog screenshot needs a refresh, and the follow-up on the onboarding copy that came out of last week's review.",
      11,
    ),
    message(agent, "team", "I can summarize the open review threads.", 20),
    message(viewer, "team", "Please do. Start with `release-notes.md`.", 30),
    message(
      agent,
      "team",
      `\`\`\`\n${"const titles = threads.map((thread) => thread.title); ".repeat(5)}\n\`\`\``,
      40,
    ),
    message(
      member,
      "team",
      `| ${"Thread | Owner | Status | ".repeat(6)}\n| ${"--- | ".repeat(18)}\n| ${"Changelog wording | Member | Open | ".repeat(6)}`,
      50,
    ),
  ],
  solo: [
    message(viewer, "solo", "Draft a reply to the vendor.", 10),
    message(agent, "solo", "Here is a first draft.", 20),
  ],
};
// A thread of the viewer and the agent inside the mixed Team channel.
const threadRoot = message(viewer, "team", "Can you draft the changelog?", 60);
const threadReply = (key: typeof viewer, content: string, at: number) =>
  message(key, "team", content, at, [["e", threadRoot.id, "", "reply"]]);
history.team?.push(
  threadRoot,
  threadReply(agent, "Here is a first pass at the changelog.", 61),
);
let live: LiveCallbacks | undefined;
let clock = 100;
Object.assign(window, {
  bubblesFixture: {
    reply(author: "agent" | "member", content: string) {
      const event = threadReply(
        author === "agent" ? agent : member,
        content,
        ++clock,
      );
      history.team?.push(event);
      live?.receive([event]);
    },
  },
});
const directory = [
  ...Object.entries(rosters).flatMap(([id, members]) => [
    roster(relay, id, members),
    metadata(relay, id, id === "team" ? "Team" : "Bot chat"),
  ]),
  profile(viewer, { name: "Reader" }),
  profile(member, { name: "Member" }),
  profile(agent, { name: "Bot", is_agent: true }),
];
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
    async query(filters) {
      return filters.flatMap((filter) => {
        const all = Object.values(history).flat();
        if (filter.depth_limit) {
          const after = filter.thread_cursor;
          return all.filter(
            (event) =>
              event.tags.some(
                ([name, value]) =>
                  name === "e" && filter["#e"]?.includes(value ?? ""),
              ) &&
              (after === undefined ||
                event.created_at > after ||
                (event.created_at === after &&
                  event.id > (filter.thread_cursor_id ?? ""))),
          );
        }
        if (filter.ids)
          return all.filter((event) => filter.ids?.includes(event.id));
        const channel = filter["#h"]?.find((id) => id in history);
        if (channel)
          return [
            ...(history[channel] ?? []),
            ...(channel === "team"
              ? [
                  summary(relay, "team", threadRoot.id, {
                    reply_count: 1,
                    participants: [agent.pubkey],
                  }),
                ]
              : []),
            bounds(relay, channel, "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return directory.filter((event) => matchesEvent(event, filter));
      });
    },
  },
  { outboxStorage: { load: () => [], save() {} } },
);
owner.session.channels.ensureList();
const root = new Context();
root.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const navigationHost = provideNavigation(root);
const snapshot = Object.freeze({
  scope,
  status: "ready" as const,
  generation: 0,
  session: owner.session,
  viewer: viewer.pubkey,
});
const data = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: owner.clearCache,
};
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(
  <ToastProvider>
    <div style={{ height: "100vh" }}>
      <ChannelWorkspaceFixture
        host={navigationHost}
        relay={data}
        panels={new PanelsService(root)}
        pages={new PagesService(root)}
      />
    </div>
  </ToastProvider>,
);
