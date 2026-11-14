// Thread grid plus media viewer over an 8-photo post, for gallery navigation
// under latency (tests/browser/gallery-latency.spec.mjs serves and holds the
// media). `?blurhash=0` drops the BlurHashes, matching what this app sends.
import { Context } from "@deepseek-ai/cordis";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import type { Attachment } from "../../src/features/relay/contracts";
import { MediaReviewViewer } from "../../src/features/messages/MediaReviewViewer";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import { ConversationService } from "../../src/features/conversation/service";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
  profile,
} from "../../src/features/relay/testing";
import photos from "./gallery-latency/photos.json";
import "../../src/shared/styles/globals.css";

const ctx = new Context();
ctx.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const extensions = new ConversationService(ctx);
const viewer = keypair(),
  relay = keypair();
const blurhash = new URLSearchParams(location.search).get("blurhash") !== "0";
// The recorder maps each photo back from the digit repeated in its hash.
const imageUrl = (n: number) =>
  `https://relay.test/media/${`${n}`.repeat(64)}.jpg`;
const rootMessage = message(
  viewer,
  "photos",
  "Trip photos",
  1,
  photos.map((photo, index) => [
    "imeta",
    `url ${imageUrl(index + 1)}`,
    "m image/jpeg",
    `dim ${photo.dim}`,
    ...(blurhash ? [`blurhash ${photo.blurhash}`] : []),
    `filename photo-${index + 1}.jpg`,
  ]),
);
const events = [rootMessage, profile(viewer, { name: "You" })];
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: (url: string, size?: "small") =>
      url.startsWith("https://relay.test/media/")
        ? `/api/relay/media?url=${encodeURIComponent(
            size === "small" ? url.replace(/\.jpg$/, ".thumb.jpg") : url,
          )}`
        : undefined,
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return { update() {}, retry() {}, dispose() {} };
    },
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
          return [
            roster(relay, "photos", [viewer.pubkey]),
            metadata(relay, "photos", "Photos"),
          ];
        if (filter.ids)
          return events.filter((event) => filter.ids?.includes(event.id));
        if (filter.kinds?.includes(0))
          return events.filter((event) => event.kind === 0);
        return [];
      });
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
await owner.session.read([
  { kinds: [39002, 39000], "#d": ["photos"], limit: 10 },
]);

function Fixture() {
  useKeyboardFocusVisibility();
  const [review, setReview] = useState<{
    attachment: Attachment;
    attachments?: readonly Attachment[];
  }>();
  const trigger = useRef<HTMLElement | null>(null);
  return (
    <main style={{ height: "100vh", maxWidth: 720, margin: "0 auto" }}>
      <ThreadPanel
        session={owner.session}
        extensions={extensions}
        scope="photos"
        channelId="photos"
        channelName="Photos"
        messageId={rootMessage.id}
        close={() => {}}
        onOpenLink={() => false}
        onOpenMediaReview={(_id, attachment, _time, _comments, attachments) => {
          trigger.current = document.activeElement as HTMLElement;
          setReview({ attachment, attachments });
        }}
      />
      {review && (
        <MediaReviewViewer
          attachment={review.attachment}
          initialAttachments={review.attachments}
          session={owner.session}
          extensions={extensions}
          scope="photos"
          channelId="photos"
          channelName="Photos"
          messageId={rootMessage.id}
          initialTime={0}
          restoreFocus={trigger}
          onOpenLink={() => false}
          close={() => setReview(undefined)}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
// As main.tsx does: development replays mount effects and ref callbacks.
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
