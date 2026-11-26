import { useEffect, useId, useMemo, useState } from "react";
import type { Agent, Agents } from "../../features/agents/service";
import {
  joinToolSelection,
  PRESET_INFO,
  roleTools,
  SAVED_ORCHESTRATOR,
  SAVED_SELECTION,
  toolPolicy,
  type ToolPolicy,
  type ToolPreset,
} from "../../features/agents/tool-access";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";

const GOOSE = /^buzz\.goose\/goose$/;
const same = (left: ToolPolicy, right: ToolPolicy) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The shared Tools tab for bundled local harnesses. Tool policy is config on
 * this device, so older app versions' strict synced-settings schema stays valid. */
export function AgentToolAccess({
  agents,
  agent,
  windows = navigator.platform.startsWith("Win"),
}: {
  agents: Agents;
  agent: Agent;
  windows?: boolean;
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
              description={
                <span className="grid gap-1">
                  <span>{preset.description}</span>
                  <span>
                    <strong className="text-primary">Can:</strong> {preset.can}
                  </span>
                  {preset.cannot && (
                    <span>
                      <strong className="text-primary">Can't:</strong>{" "}
                      {preset.cannot}
                    </span>
                  )}
                </span>
              }
            />
          ))}
        </RadioGroup>
      </Field>
      <Accordion
        variant="settings"
        items={choices
          .filter((preset) => preset.id !== "custom")
          .map((preset) => {
            const tools = roleTools(preset.id);
            return {
              value: preset.id,
              title: `${preset.label}: built-in tools this role permits`,
              content: (
                <dl className="m-0 grid gap-2 text-body-sm">
                  <ToolList title="Native tool examples, using Claude Code names">
                    {preset.id === "coder"
                      ? "Every tool the harness has"
                      : tools.native.join(", ")}
                  </ToolList>
                  <ToolList title="Buzz tools">
                    {tools.buzz.join(", ")}
                  </ToolList>
                </dl>
              ),
            };
          })}
      />
      <p className="m-0 text-body-sm text-subtle">
        Installed harness tools and the owner's own restrictions still decide
        what an agent can actually call. Permission doesn't mean every tool acts
        without approval: plugin_request waits for the owner, while
        plugin_disable and settings_set apply immediately. Tool names are Claude
        Code's; Codex, Goose and Pi use their own names for the same tools.
        Where the harness has a native Skill tool, such as Claude Code, every
        role can load skills; each action a skill takes still follows the role.
        Subagents inherit this access. It is not a sandbox: with Shell on,
        commands can use any credentials the agent's process has.
      </p>
      {windows && GOOSE.test(agent.type) && draft.preset !== "coder" && (
        <p role="status" className="m-0 text-body-sm text-warning">
          On Windows, Buzz can't yet keep Goose's saved tool permissions from
          overriding a restricted role, so this agent's messages pause until you
          choose All.
        </p>
      )}
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

function ToolList({ title, children }: { title: string; children: string }) {
  return (
    <div>
      <dt className="text-primary">{title}</dt>
      <dd className="m-0 text-subtle">{children}</dd>
    </div>
  );
}
