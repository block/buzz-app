import { createRoot } from "react-dom/client";
import { InstructionReview } from "../../src/features/agents/InstructionReview";
import { InstructionRequests } from "../../src/features/agents/instruction-requests";
import type { Agents } from "../../src/features/agents/service";
import { localStore } from "../../src/features/agents/store";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const listeners = new Set<() => void>();
const requests = new InstructionRequests(localStore(), () => {
  for (const listener of listeners) listener();
});
const agents = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  instructionReviews: requests.snapshot,
  decideInstruction: (id: string, allowed: boolean) =>
    requests.decide(id, allowed),
} as Agents;
let deliveries = 0;
async function request() {
  const receipt = await requests.submit({
    review: {
      id: await requests.id(),
      agent: "a".repeat(64),
      owner: "b".repeat(64),
      community: "https://synthetic.example.test",
      source: "synthetic-source-channel",
      plugin: "synthetic-provider",
      operation: "synthetic/link",
      tool: "synthetic_link",
      text: "Link only synthetic A to synthetic B.",
      args: { from: "A", to: "B", detail: "long-value-".repeat(1000) },
    },
    check: () => {},
    cancel: () => {},
    deliver: async () => {
      deliveries++;
      return "delivered";
    },
  });
  const output = document.querySelector("output");
  if (!output) throw new Error("Missing receipt output");
  output.textContent = `${receipt.status}; deliveries=${deliveries}`;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <>
    <Button onClick={() => void request()}>Request instruction</Button>
    <output aria-label="Receipt" />
    <InstructionReview agents={agents} />
  </>,
);
