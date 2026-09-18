import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import { createRelaySession } from "../../src/features/relay/session";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import { createAgentControl } from "../../src/features/agents/control";
import { controlFixture } from "../../src/features/agents/control-testing";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

const fixture = controlFixture();
const modelCalls: string[] = [];
let modelMode = "success";
let releaseModels: (() => void) | undefined;
fixture.host.models = {
  begin: async () => {
    modelCalls.push("begin");
    return modelCalls.length;
  },
  cancel: async () => {
    modelCalls.push("cancel");
    releaseModels?.();
  },
  run: async (_ticket, request) => {
    modelCalls.push(request.action);
    if (modelMode === "wait")
      await new Promise<void>((resolve) => {
        releaseModels = resolve;
      });
    if (modelMode === "error") throw "Synthetic connection failure.";
    return {
      host: request.host,
      models:
        modelMode === "empty" || request.action === "disconnect"
          ? []
          : [
              { id: "catalog.schema.real-model", name: "Friendly Model" },
              { id: "endpoint-two", name: "Other Model" },
            ],
      modelOverridden: false,
      disconnected: request.action === "disconnect",
    };
  },
};
const control = createAgentControl(fixture.host);
const session = createRelaySession({
  viewer: "de".repeat(32),
  relayAuthor: "ef".repeat(32),
  scope: "wss://relay.example.test",
  async readAgentLibrary() {
    return {
      definitions: [
        { id: "fixture", name: fixture.agent.name },
        { id: "unlinked", name: "Library only" },
      ],
      identities: [
        {
          pubkey: fixture.agent.pubkey,
          name: fixture.agent.name,
          definitionId: "fixture",
        },
      ],
    };
  },
  async query() {
    return [];
  },
  media: () => undefined,
});
const relaySnapshot: RelaySnapshot = {
  status: "ready",
  scope: "fixture",
  generation: 1,
  session: session.session,
};
const relay: RelayData = {
  snapshot: () => relaySnapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: async () => {},
};
Object.assign(window, {
  agentModelsFixture: {
    calls: modelCalls,
    mode: (value: string) => {
      modelMode = value;
    },
    release: () => releaseModels?.(),
  },
});
Object.assign(window, { agentControlFixture: { ...fixture, control } });
function Fixture() {
  useKeyboardFocusVisibility();
  const [shown, setShown] = useState(true);
  const [failure, setFailure] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [unavailable] = useState(() => createAgentControl(null));
  return (
    <main
      data-buzz-ui=""
      className="mx-auto max-w-4xl space-y-4 p-4 text-body text-primary"
    >
      <header className="space-y-3 rounded-xl bg-panel p-4">
        <h1 className="text-heading">Agent editor · Isolated fixture</h1>
        <p className="text-secondary">
          Temporary, in-memory identities only. No Keychain, real libraries,
          relay connection, or agent processes. All Start/Stop and import
          actions here are simulated. Reload resets changes; use sample values
          only.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setShown(!shown)}>Toggle page</Button>
          <Button
            onClick={() => {
              fixture.failSave(!failure);
              setFailure(!failure);
            }}
          >
            {failure ? "Allow saves" : "Reject saves"}
          </Button>
          <Button
            onClick={() => {
              fixture.agent.revision++;
              void control.refresh();
            }}
          >
            Simulate newer revision
          </Button>
          <Button
            onClick={() => {
              fixture.data.runtimeAvailable = !fixture.data.runtimeAvailable;
              void control.refresh();
            }}
          >
            Toggle runtime availability
          </Button>
          <Button onClick={() => setBrowser(!browser)}>
            Toggle browser-only mode
          </Button>
          <Button
            onClick={() => {
              const root = document.documentElement;
              root.dataset.colorMode =
                root.dataset.colorMode === "dark" ? "light" : "dark";
            }}
          >
            Toggle appearance
          </Button>
        </div>
      </header>
      {shown && (
        <AgentsPage
          relay={relay}
          key={browser ? "browser" : "native"}
          control={browser ? unavailable : control}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
