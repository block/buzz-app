import { useSyncExternalStore } from "react";
import type {
  AgentActivity,
  AgentTypes,
  RegisteredAgentType,
} from "../../features/agent-types/service";
import type { AgentView } from "../../features/agents/control";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { AgentDraft } from "./agent-edit";

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
): string | undefined {
  if (!draft.plugin) return undefined;
  const type = types.find((type) => type.key === draft.plugin?.type);
  if (!type)
    return "This agent's type is unavailable. Enable its plugin, then try again.";
  return type.validate?.(draft.plugin.config) || undefined;
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
  agent?: Pick<AgentView, "id" | "pubkey" | "name"> | undefined;
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
