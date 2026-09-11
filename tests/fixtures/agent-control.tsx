import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentControlPanel } from "../../src/bundled/agents/AgentControlPanel";
import { createAgentControl } from "../../src/features/agents/control";
import { controlFixture } from "../../src/features/agents/control-testing";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

const fixture = controlFixture();
const control = createAgentControl(fixture.host);
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
        <AgentControlPanel
          key={browser ? "browser" : "native"}
          control={browser ? unavailable : control}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
