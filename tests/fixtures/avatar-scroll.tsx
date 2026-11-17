import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Actual timeline and profile directory; relay avatars use the native
// `buzz-media` URL shape, which the spec serves. No live relay.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import { keypair, message, profile } from "../../src/features/relay/testing";
import { mediaUrl } from "../../src/features/relay/transport";
import "../../src/shared/styles/globals.css";
const relayOrigin = "https://relay.test";
const viewer = keypair(),
  relay = keypair();
// Authors take turns, so every message shows its author's avatar, and an
// author's rows are far enough apart that no element of their avatar stays
// mounted between them.
const authors = Array.from({ length: 40 }, () => keypair());
const events = Array.from({ length: 120 }, (_, i) =>
  message(
    authors[i % authors.length] ?? viewer,
    "avatars",
    `Message ${i}. ${"Reading continues between avatars. ".repeat(6)}`,
    1700000000 + i,
  ),
);
const profiles = authors.map((author, i) =>
  profile(author, {
    name: `Author ${i}`,
    picture: `${relayOrigin}/media/${i.toString(16).padStart(64, "0")}.png`,
  }),
);
const rows = foldMessages("avatars", relay.pubkey, events);
// `?direct` shows the pictures as third-party https artwork instead.
const direct = new URLSearchParams(location.search).has("direct");
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url, size) =>
    direct
      ? url
      : mediaUrl(
          url,
          (target) =>
            `http://buzz-media.localhost/${encodeURIComponent(target)}`,
          relayOrigin,
          size,
        ),
  query: async (filters) =>
    profiles.filter((event) =>
      filters.some((filter) => filter.authors?.includes(event.pubkey)),
    ),
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
});
void owner.session.profiles.ensure(authors.map((author) => author.pubkey));
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <div
        style={{
          height: 700,
          maxWidth: 1100,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ChannelTimeline
          scope="avatar-scroll"
          channelId="avatars"
          queries={owner.session}
          window={{
            channelId: "avatars",
            rows,
            status: "ready",
            hasMore: false,
            loadingOlder: false,
            error: undefined,
            freshness: "fresh",
          }}
          onOpenLink={() => false}
        />
      </div>
    </ToastProvider>
  </StrictMode>,
);
