import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BestieBaseline } from "../../src/bundled/bestie/BestieBaseline";
import { baselineFixture } from "../../src/bundled/bestie/baseline-testing";
import { createRelaySession } from "../../src/features/relay/session";
import { keypair } from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";
const viewer = keypair(),
  agent = keypair();
const channel = "11111111-1111-4111-8111-111111111111";
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: viewer.pubkey,
  media: () => undefined,
  query: async () => [],
  readAgentLibrary: async () => ({
    definitions: [],
    identities: [{ pubkey: agent.pubkey, name: "Sample Bestie" }],
  }),
  readAgentMemories: async () => ({
    partial: false,
    entries: [
      {
        slug: "mem/bestie",
        eventId: "d".repeat(64),
        createdAt: 1790000002,
        body: JSON.stringify(baselineFixture(viewer.pubkey, channel)),
      },
    ],
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <main className="p-6 space-y-4">
      <h1 className="text-heading">Bestie baseline preview</h1>
      <p className="text-body-sm">
        Sample data only. No model, real memories, or live message publication.
      </p>
      <BestieBaseline
        session={owner.session}
        channelId={channel}
        members={[viewer.pubkey, agent.pubkey]}
      />
    </main>
  </StrictMode>,
);
