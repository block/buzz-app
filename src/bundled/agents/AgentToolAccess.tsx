import { useEffect, useId, useMemo, useState } from "react";
import type { Agent, Agents } from "../../features/agents/service";
import {
  joinToolSelection,
  PRESET_INFO,
  SAVED_ORCHESTRATOR,
  SAVED_SELECTION,
  toolPolicy,
  type ToolPolicy,
  type ToolPreset,
} from "../../features/agents/tool-access";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";

const same = (left: ToolPolicy, right: ToolPolicy) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The shared Tools tab for bundled local harnesses. Tool policy is config on
 * this device, so older app versions' strict synced-settings schema stays valid. */
export function AgentToolAccess({
  agents,
  agent,
}: {
  agents: Agents;
  agent: Agent;
}) {
  const saved = useMemo(() => toolPolicy(agent.config), [agent.config]);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const dirty = !same(saved, draft);
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);
  // A selection saved by an earlier draft stays as it is until the owner
  // chooses a role, so it never silently gains access.
  const choices = [
    ...PRESET_INFO,
    ...(saved.preset === "super-agent" ? [SAVED_ORCHESTRATOR] : []),
    ...(saved.preset === "custom" ? [SAVED_SELECTION] : []),
  ];
  const choose = (preset: ToolPreset) => {
    setDraft(preset === "custom" ? saved : { preset, allow: [] });
    setError("");
  };
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const config =
        agent.config &&
        typeof agent.config === "object" &&
        !Array.isArray(agent.config)
          ? (agent.config as Record<string, unknown>)
          : {};
      const { toolDeny: _, ...rest } = config;
      await agents.save(agent.key, {
        config: {
          ...rest,
          toolPreset: draft.preset,
          toolAllow: joinToolSelection(draft.allow),
        },
        ...(agent.configBase && { base: agent.configBase }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      id={form}
      className="grid min-w-0 gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <InlineHeader
        title="Tool access"
        subtitle="Choose what this agent can do on this device. Changes apply to its next tool call, including in a turn that is already running."
      />
      <Field
        label="Tool access role"
        labelVisibility="hidden"
        nativeLabel={false}
      >
        <RadioGroup
          aria-label="Tool access role"
          value={draft.preset}
          onValueChange={(preset) => choose(preset as ToolPreset)}
          disabled={saving}
        >
          {choices.map((preset) => (
            <Radio
              key={preset.id}
              value={preset.id}
              variant="card"
              label={preset.label}
              description={preset.description}
            />
          ))}
        </RadioGroup>
      </Field>
      <p className="m-0 text-body-sm text-subtle">
        The owner's own restrictions and each harness's tools still apply.
        Connected apps can't be limited to reads, so Reviewer can't use them,
        and on Goose it can list folders and view images but can't open text
        files. Subagents inherit this access. It is not a sandbox: with commands
        on, they can use any credentials the agent's process has.
      </p>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <AgentSaveButton
        form={form}
        saving={saving}
        dirty={dirty}
        disabled={!dirty || saving}
      />
    </form>
  );
}
