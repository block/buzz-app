import { Dialog } from "@base-ui/react/dialog";
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
  CloneSettings,
  ImportSource,
} from "../../features/agents/control";
import { PlusIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { AgentCard } from "./AgentCard";
import { AgentEditor } from "./AgentEditor";
import { LocalInventoryAction } from "./LocalInventoryAction";
import { relayOrigin } from "../../features/communities/destination";
import { AgentImport } from "./AgentImport";
import { AgentCreateDialog } from "./AgentCreateDialog";
import "./AgentControls.css";

/** No relay dependency. Page lifetime owns observation only, never native execution. */
export function AgentControlPanel({
  control,
  unifiedInventory = false,
  importDestination = "",
  createOwner,
  children,
}: {
  control: AgentControl;
  unifiedInventory?: boolean;
  importDestination?: string;
  createOwner?: string | undefined;
  children?: (
    state: AgentControlState,
    edit: (agent: AgentView, avatar?: string) => void,
    importedId: string | null,
    onUseHere: (
      pubkey: string,
      action: "use" | "clone",
      source?: ImportSource,
    ) => void,
    onImport: (pubkey: string, source?: ImportSource) => void,
  ) => ReactNode;
}) {
  const [adding, setAdding] = useState<{
    destination: string;
    owner: string;
    initialSettings?: CloneSettings;
  } | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const [handover, setHandover] = useState<{
    pubkey: string;
    action: "use" | "clone";
    destination: string;
    source?: ImportSource;
  } | null>(null);
  useEffect(() => {
    // A handover belongs to the community in which its action was selected.
    setHandover((current) =>
      current?.destination === importDestination ? current : null,
    );
  }, [importDestination]);
  const [importSelection, setImportSelection] = useState<{
    destination: string;
    trigger: HTMLElement | null;
    pubkey: string;
    name: string;
    source?: ImportSource;
  } | null>(null);
  useEffect(() => {
    setImportSelection((current) =>
      current?.destination === importDestination ? current : null,
    );
  }, [importDestination]);
  const [importSections, setImportSections] = useState<string[]>([]);
  const [importedId, setImportedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    id: string;
    avatar?: string;
  } | null>(null);
  const edit = (agent: AgentView, avatar?: string) =>
    setSelected({ id: agent.id, ...(avatar ? { avatar } : {}) });
  const nativeState = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  const state = localPending
    ? { ...nativeState, busy: true, pendingCredentialWrite: true }
    : nativeState;
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
  const localSource =
    handover &&
    (state.data?.agents.find(
      (agent) =>
        agent.pubkey === handover.pubkey &&
        !!agent.relayUrl &&
        !!handover.destination &&
        relayOrigin(agent.relayUrl) === relayOrigin(handover.destination),
    ) ??
      state.data?.agents.find((agent) => agent.pubkey === handover.pubkey));
  const editing = state.data?.agents.find((agent) => agent.id === selected?.id);
  const importForm = state.data ? (
    <AgentImport
      key={`${importDestination}:${importSelection?.pubkey}:${importSelection?.source}`}
      control={control}
      initialSource={importSelection?.source ?? "installed"}
      selectedPubkey={importSelection?.pubkey}
      selectedName={importSelection?.name}
      onCancel={() => setImportSelection(null)}
      initialDestination={importDestination}
      managedAgents={state.data.agents}
      commitAvailable={
        state.status === "ready" && state.data.importAvailable !== false
      }
      disabled={state.busy}
      onClone={
        control.cloneSettings && createOwner && importDestination
          ? (initialSettings) => {
              setImportSelection(null);
              setAdding({
                destination: importDestination,
                owner: createOwner,
                initialSettings,
              });
            }
          : undefined
      }
      onImported={(agents) => {
        setImportedId(agents[0]?.id ?? null);
        setImportSections([]);
        setImportSelection(null);
      }}
    />
  ) : null;
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
            disabled={localPending}
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
        children(
          state,
          edit,
          importedId,
          (pubkey, action, source) =>
            setHandover({
              pubkey,
              action,
              destination: importDestination,
              ...(source ? { source } : {}),
            }),
          (pubkey, source) => {
            setImportSelection({
              destination: importDestination,
              trigger:
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null,
              pubkey,
              name:
                state.data?.parked?.find((agent) => agent.pubkey === pubkey)
                  ?.name ?? "agent",
              ...(source ? { source } : {}),
            });
            setImportSections(["old-buzz"]);
          },
        )
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
      {state.data &&
        !importSelection &&
        (!unifiedInventory || state.data.parked === undefined) && (
          <Accordion
            variant="activity"
            value={importSections}
            onValueChange={setImportSections}
            items={[
              {
                value: "old-buzz",
                title: "Import from another installation",
                content: importSections.includes("old-buzz")
                  ? importForm
                  : null,
              },
            ]}
          />
        )}
      {state.data?.parked !== undefined &&
        importSelection &&
        importSelection.destination === importDestination && (
          <Dialog.Root
            open
            modal={!state.pendingCredentialWrite}
            disablePointerDismissal
            onOpenChange={(open, details) => {
              if (!open && state.busy) details.cancel();
              else if (!open) setImportSelection(null);
            }}
          >
            <Dialog.Portal>
              {!state.pendingCredentialWrite && (
                <Dialog.Backdrop
                  data-buzz-ui=""
                  className="buzz-dialog-backdrop"
                />
              )}
              <Dialog.Popup
                data-buzz-ui=""
                className="buzz-dialog agent-controls text-body"
                finalFocus={() => importSelection.trigger}
                aria-modal={!state.pendingCredentialWrite}
              >
                {importForm}
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      {state.data && handover && handover.destination === importDestination && (
        <Dialog.Root
          open
          modal={false}
          onOpenChange={(open) => {
            if (!open && !state.busy) setHandover(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Popup
              data-buzz-ui=""
              className="agent-controls agent-dialog text-body"
            >
              <Dialog.Title className="text-heading">
                {handover.action === "use"
                  ? "Set up agent here"
                  : "Review agent to clone"}
              </Dialog.Title>
              <Dialog.Description className="text-body-sm text-secondary">
                {handover.action === "use"
                  ? "Set up the imported agent in this community. It will not start yet."
                  : "Create a new agent from the saved name and instructions. The new agent gets a new key and does not join any channels automatically."}
              </Dialog.Description>
              {(localSource && state.data.localInventoryActions) ||
              handover.source ? (
                <LocalInventoryAction
                  key={`${handover.pubkey}:${handover.action}:${handover.destination}:${createOwner}`}
                  control={control}
                  agent={localSource || undefined}
                  pubkey={handover.pubkey}
                  source={handover.source}
                  action={handover.action}
                  destination={handover.destination}
                  owner={createOwner ?? ""}
                  disabled={nativeState.busy || state.status !== "ready"}
                  onPending={setLocalPending}
                  onUsed={() => setHandover(null)}
                  onClone={(initialSettings) => {
                    setHandover(null);
                    setAdding({
                      destination: importDestination,
                      owner: createOwner ?? "",
                      initialSettings,
                    });
                  }}
                />
              ) : (
                <p>
                  This app cannot set up this agent yet. Import it first. If it
                  is already imported, update and restart the desktop app.
                </p>
              )}
              <Button disabled={state.busy} onClick={() => setHandover(null)}>
                Close
              </Button>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      {adding && (
        <AgentCreateDialog
          control={control}
          state={state}
          destination={adding.destination}
          owner={adding.owner}
          initialSettings={adding.initialSettings}
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
          Showing the last known agent status. Refresh to check which agents are
          running and which will start with this app.
        </p>
      )}
      {state.status === "error" && (
        <Button onClick={() => void control.refresh()}>Retry status</Button>
      )}
      {state.busy && <p role="status">Waiting for the desktop app…</p>}
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
