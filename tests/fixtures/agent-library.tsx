import { agentAvatars } from "../../src/features/agents/avatar-packs";
import { createRoot } from "react-dom/client";
import { CreationReview } from "../../src/bundled/agents/CreationReview";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  AgentCreationRequest,
  NewAgent,
} from "../../src/features/agents/service";
import type { RelayData } from "../../src/features/relay/service";
import { AgentInstructions } from "../../src/features/agents/AgentInstructions";
import { CreateModelChoices } from "../../src/features/agents/CreateModelChoices";
import "../../src/shared/styles/globals.css";

const type: RegisteredAgentType = {
  key: "fixture/agent",
  pluginId: "fixture",
  revision: "1",
  id: "agent",
  title: "Fixture",
  description: "Fixture agent",
  defaults: () => ({ config: {} }),
  Create: () => (
    <AgentInstructions value="" disabled={false} onChange={() => {}} creation />
  ),
  CreateModel: ({ disabled, modelAppearance }) => (
    <CreateModelChoices
      modelAppearance={modelAppearance}
      models={[{ id: "example", label: "Example model" }]}
      value="example"
      defaultLabel=""
      includeDefault={false}
      disabled={disabled}
      onChange={() => {}}
    />
  ),
};
const snapshot = {
  status: "ready" as const,
  running: [],
  teams: [],
  agents: ["Ada", "Bo", "Cy"].map(
    (name, index) =>
      ({
        pubkey: String(index + 1).repeat(64),
        owner: "f".repeat(64),
        type: type.key,
        name,
        picture: agentAvatars[index]?.url,
        config: {},
        relay: "",
        place: "here",
        skipped: {},
        timers: {},
        attention: {},
        attentionEnabled: true,
      }) as Agent,
  ),
};
const types = [type];
const reviewing = new URLSearchParams(location.search).has("review");
let requests: readonly AgentCreationRequest[] = reviewing
  ? [
      {
        id: "draft",
        requester: "a".repeat(64),
        requesterName: "Parent",
        owner: "f".repeat(64),
        community: "https://relay.example",
        type: type.key,
        name: "Child",
      },
    ]
  : [];
const listeners = new Set<() => void>();
const reviewed: NewAgent[] = [];
const dismissCreation = () => {
  requests = [];
  for (const listener of listeners) listener();
};
Object.assign(window, { creationReviewResult: () => reviewed });
const agents = {
  snapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  creationRequests: () => requests,
  dismissCreation,
  approveCreation: async (_id: string, input: NewAgent) => {
    reviewed.push(input);
    dismissCreation();
    return {} as Agent;
  },
  types: () => types,
  find: (pubkey: string) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey),
  relay: () => undefined,
  save: async () => {},
  classifier: () => "unavailable",
} as unknown as Agents;
const disconnected = { status: "disconnected", generation: 0 };
const relay = {
  snapshot: () => disconnected,
  subscribe: () => () => {},
} as unknown as RelayData;
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <div className="h-screen">
    <AgentsPage agents={agents} relay={relay} />
    {reviewing && <CreationReview agents={agents} />}
  </div>,
);
