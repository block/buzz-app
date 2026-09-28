import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelayData } from "../../features/relay/service";

type Status = {
  available: boolean;
  state: string;
  name?: string;
  pubkey?: string;
  detail?: string;
};
type ComputeStatus = {
  available: boolean;
  generation: number;
  state: string;
  mode: string | null;
  community: string | null;
  viewer: string | null;
  detail?: string | null;
};
async function waitForConsumerSession(
  community: string,
  viewer: string,
  initial: ComputeStatus,
) {
  let current = initial;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      current.available &&
      current.state === "running" &&
      current.mode === "client" &&
      current.community === community &&
      current.viewer === viewer
    )
      return;
    if (current.state === "failed")
      throw new Error(current.detail || "Could not connect to shared compute.");
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await invoke<ComputeStatus>("community_compute_status");
  }
  throw new Error(
    "Shared compute is still connecting. Try starting Moonpal again shortly.",
  );
}
export function useAgentRunner(relay: RelayData) {
  const session = useSyncExternalStore(
    relay.subscribe,
    relay.snapshot,
    relay.snapshot,
  );
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await invoke<Status>("agent_runner_status");
        if (!disposed) setStatus(next);
      } catch {
        if (!disposed) setError("Could not read the local agent runner.");
      } finally {
        if (!disposed) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const run = async (start: boolean) => {
    setPending(true);
    setError(undefined);
    try {
      if (start && session.status === "ready") {
        const compute = await invoke<ComputeStatus>("community_compute_status");
        const matchesSession =
          compute.available &&
          compute.state === "running" &&
          compute.mode === "client" &&
          compute.community === session.community &&
          compute.viewer === session.viewer;
        if (!matchesSession) {
          if (compute.state !== "off") {
            await invoke("community_compute_stop", {
              generation: compute.generation,
            });
          }
          await invoke("community_compute_start", {
            request: {
              mode: "client",
              modelId: "remote",
              maxVramGb: null,
              community: session.community,
              viewer: session.viewer,
            },
          });
          await waitForConsumerSession(
            session.community!,
            session.viewer!,
            compute,
          );
        }
      }
      setStatus(
        await invoke<Status>(
          start ? "agent_runner_start" : "agent_runner_stop",
          start ? { viewer: session.viewer, community: session.community } : {},
        ),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  };
  return { status, pending, error, run, canStart: session.status === "ready" };
}
export type AgentRunnerControls = ReturnType<typeof useAgentRunner>;
export function AgentRunner({
  controls,
  pubkeys,
}: {
  controls: AgentRunnerControls;
  pubkeys: readonly string[];
}) {
  const { status, pending, error, run, canStart } = controls;
  if (!status?.available || !status.pubkey || !pubkeys.includes(status.pubkey))
    return null;
  return (
    <section aria-label="Local agent runner" className="mt-3 space-y-3">
      <p className="m-0 text-body-sm text-secondary">Shared compute</p>
      <p role="status" className="m-0 text-body">
        {pending
          ? "Updating runner…"
          : status.state === "running"
            ? "Runner started in this app"
            : status.state === "failed"
              ? "Runner stopped unexpectedly"
              : "Stopped"}
      </p>
      {status.detail && (
        <p className="m-0 text-body text-secondary">{status.detail}</p>
      )}
      {error && (
        <p role="alert" className="m-0 text-body">
          {error}
        </p>
      )}
      <Button
        disabled={pending || (status.state !== "running" && !canStart)}
        onClick={() => void run(status.state !== "running")}
      >
        {status.state === "running" ? "Stop agent" : "Start agent"}
      </Button>
    </section>
  );
}
