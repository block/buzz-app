import { useState } from "react";
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
  const [piProviders, setPiProviders] = useState<string[]>([]);
  const pi = draft.command.split("/").at(-1) === "buzz-pi-acp";
  const goose = isGoose(draft.command);
  const providerOverride = draft.environment.GOOSE_PROVIDER;
  const provider = providerOverride ?? draft.provider;
  const gooseCanBrowse =
    provider === "databricks_v2" ||
    (providerOverride === undefined &&
      environmentKeys.includes("GOOSE_PROVIDER"));
  const buzzProvider =
    draft.environment.BUZZ_AGENT_PROVIDER ??
    (draft.provider || state.data?.agentDefaults?.provider);
  // Saved environment values are write-only. Do not promise a build default
  // when an untouched override could select a different provider or model.
  const modelDefaultKnown =
    (draft.environment.BUZZ_AGENT_PROVIDER !== undefined ||
      !environmentKeys.includes("BUZZ_AGENT_PROVIDER")) &&
    ["BUZZ_AGENT_MODEL", "DATABRICKS_MODEL"].every(
      (key) =>
        draft.environment[key] === null ||
        (draft.environment[key] === undefined &&
          !environmentKeys.includes(key)),
    );
  const databricks = ["databricks_v2", "databricks-v2", "databricks"].includes(
    buzzProvider ?? "",
  );
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
            defaultProvider={
              goose ? undefined : state.data?.agentDefaults?.provider
            }
            piProviders={piProviders}
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
              onPiProviders={setPiProviders}
              disabled={disabled}
              id={id}
              savedRevision={savedRevision}
              control={control}
              defaults={state.data?.databricksDefaults}
              defaultModel={
                !goose && databricks && modelDefaultKnown
                  ? state.data?.agentDefaults?.model
                  : undefined
              }
              draft={draft}
              onChange={onChange}
            />
          )}
          {pi && (
            <p className="text-body-sm text-secondary">
              Browse loads available models and providers from your local Pi
              configuration, including extensions. Configure sign-in in Pi
              first. Save keeps changes for the next Start or Restart.
            </p>
          )}
        </fieldset>
      </div>
      {state.data?.agentDefaults?.ownerOnly && (
        <p className="text-body-sm text-secondary">
          This build allows instructions only from the owner and verified
          same-owner agents.
        </p>
      )}
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
                    {pi
                      ? 'Pi needs both Provider and Model to override its defaults. Advanced Pi options follow --; for example: ["--", "--extension", "/absolute/path/to/extension.ts"]. PI_CODING_AGENT_DIR can select a local Pi configuration directory.'
                      : "Environment overrides take precedence over provider and model selections."}{" "}
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
