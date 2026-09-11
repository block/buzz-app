// A second source consumer: ordinary prop changes, no caller remount keys.
// Real React/session/outbox; local ephemeral signed events, never a live broker.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import { bundledPlugins } from "../../src/bundled";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { MediaReviewViewer } from "../../src/features/messages/MediaReviewViewer";
import { createRelaySession } from "../../src/features/relay/session";
import { PublishRejected } from "../../src/features/relay/outbox";
import { threadReference } from "../../src/features/relay/threads";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import type { Attachment } from "../../src/features/relay/contracts";
import "../../src/shared/styles/globals.css";

const context = new Context();
createPluginManager(context, {
  bundled: bundledPlugins.filter(({ manifest }) =>
    ["buzz.emoji", "buzz.mentions"].includes(manifest.id),
  ),
});
const extensions = new ConversationService(context);
const viewer = keypair(),
  relay = keypair();
const media = [
  { url: "https://fixture.test/media/one.png", video: false },
  { url: "https://fixture.test/media/two.png", video: false },
] as const satisfies readonly Attachment[];
const roots = [
  signed(viewer, {
    kind: 9,
    content: "First root",
    created_at: 1,
    tags: [
      ["h", "one"],
      ...media.map((item) => ["imeta", `url ${item.url}`, "m image/png"]),
    ],
  }),
  message(viewer, "one", "Second root", 2),
  message(viewer, "two", "Other channel root", 3),
] as const;
function channelOf(event: RelayEvent) {
  const id = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!id) throw new Error("Missing fixture channel");
  return id;
}
const replies = roots.flatMap((root) =>
  Array.from({ length: 60 }, (_, i) =>
    i === 0 && root === roots[0]
      ? signed(viewer, {
          kind: 9,
          content: "Reply with image",
          created_at: 10,
          tags: [
            ["h", "one"],
            ["e", root.id, "", "reply"],
            [
              "imeta",
              "url https://fixture.test/media/reply.png",
              "m image/png",
            ],
          ],
        })
      : message(viewer, channelOf(root), `${root.content} reply ${i}`, 10 + i, [
          ["e", root.id, "", "reply"],
        ]),
  ),
);
const events = [...roots, ...replies];
const report = {
  pages: [] as string[],
  signings: [] as string[],
  publications: [] as RelayEvent[],
};
let incoming = (_events: readonly RelayEvent[]) => {};
const rejected = new Set<string>();
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => {
    return media.some((item) => item.url === url) || url.endsWith("reply.png")
      ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Crect width='640' height='360' fill='%23666'/%3E%3C/svg%3E"
      : undefined;
  },
  subscribe(callbacks) {
    incoming = callbacks.receive;
    return { update() {}, retry() {}, dispose() {} };
  },
  async query(filters) {
    return filters.flatMap((filter) => {
      if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
        return [
          roster(relay, "one", [viewer.pubkey]),
          metadata(relay, "one", "One"),
          roster(relay, "two", [viewer.pubkey]),
          metadata(relay, "two", "Two"),
        ];
      if (filter.kinds?.includes(0))
        return [profile(viewer, { name: "Fixture Reader" })];
      if (filter.ids)
        return events.filter((event) => filter.ids?.includes(event.id));
      if (filter.depth_limit) {
        const rootId = filter["#e"]?.[0];
        if (!rootId) throw new Error("Missing fixture thread root");
        report.pages.push(rootId);
        return events
          .filter((event) => {
            if (threadReference(event)?.rootId !== rootId) return false;
            return (
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor ||
              (event.created_at === filter.thread_cursor &&
                event.id > (filter.thread_cursor_id ?? ""))
            );
          })
          .sort(
            (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      }
      return [];
    });
  },
  writer: {
    kinds: [9],
    async sign(template) {
      const event = signed(viewer, template);
      report.signings.push(event.id);
      return event;
    },
    async publish(event) {
      report.publications.push(event);
      if (event.content.includes("reject") && !rejected.has(event.id)) {
        rejected.add(event.id);
        throw new PublishRejected("Fixture rejection");
      }
      if (!events.some((old) => old.id === event.id)) events.push(event);
      incoming([event]);
    },
  },
});
owner.session.channels.ensureList();
Object.assign(window, {
  messagesFixture: {
    report,
    live() {
      const event = message(viewer, "one", "Live reply", 1000, [
        ["e", roots[0].id, "", "reply"],
      ]);
      events.push(event);
      incoming([event]);
    },
  },
});
function Fixture() {
  const [selected, select] = useState(0),
    [scope, setScope] = useState("fixture"),
    [review, setReview] = useState(false);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const root = roots[selected];
  if (!root) throw new Error("Missing fixture selection");
  const channelId = channelOf(root);
  return (
    <>
      <nav>
        {roots.map((root, i) => (
          <button key={root.id} type="button" onClick={() => select(i)}>
            {root.content}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setScope(scope === "fixture" ? "other" : "fixture")}
        >
          Switch scope
        </button>
        <button
          ref={reviewTrigger}
          type="button"
          onClick={() => setReview(true)}
        >
          Review image
        </button>
      </nav>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 440px",
          height: "80vh",
        }}
      >
        <MessageComposer
          extensions={extensions}
          session={owner.session}
          scope={scope}
          channelId={channelId}
          channelName={channelId}
        />
        {!review && (
          <ThreadPanel
            extensions={extensions}
            session={owner.session}
            scope={scope}
            channelId={channelId}
            channelName={channelId}
            messageId={root.id}
            close={() => select(0)}
            onOpenLink={() => false}
          />
        )}
      </div>
      {review && (
        <MediaReviewViewer
          attachment={media[0]}
          extensions={extensions}
          session={owner.session}
          scope={scope}
          channelId="one"
          channelName="one"
          messageId={roots[0].id}
          initialTime={0}
          restoreFocus={reviewTrigger}
          close={() => setReview(false)}
        />
      )}
    </>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture container");
createRoot(container).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
