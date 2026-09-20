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
    importedId: string | null,
  ) => ReactNode;
}) {
  const [importedId, setImportedId] = useState<string | null>(null);
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
  useEffect(() => {
    if (
      state.data?.agents.some(
        (agent) => agent.id === importedId && agent.enabled,
      )
    )
      setImportedId(null);
  }, [state.data, importedId]);
  const editing = state.data?.agents.find((agent) => agent.id === selected?.id);
  return (
    <section
      data-buzz-ui=""
      aria-label="Local agent controls"
      className="agent-controls min-w-0 space-y-5 text-body text-primary"
    >
      {state.data && (
        <details className="space-y-4">
          <summary className="cursor-pointer text-label">Add agent</summary>
          <p className="text-secondary">
            Import an existing agent from old Buzz. Creating a new agent is not
            available yet. Imported agents stay stopped until you start them.
          </p>
          <AgentImport
            control={control}
            commitAvailable={state.data.importAvailable !== false}
            disabled={state.busy || state.status !== "ready"}
            onImported={(agents) => setImportedId(agents[0]?.id ?? null)}
          />
        </details>
      )}
      {children ? (
        children(state, edit, importedId)
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
      {(state.status === "idle" || state.status === "loading") && (
        <p role="status">Reading local agent status…</p>
      )}
      {state.error && (
        <p role={state.status === "unavailable" ? "status" : "alert"}>
          {state.error}
        </p>
      )}
      {state.status === "error" && state.data && (
        <p className="text-body-sm text-secondary">
          Showing the last host snapshot. Current process state and durable
          enabled intent are unconfirmed.
        </p>
      )}
      {state.status === "error" && (
        <Button onClick={() => void control.refresh()}>Retry status</Button>
      )}
      {state.busy && <p role="status">Waiting for the host to confirm…</p>}
      <details className="space-y-3">
        <summary className="cursor-pointer text-body-sm text-secondary">
          Manage local agents
        </summary>
        <Button
          disabled={
            state.busy ||
            state.status === "loading" ||
            state.status === "unavailable"
          }
          onClick={() => void control.refresh()}
        >
          Refresh status
        </Button>
        <p className="text-body-sm text-secondary">
          Enabled agents start with this app. Stop disables future wake and
          stops active work. Leaving this page does not stop agents.
        </p>
        {state.data && !state.data.runtimeAvailable && (
          <p role="status">
            {state.data.runtimeMessage ||
              "The bundled agent runtime is unavailable. You can still edit saved settings."}
          </p>
        )}
      </details>
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
