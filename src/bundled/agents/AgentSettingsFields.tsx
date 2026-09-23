import { Select } from "../../shared/design-system/ui/Select";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
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
  onValidated,
  validationVersion,
}: {
  id?: string | undefined;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  state: AgentControlState;
  disabled: boolean;
  environmentKeys?: string[];
  onChange(patch: Partial<AgentDraft>): void;
  onValidated?: ((draft: AgentDraft | null) => void) | undefined;
  validationVersion?: number | undefined;
}) {
  return (
    <div className="min-w-0">
      <div className="min-w-0 space-y-section-gap">
        <div className="space-y-4">
          <Field label="Name">
            <Input
              disabled={disabled}
              value={draft.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>
          <Field label="Agent instructions">
            <Textarea
              disabled={disabled}
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) =>
                onChange({ systemPrompt: event.target.value })
              }
            />
          </Field>
        </div>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">AI configuration</legend>
          <AgentHarnessEditor
            disabled={disabled}
            draft={draft}
            options={state.data?.harnessOptions ?? []}
            onChange={onChange}
          />
          {state.data?.configurationAvailable && (
            <Select
              label="Configuration"
              variant="field"
              disabled={disabled}
              value={draft.configuration?.mode ?? "legacy"}
              groups={[
                {
                  label: "",
                  options: [
                    ...(!draft.configuration
                      ? [{ value: "legacy", label: "Existing configuration" }]
                      : []),
                    { value: "default", label: "Harness defaults" },
                    { value: "advanced", label: "Advanced" },
                  ],
                },
              ]}
              onValueChange={(mode) => {
                if (mode === "default")
                  onChange({ configuration: { mode }, model: "" });
                if (mode === "advanced")
                  onChange({
                    configuration: { mode, effort: { kind: "unsupported" } },
                  });
              }}
            />
          )}
          {draft.configuration?.mode === "default" && (
            <p className="text-body-sm text-secondary">
              The harness chooses its model and effort from its own
              configuration.
            </p>
          )}
          <AgentModelPicker
            onValidated={onValidated}
            validationVersion={validationVersion}
            disabled={disabled}
            id={id}
            savedRevision={savedRevision}
            control={control}
            defaults={state.data?.databricksDefaults}
            recoveryAvailable={
              state.data?.harnessOptions?.some(
                (option) =>
                  option.capabilities?.modelDiscovery === "databricks",
              ) ?? false
            }
            capabilities={
              state.data?.harnessOptions?.find(
                (option) =>
                  option.command === draft.command ||
                  ((option.id === "buzz-agent" || option.id === "codex") &&
                    draft.command.endsWith(`/${option.command}`)),
              )?.capabilities
            }
            draft={draft}
            onChange={onChange}
          />
        </fieldset>
      </div>
      <div className="-mx-2">
        <Accordion
          variant="form"
          keepMounted
          items={[
            {
              value: "advanced",
              title: "Environment",
              content: (
                <div className="space-y-4">
                  <Field label="Workspace">
                    <Input
                      value={draft.workspace}
                      disabled={disabled}
                      spellCheck={false}
                      onChange={(event) =>
                        onChange({ workspace: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Arguments (JSON array)">
                    <Textarea
                      rows={3}
                      value={draft.args}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange({ args: event.target.value })
                      }
                    />
                  </Field>
                  <AgentEnvironmentEditor
                    keys={environmentKeys}
                    patch={draft.environment}
                    disabled={disabled}
                    onChange={(environment) => onChange({ environment })}
                  />
                  <p className="text-body-sm text-secondary">
                    Provider environment overrides take precedence. Explicit AI
                    configuration controls Buzz’s model and effort overrides.
                    Arguments are passed literally, not through a shell.
                  </p>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
