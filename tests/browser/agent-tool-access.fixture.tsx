import { createRoot } from "react-dom/client";
import type { Agent, Agents } from "../../src/features/agents/service";
import { AgentToolAccess } from "../../src/bundled/agents/AgentToolAccess";
import "../../src/shared/styles/globals.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
if (params.has("large")) document.documentElement.style.fontSize = "150%";

const key = "a".repeat(64);
const agent = {
  key,
  pubkey: key,
  owner: "f".repeat(64),
  name: "Ada",
  type: "buzz.claude-code/claude-code",
  place: "here",
  relay: "wss://relay.example",
  config: {
    model: "sonnet",
    instructions: "Keep these",
    ...(params.has("custom") && {
      toolPreset: "custom",
      toolAllow: `buzz:message,buzz:read,connected:github/get_pull_request,native-tool:skill,native:meta,native:read${params.has("legacy") ? ",native:other" : ""}`,
    }),
  },
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
} satisfies Agent;
const added = [
  { name: "tasks_update", description: "Update a Task.", effect: "coordinate" },
];
const agents = {
  save: async (_key: string, update: unknown) => {
    (window as unknown as { toolSave: unknown }).toolSave = update;
  },
  subscribe: () => () => {},
  tools: () => added,
} as unknown as Agents;

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <main className="mx-auto min-h-screen w-full max-w-3xl bg-base p-6 text-primary">
    <AgentToolAccess agents={agents} agent={agent} />
  </main>,
);
