// The type's tabs: Claude Code's setup on this computer, and the agent's
// settings.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import type { Transcript } from "../../features/agents/activity-transcript";
import type { AgentViewProps } from "../../features/agents2/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  type ClaudeRuntime,
  type Config,
  config as readConfig,
  type SavedConversation,
} from "./runtime";
import type { ClaudeSetup } from "./setup";
import { TURN_LIMIT } from "./transcript";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const label = ({ channelId, name, root }: SavedConversation) =>
  `${name ? `#${name}` : channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
type Read =
  | { status: "ready"; transcript: Transcript & { more: boolean } }
  | { status: "missing" }
  | { status: "error"; error: string };

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
const MODEL_CHOICES = [
  ["", "Claude Code default"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
] as const;
const MODELS = options(MODEL_CHOICES);
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);
const RESPOND_TO = options([
  ["owner", "Only you"],
  ["anyone", "Anyone who mentions it"],
]);

export function createTabs({
  setup,
  runtime,
}: Readonly<{ setup: ClaudeSetup; runtime: ClaudeRuntime }>) {
  /** One conversation's session file, read on open and on Refresh. A refresh
   * keeps the last result in place until the new one arrives. */
  function TranscriptView({
    agent,
    conversation,
    working,
    onBack,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation: SavedConversation;
    working: boolean;
    onBack(): void;
  }) {
    const workspace = readConfig(agent.config).workspace;
    const [read, setRead] = useState<Read>();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // A turn ending rereads, so its last steps show without a Refresh.
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      void runtime
        .transcript(conversation, workspace, working, abort.signal)
        .then(
          (transcript): Read =>
            transcript
              ? { status: "ready", transcript }
              : { status: "missing" },
          (reason): Read => ({ status: "error", error: message(reason) }),
        )
        .then((next) => {
          if (abort.signal.aborted) return;
          setRead(next);
          setLoading(false);
        });
      return () => abort.abort();
    }, [conversation, workspace, working, attempt]);
    return (
      <div className="grid gap-4">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button
            variant="ghost"
            loading={loading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
        <h3 className="m-0 text-body">{label(conversation)}</h3>
        {!read ? (
          <p role="status" className="m-0">
            Reading the Claude Code session…
          </p>
        ) : read.status === "missing" ? (
          <p className="m-0 text-body-sm text-subtle">
            Claude Code has no transcript for this conversation on this
            computer. It may have been deleted, or the session ran in a
            different workspace.
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the Claude Code session: {read.error}
          </p>
        ) : (
          <ActivityTranscript
            transcript={read.transcript}
            agentName={agent.name}
            state={() => (working ? "working" : undefined)}
            before={
              read.transcript.more && (
                <p className="m-0 text-body-sm text-subtle">
                  Showing the latest {TURN_LIMIT} turns.
                </p>
              )
            }
          />
        )}
      </div>
    );
  }

  /** Claude Code on this computer, and this agent's conversations. */
  function ClaudeTab({ agent }: AgentViewProps<Config>) {
    const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
    const sessions = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.pubkey),
    );
    // Read on each render: bindings change as turns start, which also
    // changes the session list this tab subscribes to.
    const conversations = runtime.conversations(agent.pubkey);
    const busy = new Map(
      sessions.map((session) => [session.key, session.busy]),
    );
    const [open, setOpen] = useState<SavedConversation>();
    const [code, setCode] = useState("");
    useEffect(() => {
      void setup.check();
    }, []);
    if (open)
      return (
        <TranscriptView
          agent={agent}
          conversation={open}
          working={busy.get(open.key) ?? false}
          onBack={() => setOpen(undefined)}
        />
      );
    const status = state.status;
    const line =
      !status || state.checking
        ? "Checking Claude Code…"
        : status.state === "missing"
          ? "Claude Code is not installed."
          : status.state === "signed-out"
            ? `Claude Code ${status.version} needs you to sign in.`
            : status.state === "ready"
              ? `Claude Code ${status.version} is ready${status.account ? ` (${status.account})` : ""}.`
              : status.message;
    // One button per slot, so focus stays put as Install becomes Sign in and
    // Cancel becomes Check again.
    const action =
      status?.state === "missing"
        ? ({ step: "install", label: "Install Claude Code" } as const)
        : status?.state === "signed-out"
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
    return (
      <div className="grid gap-4">
        <section className="grid gap-2">
          <p role="status" className="m-0">
            {line}
          </p>
          <div className="flex flex-wrap gap-2">
            {action && (
              <Button
                variant="prominent"
                loading={state.running === action.step}
                disabled={!!state.running && state.running !== action.step}
                onClick={() => void setup.run(action.step)}
              >
                {action.label}
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={!state.running && state.checking}
              focusableWhenDisabled
              onClick={() =>
                void (state.running ? setup.cancel() : setup.check())
              }
            >
              {state.running ? "Cancel" : "Check again"}
            </Button>
          </div>
          {status?.state === "missing" && (
            <p className="m-0 text-body-sm text-subtle">
              Runs the official installer,{" "}
              <code>curl -fsSL https://claude.ai/install.sh | bash</code>, which
              puts <code>claude</code> in <code>~/.local/bin</code>.
            </p>
          )}
          {state.output && (
            <pre
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-caption"
            >
              {state.output}
            </pre>
          )}
          {state.running === "login" && (
            <form
              className="flex items-end gap-2"
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
                <Input value={code} onValueChange={setCode} />
              </Field>
              <Button type="submit" disabled={!code.trim()}>
                Send
              </Button>
            </form>
          )}
        </section>
        <section className="grid gap-1">
          <h3 className="m-0 text-body">Conversations</h3>
          {conversations.length ? (
            <ul className="m-0 grid list-none gap-2 p-0">
              {conversations.map((conversation) => {
                const running = busy.get(conversation.key);
                return (
                  <li
                    key={conversation.key}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">
                        {label(conversation)}
                      </span>
                      <span className="block text-body-sm text-subtle">
                        {[
                          running === undefined
                            ? undefined
                            : running
                              ? "Working"
                              : "Idle",
                          new Date(conversation.at).toLocaleString(),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      onClick={() => setOpen(conversation)}
                    >
                      View transcript
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation's session starts when the agent is mentioned.
            </p>
          )}
        </section>
      </div>
    );
  }

  /** What the agent runs with. Saving restarts idle sessions with the change. */
  function SettingsTab({ agent, save }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          workspace: draft.workspace.trim() || "~/.buzz",
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    const model = MODEL_CHOICES.some(([value]) => value === draft.model)
      ? draft.model
      : "";
    return (
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Select
          label="Model"
          variant="field"
          value={model}
          groups={MODELS}
          onValueChange={(value) => setDraft({ ...draft, model: value })}
        />
        <Field
          label="Workspace"
          description="The folder Claude Code works in. Use ~/ for your home folder."
        >
          <Input
            value={draft.workspace}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <Select
          label="Sessions"
          variant="field"
          value={draft.scope}
          groups={SCOPES}
          onValueChange={(value) =>
            setDraft({
              ...draft,
              scope: value === "channel" ? "channel" : "thread",
            })
          }
        />
        <Select
          label="Answers"
          variant="field"
          value={draft.respondTo}
          groups={RESPOND_TO}
          description={
            draft.respondTo === "anyone"
              ? "Claude runs commands on this computer as you, with no approval step. Anyone who can mention it can ask it to."
              : "Messages from anyone else are ignored."
          }
          onValueChange={(value) =>
            setDraft({
              ...draft,
              respondTo: value === "anyone" ? "anyone" : "owner",
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
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
        <div>
          {/* Stays focusable while saving and once there is nothing to save. */}
          <Button
            type="submit"
            variant="prominent"
            loading={saving}
            disabled={!changed}
            focusableWhenDisabled
          >
            Save
          </Button>
        </div>
      </form>
    );
  }

  return { ClaudeTab, SettingsTab };
}
