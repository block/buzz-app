// Amp's New agent choices and agent settings.
import { useEffect, useId, useRef, useState } from "react";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { effortName, validWorkspace } from "../codex/config";
import { MODES } from "./amp";
import { type Config, DEFAULT_CONFIG, config as readConfig } from "./runtime";

/** Select items need a value, so Amp's default mode has one of its own. */
const DEFAULT_MODE = "default";

export const modeLabel = (mode: string) =>
  mode ? effortName(mode) : "Amp default";

const MODE_GROUPS = [
  {
    label: "",
    options: [
      { value: DEFAULT_MODE, label: modeLabel("") },
      ...MODES.map((mode) => ({ value: mode, label: modeLabel(mode) })),
    ],
  },
];

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One Amp thread per Buzz thread" },
      { value: "channel", label: "One Amp thread per channel" },
    ],
  },
];

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The instructions a new agent starts with. */
export function Create({
  config,
  onChange,
  disabled,
}: AgentCreateProps<Config>) {
  const current = readConfig(config);
  return (
    <AgentInstructions
      creation
      value={current.instructions}
      disabled={disabled}
      onChange={(instructions) => onChange({ ...current, instructions })}
    />
  );
}

export function SettingsTab({
  agent,
  save,
  settingsHost,
  settingsSection,
  settingsContent,
}: AgentViewProps<Config>) {
  const form = useId();
  const saved = readConfig(agent.config);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const saveErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) saveErrorRef.current?.focus();
  }, [error]);
  const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
  const changed = configChanged || Boolean(settingsHost?.pendingSave);
  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const workspace = draft.workspace.trim() || DEFAULT_CONFIG.workspace;
      if (!validWorkspace(workspace))
        throw new Error("Enter an absolute or ~/… workspace path.");
      await save({ ...draft, workspace });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      id={form}
      className="grid gap-4 [container-type:inline-size]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error && (
        <p
          ref={saveErrorRef}
          tabIndex={-1}
          role="alert"
          className="buzz-field-error"
        >
          {error}
        </p>
      )}
      {settingsSection !== "runtime" && (
        <>
          <SettingsGroup>
            {settingsHost?.typeControl?.(configChanged)}
            <Select
              label="Mode"
              variant="preference"
              value={draft.mode || DEFAULT_MODE}
              groups={MODE_GROUPS}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  mode: value === DEFAULT_MODE ? "" : value,
                })
              }
            />
          </SettingsGroup>
          <AgentInstructions
            value={draft.instructions}
            disabled={false}
            onChange={(instructions) => setDraft({ ...draft, instructions })}
          />
        </>
      )}
      {settingsSection !== "identity" && (
        <>
          <Field
            label="Workspace"
            description="The folder Amp works in. Use ~/ for your home folder."
          >
            <Input
              value={draft.workspace}
              onValueChange={(workspace) => setDraft({ ...draft, workspace })}
            />
          </Field>
          <Select
            label="Sessions"
            variant="preference"
            value={draft.scope}
            groups={SCOPES}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                scope: value === "channel" ? "channel" : "thread",
              })
            }
          />
        </>
      )}
      <AgentSaveButton form={form} saving={saving} disabled={!changed} />
      {settingsSection !== "identity" && settingsContent}
    </form>
  );
}
