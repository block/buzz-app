import { useSyncExternalStore } from "react";
import type {
  AgentActivity,
  AgentTypes,
  RegisteredAgentType,
} from "../../features/agent-types/service";
import type { AgentView } from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
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

/** Marks a saved value for removal on save (`null`), or takes that mark back. */
function withRemoval(
  environment: AgentDraft["environment"],
  name: string,
  remove: boolean,
) {
  const { [name]: _, ...rest } = environment;
  return remove ? { ...rest, [name]: null } : rest;
}

/** A plugin agent's whole form: the host asks for a name, the type for the rest. */
export function AgentTypeFields({
  draft,
  types,
  disabled,
  agent,
  onChange,
}: {
  draft: AgentDraft;
  types: readonly RegisteredAgentType[];
  disabled: boolean;
  /** The saved agent on its own screen; absent in Create agent. */
  agent?: Pick<AgentView, "id" | "pubkey" | "name" | "harness"> | undefined;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const plugin = draft.plugin;
  const type = types.find((type) => type.key === plugin?.type);
  const savedKeys = agent?.harness.environmentKeys ?? [];
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
          {type.secrets?.map((secret) => {
            const saved = savedKeys.includes(secret.name);
            const removing = draft.environment[secret.name] === null;
            return (
              <div key={secret.name} className="min-w-0 space-y-2">
                <SecretField
                  label={secret.label}
                  noun="value"
                  value={draft.environment[secret.name]}
                  saved={saved}
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
                {/* A required value can be replaced but not removed. */}
                {saved && secret.optional && (
                  <RemoveSaved
                    label={secret.label}
                    removing={removing}
                    disabled={disabled}
                    onToggle={() =>
                      onChange({
                        environment: withRemoval(
                          draft.environment,
                          secret.name,
                          !removing,
                        ),
                      })
                    }
                  />
                )}
              </div>
            );
          })}
          {/* Values saved under names this version of the type no longer asks for. */}
          {savedKeys
            .filter((name) => !type.secrets?.some((s) => s.name === name))
            .map((name) => (
              <div
                key={name}
                className="flex min-w-0 items-center justify-between gap-2"
              >
                <span className="text-body-sm text-secondary">
                  Saved value <code>{name}</code> is no longer used
                </span>
                <RemoveSaved
                  label={name}
                  removing={draft.environment[name] === null}
                  disabled={disabled}
                  onToggle={() =>
                    onChange({
                      environment: withRemoval(
                        draft.environment,
                        name,
                        draft.environment[name] !== null,
                      ),
                    })
                  }
                />
              </div>
            ))}
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

function RemoveSaved({
  label,
  removing,
  disabled,
  onToggle,
}: {
  label: string;
  removing: boolean;
  disabled: boolean;
  onToggle(): void;
}) {
  return (
    <Button
      type="button"
      size="compact"
      variant="ghost"
      disabled={disabled}
      aria-label={removing ? `Keep saved ${label}` : `Remove saved ${label}`}
      onClick={onToggle}
    >
      {removing ? "Keep saved value" : "Remove saved value"}
    </Button>
  );
}
