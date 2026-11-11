import { createRoot } from "react-dom/client";
import { RemoteAgents } from "../../src/bundled/builderlab/agents/RemoteAgents";
import type {
  AgentClient,
  RemoteAgent,
} from "../../src/bundled/builderlab/agents/client";
import type { BuilderlabSession } from "../../src/bundled/builderlab/session";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
if (params.has("large")) document.documentElement.style.fontSize = "150%";

const helper: RemoteAgent = {
  id: "helper",
  name: "Helper",
  pubkey: "a".repeat(64),
  status: "Active",
  modelId: "fast",
  modelSelectionStatus: "valid",
};
const scout: RemoteAgent = {
  id: "scout",
  name: "Scout",
  pubkey: "b".repeat(64),
  status: "Unattested",
  requestedBy: helper.pubkey,
  instructions: "Watch the build and report when it breaks.",
};
let agents: readonly RemoteAgent[] = [helper, scout];
const calls: unknown[] = [];
const holds = new Map<string, () => void>();
const hold = (name: string) =>
  new Promise<void>((resolve) => holds.set(name, resolve));
Object.assign(window, {
  calls,
  release: (name: string) => holds.get(name)?.(),
});

const account = {
  subject: "owner",
  email: "owner@example.com",
  canUseRemoteAgents: true,
  canUseBuilderlabDecisions: false,
};
const login = Object.freeze({ status: "signed-in", account });
const session = {
  snapshot: () => login,
  subscribe: () => () => {},
} as unknown as BuilderlabSession;
const client = { list: async () => agents } as unknown as AgentClient;

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <ToastProvider>
    <RemoteAgents
      client={client}
      session={session}
      active={() => true}
      showHeading={false}
      review={{
        approve: async (agent, instructions) => {
          calls.push(["approve", agent.id, instructions]);
          await hold("approve");
          agents = agents.filter((item) => item.id !== agent.id);
        },
        reject: async (agent) => {
          calls.push(["reject", agent.id]);
          await hold("reject");
          agents = agents.filter((item) => item.id !== agent.id);
        },
      }}
    />
  </ToastProvider>,
);
