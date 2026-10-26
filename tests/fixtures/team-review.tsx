import { createRoot } from "react-dom/client";
import { TeamReview } from "../../src/bundled/agents/TeamReview";
import type {
  Agent,
  Agents,
  TeamChange,
  TeamRequest,
} from "../../src/features/agents/service";
import "../../src/shared/styles/globals.css";

const params = new URLSearchParams(location.search);
const running = ["Ada", "Bo", "Cy"].map(
  (name, index) =>
    ({
      pubkey: String(index + 1).repeat(64),
      owner: "f".repeat(64),
      type: "fixture/agent",
      name,
      config: {},
      relay: "",
      place: "here",
      skipped: {},
      timers: {},
      attention: {},
      attentionEnabled: true,
    }) as Agent,
);
const snapshot = { running };
let requests: readonly TeamRequest[] = [
  {
    id: "req",
    requester: "a".repeat(64),
    requesterName: "Parent",
    owner: "f".repeat(64),
    community: "https://relay.example",
    ...(params.has("new") ? {} : { team: "t1", teamName: "Reviewers" }),
    name: params.has("new") ? "Reviewers" : "QA reviewers",
    instructions: "Review every pull request.",
    members: ["1".repeat(64), "3".repeat(64)],
  },
];
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const approved: Array<{ id: string; input: TeamChange }> = [];
const dismissed: string[] = [];
let attempts = 0;
Object.assign(window, {
  teamReviewResult: () => ({ approved, dismissed }),
});
const agents = {
  snapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  teamRequests: () => requests,
  dismissTeam: (id: string) => {
    dismissed.push(id);
    requests = requests.filter((request) => request.id !== id);
    notify();
  },
  approveTeam: async (id: string, input: TeamChange) => {
    if (params.has("fail") && ++attempts === 1)
      throw new Error("A member is not an agent on this device");
    approved.push({ id, input });
    requests = requests.filter((request) => request.id !== id);
    notify();
    return { id: "t1", ...input };
  },
} as unknown as Agents;
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<TeamReview agents={agents} />);
