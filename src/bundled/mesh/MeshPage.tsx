import { useCallback, useEffect, useState } from "react";
import { IconServer2 } from "@tabler/icons-react";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import type { MeshBridge, MeshStatus } from "./bridge";

/**
 * Curated serve models for the scaffold. A live model catalog (legacy's
 * `model_catalog`) is follow-up; until then the operator picks a known ref.
 */
const MODELS: readonly { value: string; label: string }[] = [
  { value: "qwen3-8b", label: "Qwen3 8B" },
  { value: "qwen3-4b", label: "Qwen3 4B" },
  { value: "gemma3-4b", label: "Gemma 3 4B" },
];
const DEFAULT_MODEL = "qwen3-8b";

type Phase = "loading" | "idle" | "starting" | "running" | "stopping";

export function MeshPage({ bridge }: { bridge: MeshBridge }) {
  const [status, setStatus] = useState<MeshStatus>({ running: false });
  const [phase, setPhase] = useState<Phase>("loading");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((next: MeshStatus) => {
    setStatus(next);
    setPhase(next.running ? "running" : "idle");
    if (next.running && next.model) setModel(next.model);
  }, []);

  useEffect(() => {
    let active = true;
    bridge
      .status()
      .then((next) => {
        if (active) applyStatus(next);
      })
      .catch((reason) => {
        if (!active) return;
        setError(String(reason));
        setPhase("idle");
      });
    return () => {
      active = false;
    };
  }, [bridge, applyStatus]);

  const start = async () => {
    setError(null);
    setPhase("starting");
    try {
      applyStatus(await bridge.start(model));
    } catch (reason) {
      setError(String(reason));
      setPhase("idle");
    }
  };

  const stop = async () => {
    setError(null);
    setPhase("stopping");
    try {
      applyStatus(await bridge.stop());
    } catch (reason) {
      setError(String(reason));
      setPhase("running");
    }
  };

  const busy = phase === "starting" || phase === "stopping";
  const running = phase === "running";
  // The node is up (show Stop) while running and while a stop is in flight.
  const nodeUp = phase === "running" || phase === "stopping";

  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Mesh">
        <div className="h-full min-h-0 overflow-auto p-panel-inset text-body">
          <h1 className="m-0 flex items-center gap-2 text-title text-primary">
            <IconServer2 size={22} aria-hidden="true" />
            Mesh
          </h1>
          <p className="mt-2 max-w-prose text-secondary">
            Run a local inference node. The runtime and model weights download
            on first start and are never bundled with the app.
          </p>

          <div className="mt-6 flex max-w-prose flex-col gap-4">
            <Select
              label="Model"
              value={model}
              onValueChange={setModel}
              groups={[{ label: "Models", options: MODELS }]}
            />

            <div className="flex items-center gap-3">
              {nodeUp ? (
                <Button variant="quiet" onClick={stop} disabled={busy}>
                  {phase === "stopping" ? "Stopping…" : "Stop node"}
                </Button>
              ) : (
                <Button variant="primary" onClick={start} disabled={busy}>
                  {phase === "starting" ? "Starting…" : "Start node"}
                </Button>
              )}
              <span className="text-secondary" aria-live="polite">
                {phase === "loading"
                  ? "Checking status…"
                  : running
                    ? "Running"
                    : busy
                      ? ""
                      : "Stopped"}
              </span>
            </div>

            {running && status.apiBaseUrl && (
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
                <dt className="text-secondary">OpenAI endpoint</dt>
                <dd className="m-0 font-mono text-primary">
                  {status.apiBaseUrl}
                </dd>
                {status.consoleUrl && (
                  <>
                    <dt className="text-secondary">Console</dt>
                    <dd className="m-0 font-mono text-primary">
                      {status.consoleUrl}
                    </dd>
                  </>
                )}
              </dl>
            )}

            {error && (
              <p role="alert" className="m-0 text-danger">
                {error}
              </p>
            )}
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}
