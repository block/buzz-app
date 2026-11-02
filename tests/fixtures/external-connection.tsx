import { createRoot } from "react-dom/client";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { ExternalConnectionSettings } from "../../src/bundled/agents/ExternalConnectionSettings";
import { createExternalConnection } from "../../src/features/agents/external-connection";
import type { Agents } from "../../src/features/agents/service";
import type { RelayData } from "../../src/features/relay/service";
import { Button } from "../../src/shared/design-system/ui/Button";
import { createAppearance } from "../../src/shared/theme/service";
import "../../src/shared/styles/globals.css";

const appearance = createAppearance();
const parameters = new URLSearchParams(location.search);
appearance.setMode(parameters.get("theme") === "dark" ? "dark" : "light");
appearance.setFontScale(Number(parameters.get("scale") ?? 1));
const pubkey = "a".repeat(64);
const agent = { key: pubkey, pubkey, name: "Test agent", place: "here" };
const subscribe = () => () => {};
const choices = {
  selectable: [{ pubkey }],
  pending: false,
  archives: { status: "ready" },
};
const session = { agentChoices: { subscribe, snapshot: () => choices } };
const snapshot = { status: "ready", session };
const inventory = { agents: [agent] };
let admit = () => {};
let end = () => {};
const agents = {
  subscribe,
  snapshot: () => inventory,
  connectExternal: async (
    _key: string,
    signal: AbortSignal,
    connected: () => void,
  ) => {
    admit = connected;
    const closed = new Promise<void>((resolve) => {
      end = resolve;
    });
    signal.addEventListener("abort", () => end(), { once: true });
    return {
      url: "http://127.0.0.1:1234/mcp",
      headers: [
        {
          name: "Authorization",
          value: "Bearer fixture-only-not-a-real-grant",
        },
      ],
      close: async () => end(),
      closed,
    };
  },
} as unknown as Agents;
const connection = createExternalConnection(agents);
function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <main className="mx-auto grid max-w-3xl gap-section-gap p-4">
      <ExternalConnectionSettings
        agents={agents}
        relay={{ subscribe, snapshot: () => snapshot } as unknown as RelayData}
        connection={connection}
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => admit()}>Fixture: admit Nexus</Button>
        <Button onClick={() => end()}>Fixture: end runtime</Button>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
