import { useState } from "react";
import {
  canStopAgent,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentEnvironmentEditor } from "./AgentEnvironmentEditor";
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
}: {
  agent: AgentView;
  control: AgentControl;
  state: AgentControlState;
}) {
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = draft ?? agentDraft(agent);
  const dirty = draft !== null;
  const stale = current.revision !== agent.revision;
  const blocked = state.busy || state.status !== "ready";
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
    <article
      aria-label={`Manage ${agent.name}`}
      className="min-w-0 space-y-4 border-t border-primary py-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-heading break-words">{agent.name}</h3>
          <p className="text-body-sm text-secondary">
            {agentProcessLabel(agent)}
          </p>
          <p className="text-body-sm text-secondary">
            {agent.enabled
              ? "Enabled · starts with buzz-app"
              : "Disabled · mentions will not wake this agent"}
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
              blocked || transitioning || dirty || !state.data?.runtimeAvailable
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
        <p className="break-all font-mono text-mono">{agent.relayUrl}</p>
      </details>
      <p className="text-body-sm text-secondary">
        Saved revision {agent.revision} · Running revision{" "}
        {agent.runningRevision ?? "none"}.
        {unapplied && " Saved changes are not running yet."} Stop disables
        future wake and stops active work.
      </p>
      {agent.error && (
        <p role="alert" className="text-red-12">
          {agent.error}
        </p>
      )}
      <details className="space-y-4">
        <summary className="cursor-pointer text-body font-semibold">
          Edit agent and harness{dirty ? " · Unsaved changes" : ""}
        </summary>
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
          <fieldset disabled={state.busy} className="min-w-0 space-y-4">
            <label className="agent-control-field">
              Name
              <input
                value={current.name}
                onChange={(event) => change({ name: event.target.value })}
              />
            </label>
            <label className="agent-control-field">
              System prompt
              <textarea
                rows={6}
                value={current.systemPrompt}
                onChange={(event) =>
                  change({ systemPrompt: event.target.value })
                }
              />
            </label>
            <label className="agent-control-field">
              Workspace
              <input
                value={current.workspace}
                spellCheck={false}
                onChange={(event) => change({ workspace: event.target.value })}
              />
            </label>
            <h4 className="text-heading">Harness</h4>
            <p className="text-body-sm text-secondary">
              The executable runs with your account’s access. Arguments are
              passed literally, not through a shell.
            </p>
            <label className="agent-control-field">
              Executable
              <input
                value={current.command}
                spellCheck={false}
                onChange={(event) => change({ command: event.target.value })}
              />
            </label>
            <label className="agent-control-field">
              Arguments (JSON array)
              <textarea
                rows={3}
                value={current.args}
                spellCheck={false}
                onChange={(event) => change({ args: event.target.value })}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="agent-control-field">
                Model
                <input
                  value={current.model}
                  onChange={(event) => change({ model: event.target.value })}
                />
              </label>
              <label className="agent-control-field">
                Provider
                <input
                  value={current.provider}
                  onChange={(event) => change({ provider: event.target.value })}
                />
              </label>
            </div>
            <p className="text-body-sm text-secondary">
              Saved environment overrides take precedence over Model and
              Provider: BUZZ_AGENT_MODEL / BUZZ_AGENT_PROVIDER for buzz-agent,
              GOOSE_MODEL / GOOSE_PROVIDER for Goose. Blank selectors do not
              clear those overrides. ACP uses the same effective model.
            </p>
          </fieldset>
          <AgentEnvironmentEditor
            keys={agent.harness.environmentKeys}
            patch={current.environment}
            disabled={state.busy}
            onChange={(environment) => change({ environment })}
          />
          {stale && (
            <p role="alert" className="text-red-12">
              The host has a newer saved revision. Your edits are still here;
              copy anything you need, then discard to load the latest settings.
            </p>
          )}
          {error && (
            <p role="alert" className="text-red-12">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={blocked || !dirty || stale}
            >
              Save changes
            </Button>
            <Button disabled={state.busy || !dirty} onClick={discard}>
              Discard changes
            </Button>
            <span className="text-body-sm text-secondary">
              Save does not restart. Restart applies saved settings.
            </span>
          </div>
          {notice && (
            <p role="status" className="text-secondary">
              {notice}
            </p>
          )}
        </form>
      </details>
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
    </article>
  );
}
