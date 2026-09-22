import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../shared/design-system/ui/Button";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import type { NativeSharingStatus } from "../../features/community-compute/sharing";
import type { ComputeControls } from "./CommunityComputeView";
import styles from "./Compute.module.css";

export function ConsumerComputeView({
  status,
  controls,
  error: sourceError,
}: {
  status: NativeSharingStatus;
  controls: ComputeControls;
  error?: string;
}) {
  const [prompt, setPrompt] = useState("Say hello in one short sentence.");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const epoch = useRef(0);
  const generation = useRef(status.generation);
  useEffect(() => {
    generation.current = status.generation;
    epoch.current++;
    setAnswer("");
    setPending(false);
    return () => {
      epoch.current++;
    };
  }, [status.generation]);
  const active =
    status.state === "starting" ||
    status.state === "running" ||
    status.state === "stopping";
  const running = status.state === "running";
  async function connect() {
    setError("");
    try {
      if (active) await controls.stop();
      else await controls.start({ mode: "client", modelId: "remote" });
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function test() {
    const attempt = ++epoch.current;
    setPending(true);
    setError("");
    setAnswer("");
    try {
      const result = await invoke<string>("community_compute_test", {
        generation: status.generation,
        prompt,
      });
      if (attempt === epoch.current) setAnswer(result);
    } catch (reason) {
      if (attempt === epoch.current) setError(String(reason));
    } finally {
      if (attempt === epoch.current) setPending(false);
    }
  }
  return (
    <FullPageSurface aria-label="Compute consumer">
      <div className="h-full overflow-auto p-panel-inset text-body">
        <div className={styles.content}>
          <h1 className="m-0 text-title text-primary">Compute — Consumer</h1>
          <p className="text-body text-secondary">
            Use a model shared by another device in the selected community. This
            app does not download or serve a local model.
          </p>
          <Button
            onClick={() => {
              void connect();
            }}
            disabled={
              status.state === "stopping" ||
              (!active && controls.canStart === false)
            }
          >
            {active
              ? status.state === "starting"
                ? "Cancel connection"
                : "Disconnect"
              : "Connect to community compute"}
          </Button>
          <p role="status">
            {status.state === "failed"
              ? status.detail
              : running
                ? "Consumer running. A test response confirms a provider is reachable."
                : status.state === "starting"
                  ? "Connecting…"
                  : "Not connected"}
          </p>
          {running && status.apiBaseUrl && (
            <p className="text-body-sm text-secondary">
              Local API: {status.apiBaseUrl}
            </p>
          )}
          <label className="text-label" htmlFor="compute-prompt">
            Test prompt
          </label>
          <textarea
            id="compute-prompt"
            className={styles.input}
            value={prompt}
            maxLength={2000}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <Button
            onClick={() => {
              void test();
            }}
            disabled={!running || pending || !prompt.trim()}
          >
            {pending ? "Waiting for provider…" : "Send test request"}
          </Button>
          {answer && (
            <p
              role="status"
              aria-label="Provider response"
              className="text-body text-primary"
            >
              {answer}
            </p>
          )}
          {(error || sourceError) && <p role="alert">{error || sourceError}</p>}
        </div>
      </div>
    </FullPageSurface>
  );
}
