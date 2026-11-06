// A Pi agent's production Settings in AgentTabs, its listing read through
// PiRuntime's own route methods on the shared GatewayRoutes. Only the Pi
// host's answers and the gateway's model-access answer are replaced, and the
// toolbar controls them: no host process, network, descriptor or relay.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentTabs } from "../../src/bundled/agents/AgentTabs";
import { DEFAULT_CONFIG, PiRuntime } from "../../src/bundled/pi/runtime";
import { PiSetup, type Provider } from "../../src/bundled/pi/setup";
import { createTabs } from "../../src/bundled/pi/tabs";
import { HARNESS } from "../../src/bundled/pi/gateway";
import { GatewayRoutes } from "../../src/features/agents/gateway/route";
import { piGatewayDescriptor } from "../../src/bundled/pi/pi-testing";
import type { HostResponse } from "../../src/features/host/service";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../src/features/agents/service";
import { createAppearance } from "../../src/shared/theme/service";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

createAppearance();
const KEY = "c".repeat(64);
const COMMUNITY = "22222222-2222-4222-8222-222222222222";
const RELAY_ORIGIN = "https://relay.example";

/** What the gateway answers the model-access probe with: held until changed. */
type Gateway = "allow" | "deny" | "hold";
let gateway: Gateway = "allow";
const held: ((response: HostResponse) => void)[] = [];
const answer = (resolve: (response: HostResponse) => void) =>
  resolve(
    gateway === "allow"
      ? {
          status: 200,
          headers: {},
          // The rollout flag that enables Pi: without it Pi keeps its own
          // providers.
          body: JSON.stringify({ harnesses: [HARNESS] }),
        }
      : { status: 401, headers: {}, body: "" },
  );
const routes = new GatewayRoutes(() =>
  piGatewayDescriptor(COMMUNITY, RELAY_ORIGIN),
);
routes.bindRequest(
  () =>
    new Promise<HostResponse>((resolve) => {
      if (gateway === "hold") held.push(resolve);
      else answer(resolve);
    }),
);
/** The agent's membership: in the gateway's community, or another one. */
const member = (listed: boolean) =>
  routes.setMembership({
    key: KEY,
    origin: listed ? RELAY_ORIGIN : "https://other.test",
    owner: "a".repeat(64),
    pubkey: KEY,
    community: { id: COMMUNITY, session: {} },
  });

const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    key: true,
    signsIn: true,
    configured: "auth.json",
  },
  { id: "openai", name: "OpenAI", key: true, signsIn: false },
];
const MODELS: Record<
  string,
  { id: string; name: string; thinking: string[] }[]
> = {
  anthropic: [{ id: "claude-x", name: "Claude X", thinking: ["off", "high"] }],
  openai: [{ id: "gpt-x", name: "GPT X", thinking: ["off", "low"] }],
  "buzz-gateway": [{ id: "model-a", name: "Model A", thinking: ["off"] }],
};
/** The Pi host's answers, as host.mjs gives them for an agent open on
 * the gateway's route and for Pi's own listing. */
const pi = {
  request: async (method: string, params: Record<string, string> = {}) => {
    if (method === "providers")
      return {
        providers: [
          ...(params.agent
            ? [
                {
                  id: "buzz-gateway",
                  name: "Model gateway",
                  key: false,
                  signsIn: false,
                  configured: "gateway",
                },
              ]
            : []),
          ...PROVIDERS.map((item) => ({
            ...item,
            ...(params.agent
              ? { unavailable: "Unavailable in gateway mode" }
              : {}),
          })),
        ],
        defaults: { provider: "anthropic", model: "claude-x" },
      };
    if (method === "models")
      return params.agent && params.provider !== "buzz-gateway"
        ? []
        : (MODELS[params.provider ?? ""] ?? []);
    if (method === "defaults")
      return { provider: "anthropic", model: "claude-x" };
    if (method === "test")
      return { ok: true, message: `Connected to ${params.model}` };
    throw new Error(`Unexpected ${method}`);
  },
} as unknown as ConstructorParameters<typeof PiSetup>[0];
const setup = new PiSetup(pi);
// PiRuntime's own listing, test and route methods, without starting a host:
// opening an agent only to read runs nothing.
const runtime = Object.assign(Object.create(PiRuntime.prototype), {
  setup,
  seam: {
    routeFor: routes.routeFor.bind(routes),
    routeReady: routes.routeReady.bind(routes),
    subscribeRoute: routes.subscribeRoute.bind(routes),
  },
  open: async () => {},
  places: async () => [],
  working: () => [],
  subscribe: () => () => {},
  channelLabel: () => undefined,
  subscribeChannels: () => () => {},
}) as PiRuntime;
const { SettingsTab } = createTabs({ setup, runtime });
const type = {
  key: "buzz.pi/pi",
  // As src/bundled/pi/index.ts declares it.
  gateway: { harness: HARNESS },
  tabs: [
    {
      id: "settings",
      title: "Settings",
      role: "settings",
      splitSettings: true,
      component: SettingsTab,
    },
  ],
} as unknown as RegisteredAgentType;
const saved =
  new URLSearchParams(location.search).get("provider") ?? "anthropic";
const agent = {
  key: KEY,
  pubkey: KEY,
  name: "Pi fixture",
  type: type.key,
  owner: "a".repeat(64),
  config: {
    ...DEFAULT_CONFIG,
    provider: saved,
    model: saved === "buzz-gateway" ? "model-a" : "claude-x",
  },
  place: "here",
  relay: "wss://relay.test",
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
} as unknown as Agent<typeof DEFAULT_CONFIG>;
const agents = {
  save: async () => {},
  subscribe: () => () => {},
  memberships: () => [],
  configHistory: () => undefined,
  addedTabs: () => [],
  registerTab: () => {},
  controlAttention: () => {},
} as unknown as Agents;

member(!new URLSearchParams(location.search).has("external"));

function Fixture() {
  useKeyboardFocusVisibility();
  const [state, setState] = useState(gateway);
  const set = (next: Gateway) => {
    gateway = next;
    setState(next);
    if (next !== "hold") for (const resolve of held.splice(0)) answer(resolve);
  };
  return (
    <main className="flex h-dvh flex-col">
      <div
        role="toolbar"
        aria-label="Fixture controls"
        className="flex flex-wrap gap-2 border-b p-2 text-body-sm"
      >
        <span>Gateway: {state}</span>
        <button type="button" onClick={() => set("allow")}>
          Allow
        </button>
        <button type="button" onClick={() => set("deny")}>
          Deny (401)
        </button>
        <button type="button" onClick={() => set("hold")}>
          Hold
        </button>
        <button type="button" onClick={() => member(true)}>
          Gateway community
        </button>
        <button type="button" onClick={() => member(false)}>
          Other community
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <AgentTabs
          agents={agents}
          agent={agent}
          type={type}
          channels={[]}
          settingsHost={{}}
          memories={undefined}
          settingsContent={null}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
