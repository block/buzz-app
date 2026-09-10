import "../../src/shared/styles/globals.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { finalizeEvent } from "nostr-tools";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  metadata,
  roster,
  profile,
} from "../../src/features/relay/testing";
import { matchesEvent } from "../../src/features/relay/projection";
import type { RelayEvent } from "../../src/features/relay/events";

const viewer = keypair(),
  relay = keypair(),
  first = keypair(),
  second = keypair();
let members = [viewer.pubkey, first.pubkey, second.pubkey];
let time = 1700000000;
const publications: RelayEvent[] = [];
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: (url) => url,
    async query(filters) {
      const events = [
        roster(relay, "c", members, time),
        metadata(relay, "c", "General"),
        profile(viewer, { name: "Viewer" }),
        profile(first, { name: "Honey" }),
        profile(second, { name: "Honey" }),
        ...publications,
      ];
      return events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    writer: {
      kinds: [9],
      async sign(event) {
        return finalizeEvent(
          { ...event, tags: event.tags.map((tag) => [...tag]) },
          viewer.secret,
        );
      },
      async publish(event) {
        publications.push(event);
      },
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
owner.session.channels.ensureList();
Object.assign(window, {
  mentionFixture: {
    first: first.pubkey,
    second: second.pubkey,
    publications,
    outbox: () => owner.session.outbox?.snapshot(),
  },
});
function Fixture() {
  const [thread, setThread] = useState(false);
  return (
    <main style={{ maxWidth: 700, padding: 40, marginTop: 380 }}>
      <button type="button" onClick={() => setThread(!thread)}>
        Toggle thread
      </button>
      <button
        type="button"
        onClick={() => {
          members = [viewer.pubkey, second.pubkey];
          time++;
          owner.session.channels.refreshList?.();
        }}
      >
        Remove first Honey
      </button>
      <MessageComposer
        session={owner.session}
        scope="mentions-fixture"
        channelId="c"
        channelName="General"
        {...(thread ? { threadRootId: "a".repeat(64) } : {})}
      />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
