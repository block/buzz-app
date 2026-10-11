import { Button } from "../../shared/design-system/ui/Button";
import { CodexLogoIcon } from "../../shared/design-system/icons";
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
  onConfigure,
}: {
  agent: AgentView;
  control: AgentControl;
  state: AgentControlState;
  onConfigure(): void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  // Write-only environment selectors win over scalar model/provider settings.
  // The full editor owns replacement and removal of those selectors.
  if (agent.launchModelEnv || agent.launchProviderEnv) {
    return (
      <Button onClick={onConfigure} disabled={state.busy} variant="ghost">
        Configure model
      </Button>
    );
  }
  if (harnessPreset(agent.harness.command)) return null;
  // Codex validates model and effort as one draft; model-only immediate saves
  // cannot safely apply its configuration patches.
  if (agent.harness.integration === "codex") {
    return (
      <Button
        onClick={onConfigure}
        disabled={state.busy}
        variant="ghost"
        aria-label="Configure Codex"
      >
        <CodexLogoIcon size={18} />
        {agent.harness.configuration?.mode === "advanced"
          ? agent.harness.model || "Codex"
          : "Codex defaults"}
      </Button>
    );
  }
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
