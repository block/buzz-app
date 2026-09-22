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
import { PlusIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { AgentCard } from "./AgentCard";
import { AgentEditor } from "./AgentEditor";
import { AgentImport } from "./AgentImport";
import { AgentCreateDialog } from "./AgentCreateDialog";
import "./AgentControls.css";

/** No relay dependency. Page lifetime owns observation only, never native execution. */
export function AgentControlPanel({
  control,
  importDestination = "",
  createOwner,
  children,
}: {
  control: AgentControl;
  importDestination?: string;
  createOwner?: string | undefined;
  children?: (
    state: AgentControlState,
    edit: (agent: AgentView, avatar?: string) => void,
    importedId: string | null,
  ) => ReactNode;
}) {
  const [adding, setAdding] = useState<{
    destination: string;
    owner: string;
  } | null>(null);
  const [importSections, setImportSections] = useState<string[]>([]);
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
      className="agent-controls flex min-w-0 flex-col gap-section-gap text-body text-primary"
    >
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="m-0 text-title">Agents</h1>
          <p className="m-0 text-body-sm text-secondary">
            Manage your agents and bring them into a conversation.
          </p>
        </div>
        {state.data && (
          <Button
            variant="primary"
            aria-haspopup="dialog"
            onClick={() =>
              setAdding({
                destination: importDestination,
                owner: createOwner ?? "",
              })
            }
          >
            <PlusIcon size={16} aria-hidden="true" />
            Add agent
          </Button>
        )}
      </header>
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
      {state.data && (
        <Accordion
          variant="activity"
          value={importSections}
          onValueChange={setImportSections}
          items={[
            {
              value: "old-buzz",
              title: "Not imported from old Buzz",
              content: importSections.includes("old-buzz") ? (
                <AgentImport
                  key={importDestination}
                  control={control}
                  initialDestination={importDestination}
                  managedAgents={state.data.agents}
                  commitAvailable={
                    state.status === "ready" &&
                    state.data.importAvailable !== false
                  }
                  disabled={state.busy}
                  onImported={(agents) => {
                    setImportedId(agents[0]?.id ?? null);
                    setImportSections([]);
                  }}
                />
              ) : null,
            },
          ]}
        />
      )}
      {adding && (
        <AgentCreateDialog
          control={control}
          state={state}
          destination={adding.destination}
          owner={adding.owner}
          onClose={() => setAdding(null)}
        />
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
