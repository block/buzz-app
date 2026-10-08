// The type's tabs, built with the host's React (`ctx.react`): an installed
// plugin cannot bundle its own copy, so these are plain elements wearing the
// host's shared control classes rather than design-system components.
import type * as ReactModule from "react";
import type { ReactNode } from "react";
import type { AgentViewProps } from "../../features/agents2/service";
import {
  type ClaudeRuntime,
  type Config,
  config as readConfig,
} from "./runtime";
import type { ClaudeSetup } from "./setup";

type React = typeof ReactModule;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const MODELS = [
  ["", "Claude Code default"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
] as const;
const SCOPES = [
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
] as const;
const RESPOND_TO = [
  ["owner", "Only you"],
  ["anyone", "Anyone who mentions it"],
] as const;

export function createTabs(
  React: React,
  { setup, runtime }: Readonly<{ setup: ClaudeSetup; runtime: ClaudeRuntime }>,
) {
  const h = React.createElement;

  const button = (
    label: string,
    props: Readonly<{
      onClick?: () => void;
      disabled?: boolean;
      busy?: boolean;
      variant?: "prominent" | "ghost" | "secondary";
      type?: "button" | "submit";
    }>,
  ) =>
    h(
      "button",
      {
        type: props.type ?? "button",
        disabled: props.disabled || props.busy,
        "aria-busy": props.busy || undefined,
        onClick: props.onClick,
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": props.variant ?? "secondary",
        "data-size": "md",
      },
      h("span", { className: "buzz-button-label" }, label),
    );
  const field = (
    id: string,
    label: string,
    control: ReactNode,
    description?: string,
  ) =>
    h(
      "div",
      { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { htmlFor: id, className: "buzz-field-label" }, label),
      control,
      description
        ? h("p", { className: "buzz-field-description" }, description)
        : null,
    );
  const choice = (
    id: string,
    value: string,
    options: readonly (readonly [string, string])[],
    onChange: (value: string) => void,
  ) =>
    h(
      "select",
      {
        id,
        value,
        "data-buzz-ui": "",
        "data-size": "md",
        className: "buzz-input",
        onChange: (event: { target: { value: string } }) =>
          onChange(event.target.value),
      },
      options.map(([option, label]) =>
        h("option", { key: option, value: option }, label),
      ),
    );

  /** Claude Code on this computer, and what this agent has running. */
  function ClaudeTab({ agent }: AgentViewProps<Config>) {
    const state = React.useSyncExternalStore(setup.subscribe, setup.snapshot);
    const sessions = React.useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.pubkey),
    );
    const [code, setCode] = React.useState("");
    React.useEffect(() => {
      void setup.check();
    }, []);
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
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-4, 1rem)" } },
      h(
        "section",
        { style: { display: "grid", gap: "var(--space-2, 0.5rem)" } },
        h("p", { role: "status", style: { margin: 0 } }, line),
        h(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: "0.5rem" } },
          status?.state === "missing"
            ? button("Install Claude Code", {
                variant: "prominent",
                busy: state.running === "install",
                disabled: !!state.running,
                onClick: () => void setup.run("install"),
              })
            : null,
          status?.state === "signed-out"
            ? button("Sign in", {
                variant: "prominent",
                busy: state.running === "login",
                disabled: !!state.running,
                onClick: () => void setup.run("login"),
              })
            : null,
          state.running
            ? button("Cancel", {
                variant: "ghost",
                onClick: () => void setup.cancel(),
              })
            : button("Check again", {
                variant: "ghost",
                disabled: state.checking,
                onClick: () => void setup.check(),
              }),
        ),
        status?.state === "missing"
          ? h(
              "p",
              { className: "buzz-field-description", style: { margin: 0 } },
              "Runs the official installer, ",
              h("code", null, "curl -fsSL https://claude.ai/install.sh | bash"),
              ", which puts ",
              h("code", null, "claude"),
              " in ",
              h("code", null, "~/.local/bin"),
              ".",
            )
          : null,
        state.output
          ? h(
              "pre",
              {
                role: "log",
                "aria-label": "Setup output",
                style: {
                  margin: 0,
                  maxHeight: "15rem",
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  fontSize: "0.75rem",
                },
              },
              state.output,
            )
          : null,
        state.running === "login"
          ? h(
              "form",
              {
                style: { display: "flex", gap: "0.5rem", alignItems: "end" },
                onSubmit: (event: { preventDefault(): void }) => {
                  event.preventDefault();
                  void setup.answer(code);
                  setCode("");
                },
              },
              field(
                "claude-code-sign-in-code",
                "Sign-in code",
                h("input", {
                  id: "claude-code-sign-in-code",
                  value: code,
                  "data-buzz-ui": "",
                  "data-size": "md",
                  className: "buzz-input",
                  onChange: (event: { target: { value: string } }) =>
                    setCode(event.target.value),
                }),
                "If the browser shows a code to paste, enter it here.",
              ),
              button("Send", { type: "submit", disabled: !code.trim() }),
            )
          : null,
      ),
      h(
        "section",
        { style: { display: "grid", gap: "0.25rem" } },
        h(
          "h3",
          { style: { margin: 0, fontSize: "inherit" } },
          "Running sessions",
        ),
        sessions.length
          ? h(
              "ul",
              {
                style: {
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "grid",
                  gap: "0.25rem",
                },
              },
              sessions.map((session) =>
                h(
                  "li",
                  {
                    key: session.key,
                    style: {
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "0.5rem",
                    },
                  },
                  h(
                    "code",
                    { style: { overflow: "hidden", textOverflow: "ellipsis" } },
                    session.key,
                  ),
                  h("span", null, session.busy ? "Working" : "Idle"),
                ),
              ),
            )
          : h(
              "p",
              { className: "buzz-field-description", style: { margin: 0 } },
              "None. A conversation's session starts when the agent is mentioned.",
            ),
      ),
    );
  }

  /** What the agent runs with. Saving restarts idle sessions with the change. */
  function SettingsTab({ agent, save }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = React.useState(saved);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState("");
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
    const model = MODELS.some(([value]) => value === draft.model)
      ? draft.model
      : "";
    return h(
      "form",
      {
        style: { display: "grid", gap: "var(--space-4, 1rem)" },
        onSubmit: (event: { preventDefault(): void }) => {
          event.preventDefault();
          void submit();
        },
      },
      field(
        "claude-code-model",
        "Model",
        choice("claude-code-model", model, MODELS, (value) =>
          setDraft({ ...draft, model: value }),
        ),
      ),
      field(
        "claude-code-workspace",
        "Workspace",
        h("input", {
          id: "claude-code-workspace",
          value: draft.workspace,
          "data-buzz-ui": "",
          "data-size": "md",
          className: "buzz-input",
          onChange: (event: { target: { value: string } }) =>
            setDraft({ ...draft, workspace: event.target.value }),
        }),
        "The folder Claude Code works in. Use ~/ for your home folder.",
      ),
      field(
        "claude-code-scope",
        "Sessions",
        choice("claude-code-scope", draft.scope, SCOPES, (value) =>
          setDraft({
            ...draft,
            scope: value === "channel" ? "channel" : "thread",
          }),
        ),
      ),
      field(
        "claude-code-respond-to",
        "Answers",
        choice("claude-code-respond-to", draft.respondTo, RESPOND_TO, (value) =>
          setDraft({
            ...draft,
            respondTo: value === "anyone" ? "anyone" : "owner",
          }),
        ),
        draft.respondTo === "anyone"
          ? "Claude runs commands on this computer as you, with no approval step. Anyone who can mention it can ask it to."
          : "Messages from anyone else are ignored.",
      ),
      field(
        "claude-code-instructions",
        "Instructions",
        h("textarea", {
          id: "claude-code-instructions",
          rows: 6,
          value: draft.instructions,
          "data-buzz-ui": "",
          className: "buzz-textarea",
          onChange: (event: { target: { value: string } }) =>
            setDraft({ ...draft, instructions: event.target.value }),
        }),
        "Added to every session's system prompt, after Buzz's own.",
      ),
      error
        ? h("p", { role: "alert", className: "buzz-field-error" }, error)
        : null,
      h(
        "div",
        null,
        button("Save", {
          type: "submit",
          variant: "prominent",
          busy: saving,
          disabled: !changed,
        }),
      ),
    );
  }

  return { ClaudeTab, SettingsTab };
}
