import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Actual timeline, membership rows and profile directory; no live relay.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import {
  keypair,
  message,
  profile,
  signed,
} from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";
const viewer = keypair(),
  relay = keypair();
// Each added person is seen once, as in a channel that grew by many additions.
const people = Array.from({ length: 16 }, () => keypair());
const events = people.flatMap((person, i) => [
  ...[0, 1, 2].map((n) =>
    message(
      viewer,
      "members",
      `Message ${i * 3 + n}. ${"Reading continues between additions. ".repeat(6)}`,
      1700000000 + i * 4 + n,
    ),
  ),
  signed(relay, {
    kind: 40099,
    content: JSON.stringify({
      type: "member_joined",
      actor: viewer.pubkey,
      target: person.pubkey,
    }),
    created_at: 1700000000 + i * 4 + 3,
    tags: [["h", "members"]],
  }),
]);
const profiles = people.map((person, i) =>
  profile(person, {
    name: `Person ${i}`,
    picture: `https://avatar.test/${i}.png`,
  }),
);
const rows = foldMessages("members", relay.pubkey, events);
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => url,
  query: async (filters) =>
    profiles.filter((event) =>
      filters.some((filter) => filter.authors?.includes(event.pubkey)),
    ),
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
});
void owner.session.profiles.ensure(people.map((person) => person.pubkey));
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
          scope="membership-scroll"
          channelId="members"
          queries={owner.session}
          window={{
            channelId: "members",
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
