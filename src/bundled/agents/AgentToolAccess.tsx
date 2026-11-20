import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Agent, Agents } from "../../features/agents/service";
import { sessionTools } from "../../buzz-mcp/session-tools";
import {
  buzzToolAllowed,
  joinToolOverrides,
  nativeToolAllowed,
  NATIVE_TOOLS,
  PRESET_INFO,
  toolPolicy,
  toolPolicyProblem,
  type ToolPolicy,
} from "../../features/agents/tool-access";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SearchField } from "../../shared/design-system/ui/SearchField";
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
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const dirty = !same(saved, draft);
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);
  const added = useSyncExternalStore(
    agents.subscribe,
    agents.tools,
    agents.tools,
  );
  const catalog = useMemo(() => sessionTools(added), [added]);
  const visible = catalog.filter(
    (tool) =>
      !query.trim() ||
      `${tool.name} ${tool.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const enabled = catalog.filter((tool) => buzzToolAllowed(tool.name, draft));
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
        subtitle="Choose a role, then override individual Buzz tools or native capabilities. Changes on this device apply to new tool calls and sessions."
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
          Effective access: {enabled.length} of {catalog.length} Buzz tools;{" "}
          {enabledNative.length} of {NATIVE_TOOLS.length} native capability
          groups.
        </strong>
        <p className="mb-0 mt-2">
          Subagents inherit this policy. Native names differ by harness, so they
          are grouped by capability. Tool access is not a sandbox: when Shell is
          enabled, commands can still use credentials available to the agent
          process.
        </p>
      </div>
      <Accordion
        headingLevel={3}
        items={[
          {
            value: "native",
            title: "Advanced: native capabilities",
            content: (
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
            ),
          },
          {
            value: "buzz",
            title: "Advanced: Buzz tools",
            content: (
              <div className="grid min-w-0 gap-4">
                <SearchField
                  value={query}
                  onValueChange={setQuery}
                  label="Search Buzz tools"
                  placeholder="Search tools"
                  disabled={saving}
                />
                <p className="m-0 text-body-sm text-subtle">
                  Enabled by the current draft:{" "}
                  {enabled.map((tool) => tool.name).join(", ")}.
                </p>
                <SettingsGroup>
                  {visible.map((tool) => (
                    <ToolRow
                      key={tool.name}
                      name={tool.name}
                      title={tool.name}
                      description={tool.description}
                      enabled={buzzToolAllowed(tool.name, draft)}
                      value={override(tool.name)}
                      disabled={saving}
                      onChange={(value) => setOverride(tool.name, value)}
                    />
                  ))}
                </SettingsGroup>
                {!visible.length && (
                  <p className="m-0 text-body-sm text-subtle">
                    No Buzz tools match this search.
                  </p>
                )}
              </div>
            ),
          },
        ]}
      />
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
