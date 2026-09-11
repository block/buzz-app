import { useEffect, useSyncExternalStore } from "react";
import type { AgentControl } from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentEditor } from "./AgentEditor";
import { AgentImport } from "./AgentImport";
import "./AgentControls.css";

/** No relay dependency. Page lifetime owns observation only, never native execution. */
export function AgentControlPanel({ control }: { control: AgentControl }) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  useEffect(() => {
    void control.refresh();
    const timer = setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        control.snapshot().status === "ready"
      )
        void control.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [control]);
  return (
    <section
      data-buzz-ui=""
      aria-label="Local agent controls"
      className="agent-controls min-w-0 space-y-5 rounded-xl bg-panel p-5 text-body text-primary"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title">Local agents</h2>
        {state.status !== "unavailable" && (
          <Button
            disabled={state.busy || state.status === "loading"}
            onClick={() => {
              void control.refresh();
            }}
          >
            {state.status === "error" ? "Retry status" : "Refresh status"}
          </Button>
        )}
      </header>
      <p className="text-secondary">
        Enabled agents start with buzz-app. Their workers wake for accepted
        mentions and sleep when idle. Keep buzz-app open; leaving this page does
        not stop them.
      </p>
      {(state.status === "idle" || state.status === "loading") && (
        <p role="status">Reading local agent status…</p>
      )}
      {state.error && (
        <p
          role={state.status === "unavailable" ? "status" : "alert"}
          className={
            state.status === "unavailable" ? "text-secondary" : "text-red-12"
          }
        >
          {state.error}
        </p>
      )}
      {state.busy && <p role="status">Waiting for the host to confirm…</p>}
      {state.data && (
        <>
          {!state.data.runtimeAvailable && (
            <p role="status" className="text-amber-12">
              {state.data.runtimeMessage ||
                "The bundled agent runtime is unavailable. You can still edit saved settings."}
            </p>
          )}
          {state.status === "error" && (
            <p className="text-body-sm text-secondary">
              Showing the last host snapshot; process status may have changed.
            </p>
          )}
          <AgentImport
            control={control}
            disabled={state.busy || state.status !== "ready"}
          />
          {!state.data.agents.length && (
            <p>
              No local agents yet. Preview a Buzz library to import exact
              identities.
            </p>
          )}
          {state.data.agents.map((agent) => (
            <AgentEditor
              key={agent.id}
              agent={agent}
              control={control}
              state={state}
            />
          ))}
        </>
      )}
    </section>
  );
}
