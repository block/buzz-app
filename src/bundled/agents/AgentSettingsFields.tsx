import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type {
  AgentControl,
  AgentControlState,
} from "../../features/agents/control";
import { isGoose, type AgentDraft } from "./agent-edit";
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
  const goose = isGoose(draft.command);
  const providerOverride = draft.environment.GOOSE_PROVIDER;
  const provider = providerOverride ?? draft.provider;
  const gooseCanBrowse =
    provider === "databricks_v2" ||
    (providerOverride === undefined &&
      environmentKeys.includes("GOOSE_PROVIDER"));
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
          {goose && !gooseCanBrowse ? (
            <div className="space-y-2">
              <Field label="Model">
                <Input
                  disabled={disabled}
                  value={draft.model}
                  placeholder="Enter a model ID for this provider"
                  spellCheck={false}
                  onChange={(event) => onChange({ model: event.target.value })}
                />
              </Field>
              <p className="text-body-sm text-secondary">
                Existing Goose credentials are reused. If this provider is not
                configured yet, run goose configure before starting the agent.
              </p>
            </div>
          ) : (
            <AgentModelPicker
              disabled={disabled}
              id={id}
              savedRevision={savedRevision}
              control={control}
              defaults={state.data?.databricksDefaults}
              draft={draft}
              onChange={onChange}
            />
          )}
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
                    Environment overrides take precedence over provider and
                    model selections. Arguments are passed literally, not
                    through a shell.
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
