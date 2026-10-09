import { harnessPreset } from "../../features/agents/harness-presets";
import { useRef, useState } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft, agentEdit } from "./agent-edit";

export function AgentQuickModel({
  agent,
  control,
  state,
}: {
  agent: AgentView;
  control: AgentControl;
  state: AgentControlState;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  if (harnessPreset(agent.harness.command)) return null;
  return (
    <div className="agent-quick-model">
      <div className="agent-quick-model-picker">
        <AgentSettingsFields
          id={agent.id}
          savedRevision={agent.revision}
          draft={agentDraft(agent)}
          control={control}
          state={state}
          disabled={saving || state.busy}
          cardLayout
          hideName
          hideInstructions
          quickModelOnly
          onChange={(patch) => {
            if (pending.current || patch.model === undefined) return;
            pending.current = true;
            setSaving(true);
            setError("");
            void (async () => {
              try {
                const result = await control.save(
                  agent.id,
                  agent.revision,
                  agentEdit({ ...agentDraft(agent), ...patch }),
                );
                if (result.restartFailures)
                  setError(
                    "Model saved, but the agent could not restart. Open agent settings to retry.",
                  );
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not change model. Try again.",
                );
              } finally {
                pending.current = false;
                setSaving(false);
              }
            })();
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
