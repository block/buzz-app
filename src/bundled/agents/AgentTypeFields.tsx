import { useSyncExternalStore } from "react";
import type {
  AgentActivity,
  AgentTypes,
  RegisteredAgentType,
} from "../../features/agent-types/service";
import type { AgentView } from "../../features/agents/control";
import { Field } from "../../shared/design-system/ui/Field";
import { Select } from "../../shared/design-system/ui/Select";
import { Input } from "../../shared/design-system/ui/Input";
import type { AgentDraft } from "./agent-edit";
import { SecretField } from "./ProviderApiKeyField";

const noTypes: readonly RegisteredAgentType[] = Object.freeze([]);
const noActivity: Readonly<Record<string, AgentActivity>> = Object.freeze({});
const never = () => () => {};

/** The agent types active plugins contribute; empty where the service is absent. */
export function useAgentTypes(agentTypes: AgentTypes | undefined) {
  return useSyncExternalStore(
    agentTypes?.subscribe ?? never,
    agentTypes?.snapshot ?? (() => noTypes),
  );
}
export function useAgentActivity(
  agentTypes: AgentTypes | undefined,
  id: string,
): AgentActivity | undefined {
  return useSyncExternalStore(
    agentTypes?.subscribe ?? never,
    agentTypes?.activity ?? (() => noActivity),
  )[id];
}
/** Why a plugin agent's draft cannot be saved, or nothing when it can. */
export function agentTypeError(
  draft: AgentDraft,
  types: readonly RegisteredAgentType[],
  /** Names of the values already saved on the agent; none in Create agent. */
  savedSecrets: readonly string[] = [],
): string | undefined {
  if (!draft.plugin) return undefined;
  const type = types.find((type) => type.key === draft.plugin?.type);
  if (!type)
    return "This agent's type is unavailable. Enable its plugin, then try again.";
  if (type.workspace === "required" && !draft.workspace.trim())
    return "Choose a workspace for this agent.";
  const missing = type.secrets?.find(({ name, optional }) => {
    const typed = draft.environment[name];
    return (
      !optional && !typed && (typed === null || !savedSecrets.includes(name))
    );
  });
  if (missing) return `Enter ${missing.label}.`;
  return type.validate?.(draft.plugin.config) || undefined;
}

/** An emptied field sends nothing, so a saved value stays as it is. */
function withSecret(
  environment: AgentDraft["environment"],
  name: string,
  value: string,
) {
  const { [name]: _, ...rest } = environment;
  return value ? { ...rest, [name]: value } : rest;
}

/** A plugin agent's whole form: the host asks for a name, the type for the rest. */
export function AgentTypeFields({
  draft,
  types,
  disabled,
  agent,
  defaultSessionPolicy = "channel",
  onChange,
}: {
  draft: AgentDraft;
  types: readonly RegisteredAgentType[];
  disabled: boolean;
  defaultSessionPolicy?: "channel" | "thread" | undefined;
  /** The saved agent on its own screen; absent in Create agent. */
  agent?: Pick<AgentView, "id" | "pubkey" | "name" | "harness"> | undefined;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const plugin = draft.plugin;
  const type = types.find((type) => type.key === plugin?.type);
  return (
    <div className="min-w-0 space-y-4">
      <Field label="Name">
        <Input
          disabled={disabled}
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>
      {plugin && type ? (
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">{type.title}</legend>
          <type.Configure
            config={plugin.config}
            disabled={disabled}
            {...(agent ? { agent } : {})}
            onChange={(config) =>
              onChange({ plugin: { type: plugin.type, config } })
            }
          />
          {type.secrets?.map((secret) => (
            <SecretField
              key={secret.name}
              label={secret.label}
              noun="value"
              value={draft.environment[secret.name]}
              saved={!!agent?.harness.environmentKeys.includes(secret.name)}
              disabled={disabled}
              emptyPlaceholder={secret.optional ? "Optional" : ""}
              onChange={(value) =>
                onChange({
                  environment: withSecret(
                    draft.environment,
                    secret.name,
                    value,
                  ),
                })
              }
            />
          ))}
          {type.conversationContext && (
            <Select
              label="Conversation context"
              variant="field"
              disabled={disabled}
              value={draft.sessionPolicy ?? ""}
              groups={[
                {
                  label: "",
                  options: [
                    {
                      value: "",
                      label: `Use agent defaults (${defaultSessionPolicy === "thread" ? "Each thread" : "Entire channel"})`,
                    },
                    { value: "channel", label: "Entire channel" },
                    { value: "thread", label: "Each thread" },
                  ],
                },
              ]}
              onValueChange={(value) =>
                onChange({
                  sessionPolicy:
                    value === "channel" || value === "thread" ? value : null,
                })
              }
              description="Entire channel shares one conversation across threads. Each thread keeps a separate conversation; direct messages remain shared."
            />
          )}
          {type.workspace ? (
            <Field
              label="Workspace"
              description={
                type.workspace === "required"
                  ? "The folder where this agent works."
                  : "Optional. The agent can read and write files in this folder and run commands that start there. Commands are not limited to it."
              }
            >
              <Input
                disabled={disabled}
                spellCheck={false}
                placeholder="/absolute/path/to/a/folder"
                value={draft.workspace}
                onChange={(event) =>
                  onChange({ workspace: event.target.value })
                }
              />
            </Field>
          ) : null}
        </fieldset>
      ) : (
        <p role="status" className="text-body-sm text-secondary">
          This agent's type, <code>{plugin?.type}</code>, isn't available. The
          agent won't run and its settings can't be changed until that plugin is
          enabled.
        </p>
      )}
    </div>
  );
}
