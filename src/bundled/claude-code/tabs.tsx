import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentViewProps } from "../../features/agents2/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  type Config,
  config as readConfig,
  type ClaudeRuntime,
} from "./runtime";
import type { ClaudeSetup } from "./setup";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const MODELS = [
  {
    label: "Model",
    options: [
      { value: "", label: "Claude Code default" },
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
    ],
  },
];
const SCOPES = [
  {
    label: "Sessions",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];

const RESPOND_TO = [
  {
    label: "Answers",
    options: [
      { value: "owner", label: "Only you" },
      { value: "anyone", label: "Anyone who mentions it" },
    ],
  },
];

/** Claude Code on this computer, and what this agent has running. */
export function ClaudeTab({
  setup,
  runtime,
  agent,
}: AgentViewProps<Config> & { setup: ClaudeSetup; runtime: ClaudeRuntime }) {
  const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const sessions = useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.sessions(agent.pubkey),
    () => [],
  );
  const [code, setCode] = useState("");
  useEffect(() => {
    void setup.check();
  }, [setup]);
  const status = state.status;
  const line = !status
    ? "Checking Claude Code…"
    : status.state === "missing"
      ? "Claude Code is not installed."
      : status.state === "signed-out"
        ? `Claude Code ${status.version} needs you to sign in.`
        : status.state === "ready"
          ? `Claude Code ${status.version} is ready${status.account ? ` (${status.account})` : ""}.`
          : status.message;
  return (
    <div className="flex flex-col gap-4 text-body-sm">
      <section className="flex flex-col gap-2">
        <p role="status" className="m-0">
          {state.checking && status ? "Checking Claude Code…" : line}
        </p>
        <div className="flex flex-wrap gap-2">
          {status?.state === "missing" ? (
            <Button
              loading={state.running === "install"}
              disabled={!!state.running}
              onClick={() => void setup.run("install")}
            >
              Install Claude Code
            </Button>
          ) : null}
          {status?.state === "signed-out" ? (
            <Button
              loading={state.running === "login"}
              disabled={!!state.running}
              onClick={() => void setup.run("login")}
            >
              Sign in
            </Button>
          ) : null}
          {state.running ? (
            <Button variant="ghost" onClick={() => void setup.cancel()}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={state.checking}
              onClick={() => void setup.check()}
            >
              Check again
            </Button>
          )}
        </div>
        {status?.state === "missing" ? (
          <p className="m-0 text-secondary">
            Runs the official installer,{" "}
            <code>curl -fsSL https://claude.ai/install.sh | bash</code>, which
            puts <code>claude</code> in <code>~/.local/bin</code>.
          </p>
        ) : null}
        {state.output ? (
          <pre
            role="log"
            aria-label="Setup output"
            className="m-0 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-surface-sunken p-2 text-caption"
          >
            {state.output}
          </pre>
        ) : null}
        {state.running === "login" ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void setup.answer(code);
              setCode("");
            }}
          >
            <Field
              label="Sign-in code"
              description="If the browser shows a code to paste, enter it here."
            >
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={!code.trim()}>
              Send
            </Button>
          </form>
        ) : null}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="m-0 text-body-sm font-semibold">Running sessions</h3>
        {sessions.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {sessions.map((session) => (
              <li key={session.key} className="flex justify-between gap-2">
                <code className="truncate">{session.key}</code>
                <span className="text-secondary">
                  {session.busy ? "Working" : "Idle"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-secondary">
            None. A conversation's session starts when the agent is mentioned.
          </p>
        )}
      </section>
    </div>
  );
}

/** What the agent runs with. Saving restarts idle sessions with the change. */
export function SettingsTab({ agent, save }: AgentViewProps<Config>) {
  const saved = readConfig(agent.config);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await save({ ...draft, workspace: draft.workspace.trim() || "~/.buzz" });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Select
        variant="field"
        label="Model"
        value={
          MODELS[0]?.options.some((option) => option.value === draft.model)
            ? draft.model
            : ""
        }
        groups={MODELS}
        onValueChange={(model) => setDraft({ ...draft, model })}
      />
      <Field
        label="Workspace"
        description="The folder Claude Code works in. Use ~/ for your home folder."
      >
        <Input
          value={draft.workspace}
          onChange={(event) =>
            setDraft({ ...draft, workspace: event.target.value })
          }
        />
      </Field>
      <Select
        variant="field"
        label="Sessions"
        value={draft.scope}
        groups={SCOPES}
        onValueChange={(scope) =>
          setDraft({
            ...draft,
            scope: scope === "channel" ? "channel" : "thread",
          })
        }
      />
      <Select
        variant="field"
        label="Answers"
        description={
          draft.respondTo === "anyone"
            ? "Claude runs commands on this computer as you, with no approval step. Anyone who can mention it can ask it to."
            : "Messages from anyone else are ignored."
        }
        value={draft.respondTo}
        groups={RESPOND_TO}
        onValueChange={(respondTo) =>
          setDraft({
            ...draft,
            respondTo: respondTo === "anyone" ? "anyone" : "owner",
          })
        }
      />
      <Field
        label="Instructions"
        description="Added to every session's system prompt, after Buzz's own."
      >
        <Textarea
          rows={6}
          value={draft.instructions}
          onChange={(event) =>
            setDraft({ ...draft, instructions: event.target.value })
          }
        />
      </Field>
      {error ? (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="submit"
          variant="primary"
          loading={saving}
          disabled={!changed}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
