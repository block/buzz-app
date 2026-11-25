import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import type { Agent, Agents } from "../../features/agents/service";
import {
  BUZZ_TOOL_GROUPS,
  buzzToolAllowed,
  CONNECTED,
  CONNECTED_TOOLS,
  joinToolSelection,
  NAMED_NATIVE,
  namedNativeTool,
  NATIVE_TOOLS,
  OTHER_NATIVE,
  nativeToolAllowed,
  PRESET_INFO,
  presetSelection,
  toolPolicy,
  type ToolPolicy,
  type ToolPreset,
} from "../../features/agents/tool-access";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";

const same = (left: ToolPolicy, right: ToolPolicy) =>
  JSON.stringify(left) === JSON.stringify(right);
const SERVER_PREFIX = `${CONNECTED}:`;
const NAMED_PREFIX = `${NAMED_NATIVE}:`;

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
  const [server, setServer] = useState("");
  const [native, setNative] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const dirty = !same(saved, draft);
  const plugins = agents.tools();
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);
  const custom = draft.preset === "custom";
  const servers = draft.allow.filter((id) => id.startsWith(SERVER_PREFIX));
  const named = draft.allow.filter((id) => id.startsWith(NAMED_PREFIX));
  const catchAll = draft.allow.includes(OTHER_NATIVE.id);
  const choose = (preset: ToolPreset) => {
    setDraft({
      preset,
      allow: preset === "custom" ? presetSelection(draft.preset) : [],
    });
    setError("");
  };
  const toggle = (id: string, on: boolean) =>
    setDraft({
      ...draft,
      allow: on
        ? [...draft.allow, id]
        : draft.allow.filter((item) => item !== id),
    });
  const addServer = () => {
    const name = server.trim();
    if (!/^[^\s,/]+(\/[^\s,/]+)?$/.test(name)) return;
    if (!servers.includes(SERVER_PREFIX + name))
      toggle(SERVER_PREFIX + name, true);
    setServer("");
  };
  const addNative = () => {
    const name = native.trim();
    if (!/^[\w.-]+$/.test(name)) return;
    const id = namedNativeTool(name);
    if (!named.includes(id)) toggle(id, true);
    setNative("");
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
  const row = (
    tool: Readonly<{ id: string; label: string; description: string }>,
    on: boolean,
  ) => (
    <SwitchPreferenceRow
      key={tool.id}
      label={tool.label}
      description={tool.description}
      checked={on}
      disabled={!custom || saving}
      onCheckedChange={(checked) => toggle(tool.id, checked)}
    />
  );
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
          {PRESET_INFO.map((preset) => (
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
      <p className="m-0 text-body-sm text-subtle">
        Subagents inherit this access. It is not a sandbox: with Shell on,
        commands can use any credentials the agent's process has.
      </p>
      <Section title="Buzz">
        {BUZZ_TOOL_GROUPS.map((group) =>
          row(group, draft.preset === "coder" || allowsGroup(draft, group.id)),
        )}
      </Section>
      <Section title="Native">
        {NATIVE_TOOLS.map((tool) =>
          row(tool, nativeToolAllowed(tool.id, draft)),
        )}
        {(draft.preset === "coder" ||
          catchAll ||
          saved.allow.includes(OTHER_NATIVE.id)) &&
          row(OTHER_NATIVE, draft.preset === "coder" || catchAll)}
        {named.map((id) =>
          row(
            {
              id,
              label: id.slice(NAMED_PREFIX.length),
              description: "This one native tool.",
            },
            true,
          ),
        )}
        {custom && (
          <AddRow
            title="Allow another native tool"
            subtitle="By the name the harness gives it, such as Skill."
            label="Native tool name"
            value={native}
            onChange={setNative}
            onAdd={addNative}
            disabled={saving}
          />
        )}
      </Section>
      <Section title="Connected">
        {row(
          CONNECTED_TOOLS,
          draft.preset === "coder" || allowsGroup(draft, CONNECTED),
        )}
        {servers.map((id) =>
          row(
            {
              id,
              label: id.slice(SERVER_PREFIX.length),
              description: id.includes("/")
                ? "This one tool from its MCP server."
                : "Every tool from this MCP server.",
            },
            true,
          ),
        )}
        {custom && (
          <AddRow
            title="Allow a server or one of its tools"
            subtitle="As the harness names it: github for every mcp__github__ tool, or github/create_issue for one."
            label="Connected server or tool"
            value={server}
            onChange={setServer}
            onAdd={addServer}
            disabled={saving}
          />
        )}
      </Section>
      {plugins.length > 0 && (
        <Section title="Plugin tools">
          {plugins.map((tool) =>
            row(
              {
                id: `plugin:${tool.name}`,
                label: tool.name,
                description: tool.description,
              },
              buzzToolAllowed(tool.name, draft, plugins),
            ),
          )}
        </Section>
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

const allowsGroup = (policy: ToolPolicy, id: string) =>
  policy.preset === "custom"
    ? policy.allow.includes(id)
    : presetSelection(policy.preset).includes(id);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-2">
      <InlineHeader title={title} />
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

function AddRow({
  title,
  subtitle,
  label,
  value,
  onChange,
  onAdd,
  disabled,
}: {
  title: string;
  subtitle: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <PreferenceRow
      title={title}
      subtitle={subtitle}
      trailing={
        <div className="flex items-center gap-2">
          <Input
            aria-label={label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onAdd();
            }}
            controlSize="sm"
            disabled={disabled}
          />
          <Button
            size="sm"
            aria-label={`Add ${label.toLowerCase()}`}
            onClick={onAdd}
            disabled={disabled}
          >
            Add
          </Button>
        </div>
      }
    />
  );
}
