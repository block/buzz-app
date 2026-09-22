import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CommunityComputeView,
  type SharingState,
} from "../../src/bundled/community-compute/CommunityComputeView";
import { COMMUNITY_COMPUTE_TUTORIAL_FIXTURES } from "../../src/bundled/community-compute/communityComputeFixtures";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const scenarios = Object.values(COMMUNITY_COMPUTE_TUTORIAL_FIXTURES);

// No broker, relay, native calls or timers. Controls advance explicit sample states.
function Preview() {
  const [scenario, setScenario] = useState("small-company");
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  }, [dark]);
  const [status, setStatus] = useState<SharingState>({
    state: "off",
    mode: null,
    modelId: null,
  });
  const snapshot = scenarios.find((item) => item.id === scenario)?.snapshot;
  return (
    <div className="flex h-screen flex-col bg-panel text-primary">
      <nav
        aria-label="Preview controls"
        className="flex flex-wrap gap-3 p-panel-inset text-body"
      >
        <label>
          Sample community{" "}
          <select
            value={scenario}
            onChange={(event) => setScenario(event.target.value)}
          >
            {scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => setDark(!dark)}>
          Switch to {dark ? "light" : "dark"}
        </Button>
        <Button
          disabled={status.state !== "starting"}
          onClick={() =>
            setStatus((current) => ({
              ...current,
              state: "running",
              detail: "Model ready",
            }))
          }
        >
          Finish sample download
        </Button>
        <Button
          onClick={() =>
            setStatus((current) => ({
              ...current,
              state: "failed",
              mode: "serve",
              detail: "Sample startup failure. Turn sharing off, then retry.",
            }))
          }
        >
          Show startup failure
        </Button>
        <Button
          onClick={() =>
            setStatus({
              state: "running",
              mode: "client",
              modelId: "Remote community model",
            })
          }
        >
          Show consuming state
        </Button>
      </nav>
      <main className="min-h-0 flex-1">
        <CommunityComputeView
          preview
          communityName="Sample community"
          snapshot={snapshot}
          controls={{
            status,
            models: [
              {
                id: "sample/local-model",
                label: "Sample local model",
                recommended: true,
              },
            ],
            async start(request) {
              setStatus({
                state: "starting",
                mode: "serve",
                modelId: request.modelId,
                detail: "Downloading sample model…",
                download: { received: 35, total: 100 },
              });
            },
            async stop() {
              setStatus({ state: "off", mode: null, modelId: null });
            },
          }}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
