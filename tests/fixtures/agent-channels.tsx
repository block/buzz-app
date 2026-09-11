import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentChannelsPage } from "../../src/bundled/agent-channels/AgentChannelsPage";
import type { RelayData } from "../../src/features/relay/service";
import type { RelaySession } from "../../src/features/relay/session";
import { keypair, message } from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";

document.documentElement.dataset.colorMode = "dark";

const rizz = keypair();
const fizz = keypair();
const honey = keypair();
const carl = keypair();
const library = Object.freeze({
  status: "ready" as const,
  definitions: Object.freeze([
    { id: "rizz", name: "Rizz" },
    { id: "fizz", name: "Fizz" },
    { id: "honey", name: "Honey" },
    { id: "carl", name: "Carl" },
  ]),
  identities: Object.freeze([
    { pubkey: rizz.pubkey, name: "Rizz", definitionId: "rizz" },
    { pubkey: fizz.pubkey, name: "Fizz", definitionId: "fizz" },
    { pubkey: honey.pubkey, name: "Honey", definitionId: "honey" },
    { pubkey: carl.pubkey, name: "Carl", definitionId: "carl" },
  ]),
});
const archives = Object.freeze({ status: "ready" as const, archived: [] });
const channels = Object.freeze({
  status: "ready" as const,
  channels: Object.freeze([
    {
      id: "map",
      name: "buzz-agent-channel-map",
      channelType: "stream" as const,
      members: [rizz.pubkey, carl.pubkey],
    },
    {
      id: "design",
      name: "buzz-design",
      channelType: "forum" as const,
      members: [rizz.pubkey, fizz.pubkey, honey.pubkey],
    },
    {
      id: "history",
      name: "buzz-plugin-architecture",
      channelType: "stream" as const,
      members: [],
    },
  ]),
});
const activity = [
  message(rizz, "map", "Working", 1_789_080_500),
  message(carl, "map", "Handoff", 1_789_080_100),
  message(fizz, "design", "Review", 1_789_000_000),
  message(rizz, "history", "Earlier work", 1_788_000_000),
];
const session = {
  agentLibrary: {
    snapshot: () => library,
    subscribe: () => () => {},
    refresh: async () => {},
  },
  archives: {
    snapshot: () => archives,
    subscribe: () => () => {},
    refresh: async () => {},
    state: () => "not-archived",
  },
  channels: {
    list: () => channels,
    subscribeList: () => () => {},
    ensureList() {},
    window: () => ({ status: "idle", rows: [] }),
    subscribeWindow: () => () => {},
    ensure() {},
    loadOlder() {},
    refreshList() {},
  },
  read: async () => activity,
  media: () => undefined,
} as unknown as RelaySession;
const relaySnapshot = Object.freeze({
  status: "ready" as const,
  scope: "fixture",
  generation: 1,
  viewer: keypair().pubkey,
  session,
});
const relay = {
  snapshot: () => relaySnapshot,
  subscribe: () => () => {},
} as unknown as RelayData;

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <main className="h-dvh bg-shell p-4">
      <AgentChannelsPage relay={relay} />
    </main>
  </StrictMode>,
);
