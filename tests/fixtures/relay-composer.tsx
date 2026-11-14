// Local-only browser fixture. Every event is signed with ephemeral test keys; no network relay.
import { DraftsSentPage } from "../../src/features/drafts-sent/DraftsSentPage";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { Context } from "@deepseek-ai/cordis";
import { ChannelWorkspaceFixture } from "./channel-workspace";
import { provideNavigation } from "../../src/features/navigation/service";
import { PanelsService } from "../../src/features/panels/service";
import { PagesService } from "../../src/features/pages/service";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  signed,
  bounds,
  metadata,
  roster,
  profile,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import type { OutgoingEvent } from "../../src/features/relay/outbox";
import {
  browserOutboxStorage,
  PublishRejected,
} from "../../src/features/relay/outbox";
import "../../src/shared/styles/globals.css";
const viewer = keypair(),
  relay = keypair();
const confirmed: RelayEvent[] = [];
const rejected = new Set<string>();
let saved: readonly OutgoingEvent[] = [];
const attachmentSources = new Map<string, string>();
const uploadProgress = new Map<string, (sent: number, total: number) => void>();
const attachmentOrigin = "https://attachments.invalid";
const params = new URLSearchParams(location.search);
const general = params.has("scheduledPage")
  ? "11111111-1111-4111-8111-111111111111"
  : "general";
const root = new Context();
root.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: attachmentOrigin,
    ...(params.has("scheduled")
      ? {
          scheduledMessages: {
            sign: async (template: Parameters<typeof signed>[1]) =>
              signed(viewer, template),
            request: async (body: unknown, signal: AbortSignal) =>
              fetch("/fixture/scheduled", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal,
              }),
          },
        }
      : {}),

    media: (url) => attachmentSources.get(url),
    ...(params.has("attachments")
      ? {
          async uploadAttachment(
            file: File,
            signal: AbortSignal,
            progress?: (sent: number, total: number) => void,
          ) {
            if (progress)
              uploadProgress.set(file.name, (sent, total) => {
                if (!signal.aborted) progress(sent, total);
              });
            if (params.has("uploadRequests")) {
              const response = await fetch("/api/relay/upload", {
                method: "POST",
                credentials: "same-origin",
                headers: {
                  "Content-Type": file.type || "application/octet-stream",
                },
                body: file,
                signal,
              });
              await response.body?.cancel();
              signal.throwIfAborted();
              if (!response.ok)
                throw new Error("Upload failed. Retry or remove this file.");
            }
            const digest = await crypto.subtle.digest(
              "SHA-256",
              await file.arrayBuffer(),
            );
            signal.throwIfAborted();
            const sha256 = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            const url = `${attachmentOrigin}/media/${sha256}`;
            attachmentSources.set(
              url,
              /^(image|video)\//.test(file.type)
                ? URL.createObjectURL(file)
                : `/api/relay/media?url=${encodeURIComponent(url)}`,
            );
            return {
              name: file.name,
              url,
              size: file.size,
              type: file.type || "application/octet-stream",
              sha256,
            };
          },
        }
      : {}),
    async query(filters) {
      const filter = filters[0];
      if (!filter) throw new Error("Missing fixture query filter");
      if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
        return [
          roster(relay, general, [viewer.pubkey]),
          metadata(relay, general, "General"),
          ...(params.has("random")
            ? [
                roster(relay, "random", [viewer.pubkey]),
                metadata(relay, "random", "Random"),
              ]
            : []),
        ];
      if (filter.kinds?.includes(0)) return [profile(viewer, { name: "You" })];
      if (filter.ids)
        return confirmed.filter((event) => filter.ids?.includes(event.id));
      const channel = filter["#h"]?.[0] ?? general;
      return [
        ...confirmed.filter((event) =>
          event.tags.some((tag) => tag[0] === "h" && tag[1] === channel),
        ),
        bounds(relay, channel, "head", {
          has_more: false,
          next_cursor: null,
        }),
      ];
    },
    writer: {
      kinds: [9, 40003],
      async sign(event) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return signed(viewer, event);
      },
      async publish(event) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (event.content.includes("reject") && !rejected.has(event.id)) {
          rejected.add(event.id);
          throw new PublishRejected("Fixture relay rejected this message once");
        }
        if (!confirmed.some((old) => old.id === event.id))
          confirmed.push(event);
      },
    },
  },
  {
    outboxStorage: params.has("durable")
      ? browserOutboxStorage(`fixture:${crypto.randomUUID()}`)
      : {
          load: () => saved,
          save: (next) => {
            saved = next;
          },
        },
  },
);
// Observable delivery barrier for keyboard workflows; the fixture never uses real keys.
Object.assign(window, {
  composerFixture: {
    async seedScheduled() {
      for (const [offset, content] of [
        [1, "Review tomorrow’s launch notes"],
        [2, "Share the weekly update"],
      ] as const)
        await owner.session.scheduledMessages?.create({
          destination: { channelId: general, name: "General" },
          content,
          sendAt: Date.now() + offset * 86400000,
        });
    },
    reportUploadProgress: (name: string, sent: number, total: number) =>
      uploadProgress.get(name)?.(sent, total),
    pending: () =>
      owner.session.outbox?.snapshot().map((item) => ({
        kind: item.event.kind,
        content: item.event.content,
        delivery: item.delivery,
      })),
    published: () =>
      confirmed.map((event) => ({
        content: event.content,
        channel: event.tags.find((tag) => tag[0] === "h")?.[1],
      })),
  },
});
const navigationHost = provideNavigation(root);
const snapshot = Object.freeze({
  scope: `${attachmentOrigin}:${viewer.pubkey}`,
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
function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <ToastProvider>
      <div style={{ height: "100vh" }}>
        {params.has("scheduledPage") ? (
          <DraftsSentPage
            relay={data}
            navigator={navigationHost.navigation}
            panels={new PanelsService(root)}
          />
        ) : (
          <ChannelWorkspaceFixture
            host={navigationHost}
            relay={data}
            panels={new PanelsService(root)}
            pages={new PagesService(root)}
          />
        )}
      </div>
    </ToastProvider>
  );
}
createRoot(container).render(<Fixture />);
