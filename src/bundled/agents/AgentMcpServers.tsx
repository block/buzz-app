import { useEffect, useState } from "react";
import { PlusIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  approved,
  envName,
  type McpInherited,
  type McpList,
  type McpServer,
  type McpTransport,
  mcpValueNames,
  NAME,
  saveMcpValues,
} from "../../features/agents/mcp-servers";
import type { Agent, Agents, AgentType } from "../../features/agents/service";

type Props = Readonly<{
  agents: Pick<Agents, "approveMcp">;
  agent: Agent;
  capability: NonNullable<AgentType["mcpServers"]>;
}>;

/** Buzz's own tool server, in every harness. */
const BUZZ_TOOLS = "buzz";

type Draft = {
  replacing?: string;
  name: string;
  transport: McpTransport;
  target: string;
  args: string;
  keys: string;
  values: Record<string, string>;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const keysOf = (s: McpServer) => (s.transport === "stdio" ? s.env : s.headers);

/** The agent's own MCP servers, and those from its harness's own config,
 * each with a switch. A change is signed as the owner's approval and syncs
 * with the agent's settings; values stay on this device. */
export function AgentMcpServers({ agents, agent, capability }: Props) {
  const check = approved(
    (agent.config as { mcpServers?: unknown }).mcpServers,
    agent.owner,
    agent.pubkey,
  );
  const list: McpList = check.ok
    ? check.list
    : { servers: [], disabledInherited: [] };
  const [inherited, setInherited] = useState<readonly McpInherited[]>([]);
  const [saved, setSaved] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState<Draft | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    void capability.inherited?.(agent).then(setInherited, () => undefined);
    void mcpValueNames(agent.pubkey).then(setSaved, () => undefined);
  }, [agent, capability]);
  const approve = async (next: McpList) => {
    setPending(true);
    setError(undefined);
    try {
      await agents.approveMcp?.(agent.key, next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setPending(false);
    }
  };
  const taken = new Set([
    BUZZ_TOOLS,
    ...(capability.reserved ?? []),
    ...inherited.map((i) => i.name),
    ...list.servers.map((s) => s.name),
  ]);
  const nameProblem = (d: Draft) =>
    !NAME.test(d.name)
      ? "Use letters, numbers, - and _ only"
      : d.name !== d.replacing && taken.has(d.name)
        ? "A server already has this name. Choose another."
        : undefined;
  const submit = async (d: Draft) => {
    const keys = lines(d.keys);
    const server: McpServer =
      d.transport === "stdio"
        ? {
            name: d.name,
            enabled: true,
            transport: "stdio",
            command: d.target.trim(),
            args: lines(d.args),
            env: keys,
          }
        : {
            name: d.name,
            enabled: true,
            transport: "http",
            url: d.target.trim(),
            headers: keys,
          };
    const others = list.servers.filter((s) => s.name !== d.replacing);
    await approve({ ...list, servers: [...others, server] });
    // Values are kept under the server's name: a renamed one's go with it.
    const own = saved.filter(
      (n) => !n.startsWith(envName(d.replacing ?? d.name, "")),
    );
    const rows = [
      ...own.map((name) => ({ name })),
      ...keys.map((key) => ({
        name: envName(d.name, key),
        ...(d.values[key] ? { value: d.values[key] } : {}),
      })),
    ];
    await saveMcpValues(agent.pubkey, rows);
    setSaved(await mcpValueNames(agent.pubkey));
    setDraft(undefined);
  };
  const toggle = (server: McpServer, enabled: boolean) =>
    approve({
      ...list,
      servers: list.servers.map((s) =>
        s.name === server.name ? { ...s, enabled } : s,
      ),
    }).catch(() => undefined);
  const toggleInherited = (name: string, enabled: boolean) =>
    approve({
      ...list,
      disabledInherited: enabled
        ? list.disabledInherited.filter((n) => n !== name)
        : [...list.disabledInherited, name],
    }).catch(() => undefined);
  const remove = (server: McpServer) =>
    approve({
      ...list,
      servers: list.servers.filter((s) => s.name !== server.name),
    }).catch(() => undefined);
  const unset = (s: McpServer) =>
    keysOf(s).filter((k) => !saved.includes(envName(s.name, k)));
  const edit = (s?: McpServer): Draft =>
    s
      ? {
          replacing: s.name,
          name: s.name,
          transport: s.transport,
          target: s.transport === "stdio" ? s.command : s.url,
          args: s.transport === "stdio" ? s.args.join("\n") : "",
          keys: keysOf(s).join("\n"),
          values: {},
        }
      : {
          name: "",
          transport: capability.transports[0] ?? "stdio",
          target: "",
          args: "",
          keys: "",
          values: {},
        };
  return (
    <div className="mt-section-gap">
      <InlineHeader
        title="MCP servers"
        actions={
          <Button
            size="compact"
            variant="outline"
            disabled={pending || !check.ok}
            onClick={() => setDraft(edit())}
          >
            <PlusIcon /> Add server
          </Button>
        }
      />
      {!check.ok && (
        <p role="alert" className="m-0 mb-2 text-body-sm text-danger">
          {check.reason}
        </p>
      )}
      {check.ok && check.approvedAt > 0 && (
        <p className="m-0 mb-2 text-body-sm text-secondary">
          Approved {new Date(check.approvedAt * 1000).toLocaleString()}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 mb-2 text-body-sm text-danger">
          {error}
        </p>
      )}
      <SettingsGroup>
        {list.servers.map((s) => {
          const conflict = inherited.some((i) => i.name === s.name);
          const missing = unset(s);
          return (
            <PreferenceRow
              key={s.name}
              title={s.name}
              subtitle={
                conflict
                  ? "Skipped: the agent's own config has a server with this name. Rename this one."
                  : missing.length
                    ? `Value not set on this device: ${missing.join(", ")}`
                    : s.transport === "stdio"
                      ? s.command
                      : s.url
              }
              trailing={
                <div className="flex items-center gap-2">
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setDraft(edit(s))}
                  >
                    Edit
                  </Button>
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void remove(s)}
                  >
                    Remove
                  </Button>
                  <Switch
                    aria-label={`Use ${s.name}`}
                    checked={s.enabled}
                    disabled={pending}
                    onCheckedChange={(on) => void toggle(s, on)}
                  />
                </div>
              }
            />
          );
        })}
        {inherited.map((i) => (
          <SwitchPreferenceRow
            key={`inherited:${i.name}`}
            label={i.name}
            description={i.source}
            checked={!list.disabledInherited.includes(i.name)}
            disabled={pending || !check.ok}
            onCheckedChange={(on) => void toggleInherited(i.name, on)}
          />
        ))}
        {!list.servers.length && !inherited.length && (
          <PreferenceRow title="No MCP servers" />
        )}
      </SettingsGroup>
      {draft && (
        <Dialog
          open
          onOpenChange={(open) => !open && setDraft(undefined)}
          title={draft.replacing ? "Edit MCP server" : "Add MCP server"}
          description="Values are kept on this device and never sync."
          actions={
            <>
              <Button variant="outline" onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
              <Button
                disabled={
                  pending || !!nameProblem(draft) || !draft.target.trim()
                }
                onClick={() => void submit(draft).catch(() => undefined)}
              >
                Save
              </Button>
            </>
          }
        >
          <Field label="Name" error={draft.name && nameProblem(draft)}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          {capability.transports.length > 1 && (
            <Select
              label="Transport"
              value={draft.transport}
              groups={[
                {
                  label: "Transport",
                  options: capability.transports.map((t) => ({
                    value: t,
                    label: t === "stdio" ? "Command" : "HTTP",
                  })),
                },
              ]}
              onValueChange={(value) =>
                setDraft({ ...draft, transport: value as McpTransport })
              }
            />
          )}
          <Field label={draft.transport === "stdio" ? "Command" : "URL"}>
            <Input
              value={draft.target}
              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
            />
          </Field>
          {draft.transport === "stdio" && (
            <Field label="Arguments" description="One per line">
              <Textarea
                value={draft.args}
                onChange={(e) => setDraft({ ...draft, args: e.target.value })}
              />
            </Field>
          )}
          <Field
            label={
              draft.transport === "stdio"
                ? "Environment variable names"
                : "Header names"
            }
            description="One per line"
          >
            <Textarea
              value={draft.keys}
              onChange={(e) => setDraft({ ...draft, keys: e.target.value })}
            />
          </Field>
          {lines(draft.keys).map((key) => (
            <Field
              key={key}
              label={key}
              description={
                saved.includes(envName(draft.name, key))
                  ? "Saved. Leave empty to keep it."
                  : "Not set on this device"
              }
            >
              <Input
                type="password"
                value={draft.values[key] ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    values: { ...draft.values, [key]: e.target.value },
                  })
                }
              />
            </Field>
          ))}
        </Dialog>
      )}
    </div>
  );
}
