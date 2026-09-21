import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  canStopAgent,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentSettingsFields } from "./AgentSettingsFields";
import {
  agentDraft,
  agentEdit,
  agentProcessLabel,
  type AgentDraft,
} from "./agent-edit";

export function AgentEditor({
  agent,
  control,
  state,
  avatar,
  onClose,
}: {
  agent: AgentView;
  control: AgentControl;
  state: AgentControlState;
  avatar?: string | undefined;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = draft ?? agentDraft(agent, state.data?.databricksDefaults);
  const dirty = draft !== null;
  const stale = current.revision !== agent.revision;
  const blocked = state.busy || state.status !== "ready";
  const canClose =
    !state.busy || !!(state.pendingLaunch || state.pendingImport);
  const transitioning =
    agent.status === "starting" || agent.status === "stopping";
  const unapplied =
    agent.runningRevision !== null && agent.runningRevision !== agent.revision;
  const change = (patch: Partial<AgentDraft>) => {
    setDraft({ ...current, ...patch });
    setNotice(null);
    setError(null);
  };
  const act = (action: "start" | "stop" | "restart") => {
    setNotice(null);
    void control.action(agent.id, action).catch(() => {});
  };
  const discard = () => {
    setDraft(null);
    setError(null);
    setNotice(null);
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !dirty && canClose) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="agent-dialog-backdrop" />
        <Dialog.Popup
          data-buzz-ui=""
          className="agent-controls agent-dialog text-body"
        >
          <div className="flex items-center justify-between gap-4">
            <Dialog.Title className="text-heading">Edit agent</Dialog.Title>
            <Button
              aria-label="Close editor"
              disabled={!canClose}
              onClick={onClose}
            >
              ×
            </Button>
          </div>
          <Dialog.Description className="sr-only">
            Edit {agent.name}. Save updates settings without restarting the
            agent.
          </Dialog.Description>
          <div className="agent-editor-layout">
            <aside className="min-w-0 space-y-4">
              <Avatar
                alt={agent.name}
                fallback={agent.name}
                src={avatar ?? null}
                size="large"
              />
              <h3 className="text-heading break-words">{agent.name}</h3>
              <p className="break-all text-body-sm text-secondary">
                {agent.relayUrl}
              </p>
              <details className="space-y-3">
                <summary className="cursor-pointer text-body-sm">
                  Runtime and identity
                </summary>
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h3 className="text-heading break-words">{agent.name}</h3>
                    <p className="text-body-sm text-secondary">
                      {agentProcessLabel(agent)}
                    </p>
                    <p className="text-body-sm text-secondary">
                      {agent.enabled
                        ? state.data?.runtimeAvailable
                          ? "Enabled · starts with buzz-app"
                          : "Enabled intent saved · execution unavailable"
                        : "Stopped · a later sent mention can start this agent"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {agent.status !== "running" && (
                      <Button
                        disabled={
                          blocked ||
                          transitioning ||
                          dirty ||
                          !state.data?.runtimeAvailable
                        }
                        onClick={() => act("start")}
                      >
                        Start
                      </Button>
                    )}
                    <Button
                      disabled={!canStopAgent(state, agent.id)}
                      onClick={() => act("stop")}
                    >
                      Stop
                    </Button>
                    <Button
                      disabled={
                        blocked ||
                        transitioning ||
                        dirty ||
                        !state.data?.runtimeAvailable
                      }
                      onClick={() => act("restart")}
                    >
                      {unapplied ? "Restart to apply" : "Restart"}
                    </Button>
                  </div>
                </header>
                <details className="space-y-2">
                  <summary className="cursor-pointer text-body-sm text-secondary">
                    Exact identity and destination
                  </summary>
                  <p className="break-all font-mono text-mono select-all">
                    {agent.pubkey}
                  </p>
                  <p className="break-all font-mono text-mono">
                    {agent.relayUrl}
                  </p>
                </details>
                <p className="text-body-sm text-secondary">
                  Saved revision {agent.revision} · Running revision{" "}
                  {agent.runningRevision ?? "none"}.
                  {unapplied && " Saved changes are not running yet."} Stop ends
                  current work; a later sent mention can start it again.
                </p>
                {agent.error && (
                  <p role="alert" className="text-red-12">
                    {agent.error}
                  </p>
                )}
              </details>
            </aside>
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (blocked || !dirty || stale) return;
                let edit: ReturnType<typeof agentEdit>;
                try {
                  edit = agentEdit(current);
                } catch (problem) {
                  setError((problem as Error).message);
                  return;
                }
                void control
                  .save(agent.id, current.revision, edit)
                  .then(() => {
                    setDraft(null);
                    setError(null);
                    setNotice("Saved. Running work was not restarted.");
                  })
                  .catch(() => {});
              }}
            >
              <AgentSettingsFields
                id={agent.id}
                savedRevision={agent.revision}
                draft={current}
                control={control}
                state={state}
                disabled={state.busy}
                environmentKeys={agent.harness.environmentKeys}
                onChange={change}
              />
              {state.error && (
                <p role="alert" className="text-red-12">
                  {state.error}
                </p>
              )}
              {state.status === "error" && (
                <Button onClick={() => void control.refresh()}>
                  Retry status
                </Button>
              )}
              {stale && (
                <p role="alert" className="text-red-12">
                  The host has a newer saved revision. Your edits are still
                  here; copy anything you need, then discard to load the latest
                  settings.
                </p>
              )}
              {error && (
                <p role="alert" className="text-red-12">
                  {error}
                </p>
              )}
              <div className="agent-editor-footer">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={blocked || !dirty || stale}
                >
                  Save changes
                </Button>
                <Button disabled={!canClose} onClick={onClose}>
                  Cancel
                </Button>
                {stale && (
                  <Button disabled={state.busy} onClick={discard}>
                    Discard changes
                  </Button>
                )}
              </div>
              {notice && (
                <p role="status" className="text-secondary">
                  {notice}
                </p>
              )}
            </form>
          </div>
          {!!agent.diagnostics.length && (
            <details className="space-y-2">
              <summary className="cursor-pointer text-body-sm text-secondary">
                Host diagnostics
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-mono text-mono-sm">
                {agent.diagnostics.join("\n")}
              </pre>
            </details>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
