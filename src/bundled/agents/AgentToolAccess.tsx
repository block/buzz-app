import { useEffect, useId, useMemo, useState } from "react";
import type { Agent, Agents } from "../../features/agents/service";
import {
  joinToolOverrides,
  nativeToolAllowed,
  NATIVE_TOOLS,
  PRESET_INFO,
  toolPolicy,
  toolPolicyProblem,
  type ToolPolicy,
} from "../../features/agents/tool-access";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";

const OVERRIDE_CHOICES = [
  { value: "preset", label: "Use preset" },
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" },
] as const;
const GROUPS = [{ label: "Override", options: OVERRIDE_CHOICES }];
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
  const enabledNative = NATIVE_TOOLS.filter((tool) =>
    nativeToolAllowed(tool.id, draft),
  );
  const problem = toolPolicyProblem(draft);
  const setOverride = (name: string, value: string) => {
    const allow = draft.allow.filter((item) => item !== name);
    const deny = draft.deny.filter((item) => item !== name);
    if (value === "allow") allow.push(name);
    if (value === "deny") deny.push(name);
    setDraft({ ...draft, allow, deny });
    setError("");
  };
  const override = (name: string) =>
    draft.deny.includes(name)
      ? "deny"
      : draft.allow.includes(name)
        ? "allow"
        : "preset";
  const save = async () => {
    if (!dirty || problem || saving) return;
    setSaving(true);
    setError("");
    try {
      const config =
        agent.config &&
        typeof agent.config === "object" &&
        !Array.isArray(agent.config)
          ? (agent.config as Record<string, unknown>)
          : {};
      await agents.save(agent.key, {
        config: {
          ...config,
          toolPreset: draft.preset,
          toolAllow: joinToolOverrides(draft.allow),
          toolDeny: joinToolOverrides(draft.deny),
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
        subtitle="Buzz tools are always available. Choose a role, then adjust native capabilities such as files, Shell and Web. Changes on this device apply to new tool calls and sessions."
      />
      <SettingsGroup>
        <PreferenceRow
          title="Role preset"
          subtitle={
            PRESET_INFO.find((preset) => preset.id === draft.preset)
              ?.description
          }
          trailing={
            <Select
              label="Tool access role"
              value={draft.preset}
              groups={[
                {
                  label: "Role",
                  options: PRESET_INFO.map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                    description: preset.description,
                  })),
                },
              ]}
              onValueChange={(preset) => {
                setDraft({ ...draft, preset: preset as ToolPolicy["preset"] });
                setError("");
              }}
              variant="compact"
              disabled={saving}
            />
          }
        />
      </SettingsGroup>
      <div className="rounded-control border border-line bg-soft p-panel-inset text-body-sm text-subtle">
        <strong className="text-primary">
          Effective access: all Buzz tools on; {enabledNative.length} of{" "}
          {NATIVE_TOOLS.length} native capability groups.
        </strong>
        <p className="mb-0 mt-2">
          Subagents inherit this policy. Native names differ by harness, so they
          are grouped by capability. Tool access is not a sandbox: when Shell is
          enabled, commands can still use credentials available to the agent
          process.
        </p>
      </div>
      <SettingsGroup>
        {NATIVE_TOOLS.map((tool) => (
          <ToolRow
            key={tool.id}
            name={tool.id}
            title={tool.label}
            description={tool.description}
            enabled={nativeToolAllowed(tool.id, draft)}
            value={override(tool.id)}
            disabled={saving}
            onChange={(value) => setOverride(tool.id, value)}
          />
        ))}
      </SettingsGroup>
      {(problem || error) && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {problem ?? error}
        </p>
      )}
      <AgentSaveButton
        form={form}
        saving={saving}
        dirty={dirty}
        disabled={!dirty || saving || Boolean(problem)}
      />
    </form>
  );
}

function ToolRow({
  name,
  title,
  description,
  enabled,
  value,
  disabled,
  onChange,
}: {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <PreferenceRow
      title={<span className="break-all">{title}</span>}
      subtitle={description}
      trailing={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span
            className={
              enabled ? "text-body-sm text-success" : "text-body-sm text-subtle"
            }
          >
            {enabled ? "On" : "Off"}
          </span>
          <Select
            label={`${name} override`}
            value={value}
            valueLabel={
              OVERRIDE_CHOICES.find((choice) => choice.value === value)?.label
            }
            groups={GROUPS}
            onValueChange={onChange}
            variant="compact"
            size="xs"
            disabled={disabled}
          />
        </div>
      }
    />
  );
}
