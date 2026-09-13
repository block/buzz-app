import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentChannelsPage } from "../../src/bundled/agent-channels/AgentChannelsPage";
import { parseGitHubReference } from "../../src/bundled/github/references";
import type { Objects } from "../../src/features/objects/service";
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
  message(
    rizz,
    "map",
    "Dashboard shipped https://github.com/block/buzz/pull/8",
    1_789_080_500,
  ),
  message(
    carl,
    "map",
    "Review is up https://github.com/block/buzz/pull/9",
    1_789_080_100,
  ),
  message(
    fizz,
    "design",
    "Polish pass https://github.com/block/buzz/pull/10",
    1_789_000_000,
  ),
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

const objectProviders = Object.freeze([{ key: "buzz.github/objects" }]);
const objects = {
  snapshot: () => objectProviders,
  subscribe: () => () => {},
  resolve(target: string) {
    const reference = parseGitHubReference(target);
    return reference?.kind === "pull"
      ? {
          provider: { key: "buzz.github/objects" },
          reference: {
            provider: "github",
            key: `${reference.repository}:pull:${reference.label}`,
            kind: "pull",
            url: reference.url,
            label: reference.label,
            group: reference.repository,
          },
        }
      : undefined;
  },
  async load(target: string) {
    const pull = Number(target.split("/").at(-1));
    const reference = this.resolve(target)?.reference;
    if (!reference) return;
    const merged = pull !== 9;
    return {
      reference,
      title:
        pull === 8
          ? "Launch the agent outcomes dashboard"
          : pull === 9
            ? "Connect signed evidence to pull requests"
            : "Polish the relationship map",
      state: merged ? "Merged" : "open",
      author: "buzz-agent",
      facts: [
        ["Branch", `tho/outcomes-${pull} → block:main`],
        ["Files changed", pull],
        ["Changes", `+${pull * 10} / −${pull}`],
      ],
    };
  },
} as unknown as Objects;

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <main className="h-dvh bg-shell p-4">
      <AgentChannelsPage relay={relay} objects={objects} />
    </main>
  </StrictMode>,
);
