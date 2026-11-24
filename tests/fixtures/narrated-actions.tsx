// Review preview: production conversation components and outbox, local sample events.
import { Context } from "@deepseek-ai/cordis";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { conversationFeatures } from "../../src/app/conversation-features";
import { ConversationService } from "../../src/features/conversation/service";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import type { RelayEvent } from "../../src/features/relay/events";
import { matchesEvent } from "../../src/features/relay/projection";
import { createRelaySession } from "../../src/features/relay/session";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import { createPluginManager } from "../../src/plugins/manager";
import { Button } from "../../src/shared/design-system/ui/Button";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "./narrated-actions.css";

const context = new Context();
const plugins = createPluginManager(context, {
  bundled: [],
  builtIn: conversationFeatures,
});
const extensions = new ConversationService(context);
const viewer = keypair(),
  boss = keypair(),
  relay = keypair();
const viewerName =
  new URLSearchParams(location.search).get("name")?.trim() || "Alex Morgan";
const channelId = "narrated-actions";
const now = Math.floor(Date.now() / 1000);
const action = message(
  viewer,
  channelId,
  "/me hands over a resignation letter",
  Math.floor((now - 120) / 60) * 60,
);
const events = [
  metadata(relay, channelId, "watercooler"),
  roster(relay, channelId, [viewer.pubkey, boss.pubkey]),
  profile(viewer, { name: viewerName }),
  profile(boss, { name: "Dana Brooks" }),
  message(boss, channelId, "TPS report. New cover sheet. Please.", now - 180),
  action,
  message(
    viewer,
    channelId,
    "/me reaches for the stapler",
    action.created_at + 1,
  ),
  message(boss, channelId, "Needs a cover sheet.", now - 60),
  message(boss, channelId, "/me schedules a follow-up", now - 15, [
    ["e", action.id, "", "reply"],
  ]),
];
const report = { publications: [] as RelayEvent[] };
let receive = (_events: readonly RelayEvent[]) => {};
const owner = createRelaySession(
  {
    scope: "https://preview.example",
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    subscribe(callbacks) {
      receive = callbacks.receive;
      return { update() {}, retry() {}, dispose() {} };
    },
    async query(filters) {
      return filters.flatMap((filter) => {
        const rows = events.filter((event) => matchesEvent(event, filter));
        if (filter.depth_limit) {
          return rows
            .filter(
              (event) =>
                filter.thread_cursor === undefined ||
                event.created_at > filter.thread_cursor ||
                (event.created_at === filter.thread_cursor &&
                  event.id > (filter.thread_cursor_id ?? "")),
            )
            .sort(
              (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
            )
            .slice(0, filter.limit);
        }
        return filter.top_level
          ? [
              ...rows,
              bounds(relay, channelId, "head", {
                has_more: false,
                next_cursor: null,
              }),
            ]
          : rows;
      });
    },
    writer: {
      kinds: [5, 7, 9],
      async sign(template) {
        return signed(viewer, template);
      },
      async publish(event) {
        report.publications.push(event);
        events.push(event);
        receive([event]);
      },
    },
  },
  { outboxStorage: { load: () => [], save() {} } },
);
Object.assign(window, { messagesFixture: { report } });
owner.session.channels.ensureList();
window.addEventListener("pagehide", () => {
  owner.dispose();
  void plugins.dispose();
  void context.fiber.dispose();
});

function Preview() {
  useKeyboardFocusVisibility();
  const [thread, setThread] = useState<string>();
  const list = useSyncExternalStore(
    owner.session.channels.subscribeList,
    owner.session.channels.list,
  );
  useEffect(() => {
    if (list.status === "ready") owner.session.channels.ensure(channelId);
  }, [list]);
  const channel = useSyncExternalStore(
    (callback) => owner.session.channels.subscribeWindow(channelId, callback),
    () => owner.session.channels.window(channelId),
  );
  return (
    <main className="action-preview">
      <header className="action-preview-heading">
        <div>
          <h1 className="text-title">Act it out.</h1>
          <p>
            Try <code>/me passes out</code>. Your name takes the place of{" "}
            <code>/me</code>.
          </p>
        </div>
        <Button onClick={() => location.reload()}>Reset conversation</Button>
      </header>
      <p className="action-preview-note">
        A local demo. Messages stay in this preview.
      </p>
      <div
        className="action-preview-panes"
        data-thread={thread ? "open" : undefined}
      >
        <section
          className="action-preview-conversation"
          aria-label="Preview conversation"
        >
          <header>
            <h2 className="text-heading">#watercooler</h2>
          </header>
          <div className="action-preview-history">
            {channel && (
              <ChannelTimeline
                extensions={extensions}
                channelId={channelId}
                scope={owner.session.scope}
                viewer={viewer.pubkey}
                queries={owner.session}
                window={channel}
                marksRead={false}
                onOpenLink={() => false}
                onOpenThread={(id) => setThread(id)}
                openThreadRootId={thread}
              />
            )}
          </div>
          <MessageComposer
            extensions={extensions}
            session={owner.session}
            scope={owner.session.scope}
            channelId={channelId}
            channelName="watercooler"
          />
        </section>
        {thread && (
          <ThreadPanel
            extensions={extensions}
            session={owner.session}
            scope={owner.session.scope}
            channelId={channelId}
            channelName="watercooler"
            messageId={thread}
            close={() => setThread(undefined)}
            onOpenLink={() => false}
          />
        )}
      </div>
    </main>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing preview container");
createRoot(container).render(
  <ToastProvider>
    <Preview />
  </ToastProvider>,
);
