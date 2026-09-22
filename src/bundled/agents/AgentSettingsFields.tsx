import type {
  AgentControl,
  AgentControlState,
} from "../../features/agents/control";
import type { AgentDraft } from "./agent-edit";
import { AgentEnvironmentEditor } from "./AgentEnvironmentEditor";
import { AgentHarnessEditor } from "./AgentHarnessEditor";
import { AgentModelPicker } from "./AgentModelPicker";

/** Create and Edit share the same settings and native model discovery. */
export function AgentSettingsFields({
  id,
  savedRevision,
  draft,
  control,
  state,
  disabled,
  environmentKeys = [],
  onChange,
}: {
  id?: string | undefined;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  state: AgentControlState;
  disabled: boolean;
  environmentKeys?: string[];
  onChange(patch: Partial<AgentDraft>): void;
}) {
  return (
    <>
      <fieldset disabled={disabled} className="min-w-0 space-y-4">
        <label className="agent-control-field">
          Name
          <input
            value={draft.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label className="agent-control-field">
          Agent instructions
          <textarea
            rows={6}
            value={draft.systemPrompt}
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
          />
        </label>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-body-sm text-secondary">
            AI configuration
          </legend>
          <AgentHarnessEditor
            draft={draft}
            options={state.data?.harnessOptions ?? []}
            onChange={onChange}
          />
          <AgentModelPicker
            id={id}
            savedRevision={savedRevision}
            control={control}
            defaults={state.data?.databricksDefaults}
            draft={draft}
            onChange={onChange}
          />
        </fieldset>
      </fieldset>
      <details className="space-y-4">
        <summary className="cursor-pointer text-body-sm">Advanced</summary>
        <label className="agent-control-field">
          Workspace
          <input
            value={draft.workspace}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => onChange({ workspace: event.target.value })}
          />
        </label>
        <label className="agent-control-field">
          Arguments (JSON array)
          <textarea
            rows={3}
            value={draft.args}
            disabled={disabled}
            onChange={(event) => onChange({ args: event.target.value })}
          />
        </label>
        <AgentEnvironmentEditor
          keys={environmentKeys}
          patch={draft.environment}
          disabled={disabled}
          onChange={(environment) => onChange({ environment })}
        />
        <p className="text-body-sm text-secondary">
          Environment overrides take precedence over provider and model
          selections. Arguments are passed literally, not through a shell.
        </p>
      </details>
    </>
  );
}
