import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";
import { AgentEditor } from "./AgentEditor";
import { AgentImport } from "./AgentImport";
import "./AgentControls.css";

/** No relay dependency. Page lifetime owns observation only, never native execution. */
export function AgentControlPanel({
  control,
  children,
}: {
  control: AgentControl;
  children?: (
    state: AgentControlState,
    edit: (agent: AgentView, avatar?: string) => void,
  ) => ReactNode;
}) {
  const [selected, setSelected] = useState<{
    id: string;
    avatar?: string;
  } | null>(null);
  const edit = (agent: AgentView, avatar?: string) =>
    setSelected({ id: agent.id, ...(avatar ? { avatar } : {}) });
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
  const editing = state.data?.agents.find((agent) => agent.id === selected?.id);
  return (
    <section
      data-buzz-ui=""
      aria-label="Local agent controls"
      className="agent-controls min-w-0 space-y-5 pt-4 text-body text-primary"
    >
      <details className="space-y-4">
        <summary className="cursor-pointer text-body-sm text-secondary">
          Manage local agents
        </summary>
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

        <p className="text-secondary">
          When execution is available, enabled agents start with buzz-app. Their
          workers wake for accepted mentions and sleep when idle. Leaving this
          page does not stop native processes; unavailable execution stays
          blocked.
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
                You can still request Stop for these agents. Disabled settings
                and process shutdown are unconfirmed until the host succeeds.
              </p>
            )}
            <AgentImport
              control={control}
              commitAvailable={state.data.importAvailable !== false}
              disabled={state.busy || state.status !== "ready"}
            />
            {!state.data.agents.length && (
              <p>
                No local agents yet. Preview a Buzz library to inspect exact
                identities. Import is available only after native acceptance.
              </p>
            )}
          </>
        )}
      </details>
      {children ? (
        children(state, edit)
      ) : (
        <div className="agent-grid">
          {state.data?.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              name={agent.name}
              identities={[agent]}
              editable={[agent]}
              onEdit={edit}
            />
          ))}
        </div>
      )}
      {editing && (
        <AgentEditor
          key={editing.id}
          agent={editing}
          control={control}
          state={state}
          avatar={selected?.avatar}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
