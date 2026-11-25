import { useCallback, useEffect, useRef, useState } from "react";
import { DotsThreeIcon, PlusIcon } from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Badge } from "../../shared/design-system/ui/Badge";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import {
  approved,
  EMPTY_LIST,
  envName,
  isServer,
  KEY,
  type McpInherited,
  type McpList,
  type McpServer,
  type McpTransport,
  mcpValueNames,
  mcpValues,
  NAME,
  newSlot,
  saveMcp,
} from "../../features/agents/mcp-servers";
import type { Agent, Agents, AgentType } from "../../features/agents/service";
import styles from "./AgentEnvironment.module.css";

type Props = Readonly<{
  agents: Pick<Agents, "approveMcp" | "acceptedMcp">;
  agent: Agent;
  capability: NonNullable<AgentType["mcpServers"]>;
  /** Stops the agent's processes, so its next turn starts with the config. */
  restartAgent: () => Promise<void>;
}>;

/** Buzz's own tool server, in every harness. */
const BUZZ_TOOLS = "buzz";

/** The one server open for editing: a saved one to change, or a new one. */
type Value = Readonly<{ name: string; value: string }>;
type Draft = {
  replacing?: string;
  name: string;
  transport: McpTransport;
  target: string;
  args: string;
  keys: string;
  values: Record<string, string>;
};

// The environment variables section's tracks, with a column for the switch:
// the name takes the room, Value fits the Saved pill, then on/off and ⋯.
const ROW =
  "grid grid-cols-[minmax(0,1fr)_6.5rem_2.25rem_1.75rem] items-center gap-2 px-3 py-2";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const keysOf = (s: McpServer) => (s.transport === "stdio" ? s.env : s.headers);
const targetOf = (s: McpServer) =>
  s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url;
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** The agent's own MCP servers, and those from its harness's own config,
 * each with a switch. A change is signed as the owner's approval and syncs
 * with the agent's settings; values stay on this device. */
export function AgentMcpServers({
  agents,
  agent,
  capability,
  restartAgent,
}: Props) {
  const check = approved(
    (agent.config as { mcpServers?: unknown }).mcpServers,
    agent.owner,
    agent.pubkey,
  );
  const list: McpList = check.ok ? check.list : EMPTY_LIST;
  const [inherited, setInherited] = useState<readonly McpInherited[]>([]);
  // Whether a running process started on a harness config that has changed.
  const [changed, setChanged] = useState(false);
  const [saved, setSaved] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState<Draft | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const restart = useRef<HTMLButtonElement>(null);
  const notify = useToastNotification();
  useAgentSaveState(!!draft, pending || restarting);
  const read = useCallback(() => {
    void capability.inherited?.(agent).then(
      (found) => {
        setInherited(found.servers);
        setChanged(!!found.changed);
      },
      () => undefined,
    );
    void mcpValueNames(agent.pubkey).then(setSaved, () => undefined);
  }, [agent, capability]);
  useEffect(read, [read]);
  const locked = pending || restarting;
  /** Saves `next`, staging `values` first; nothing publishes if they, or
   * reading what they copy, fail. */
  const save = async (
    next: McpList,
    values: () => Promise<readonly Value[]> = async () => [],
    done = "Saved",
  ) => {
    setPending(true);
    setError(undefined);
    try {
      await saveMcp(
        agent.pubkey,
        next,
        await values(),
        async (list) => {
          if (!agents.approveMcp)
            throw new Error("MCP servers can't be set here");
          await agents.approveMcp(agent.key, list);
        },
        () => agents.acceptedMcp?.(agent.key),
      );
      setSaved(await mcpValueNames(agent.pubkey));
      setDraft(undefined);
      notify(done, "success");
    } catch (reason) {
      setError(message(reason));
      notify("Couldn't save MCP servers", "error");
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
  const serverOf = (d: Draft, slot: string, enabled: boolean): McpServer =>
    d.transport === "stdio"
      ? {
          name: d.name.trim(),
          enabled,
          slot,
          transport: "stdio",
          command: d.target.trim(),
          args: lines(d.args),
          env: lines(d.keys),
        }
      : {
          name: d.name.trim(),
          enabled,
          slot,
          transport: "http",
          url: d.target.trim(),
          headers: lines(d.keys),
        };
  const problem = (d: Draft) => {
    const name = d.name.trim();
    if (!NAME.test(name)) return "Use letters, numbers, - and _ only";
    if (name !== d.replacing && taken.has(name))
      return "A server already has this name. Choose another.";
    const keys = lines(d.keys);
    if (!keys.every((k) => KEY.test(k)))
      return "Use letters, numbers, ., - and _ in names";
    if (new Set(keys).size !== keys.length) return "A name is listed twice";
    if (!isServer(serverOf(d, "0".repeat(16), true)))
      return d.transport === "stdio"
        ? "Enter a command"
        : "Enter an http:// or https:// URL";
    return undefined;
  };
  const submit = async (d: Draft) => {
    const old = list.servers.find((s) => s.name === d.replacing);
    const keys = lines(d.keys);
    const typed = keys.filter((k) => d.values[k]);
    const same =
      old &&
      JSON.stringify(serverOf(d, old.slot, old.enabled)) ===
        JSON.stringify(old);
    // An edit that changes anything moves the server to a new slot, so the
    // published list never finds values meant for its old definition.
    const slot =
      same && !typed.length
        ? old.slot
        : newSlot(list.servers.map((s) => s.slot));
    const values = async () => {
      const kept =
        old && slot !== old.slot ? await mcpValues(agent.pubkey) : undefined;
      return keys.flatMap((key) => {
        const value = d.values[key] || kept?.[envName(old?.slot ?? "", key)];
        return value ? [{ name: envName(slot, key), value }] : [];
      });
    };
    const server = serverOf(d, slot, old?.enabled ?? true);
    await save(
      {
        ...list,
        servers: old
          ? list.servers.map((s) => (s === old ? server : s))
          : [...list.servers, server],
      },
      values,
    );
  };
  const toggle = (server: McpServer, enabled: boolean) =>
    save({
      ...list,
      servers: list.servers.map((s) => (s === server ? { ...s, enabled } : s)),
    });
  const toggleInherited = (name: string, enabled: boolean) =>
    save({
      ...list,
      disabledInherited: enabled
        ? list.disabledInherited.filter((n) => n !== name)
        : [...list.disabledInherited, name],
    });
  const remove = (server: McpServer) =>
    save(
      { ...list, servers: list.servers.filter((s) => s !== server) },
      undefined,
      "Removed",
    );
  const unset = (s: McpServer) =>
    keysOf(s).filter((k) => !saved.includes(envName(s.slot, k)));
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
  const old = draft && list.servers.find((s) => s.name === draft.replacing);
  const editor = (d: Draft) => (
    <form
      key={d.replacing ?? "new"}
      className="flex flex-col gap-2 px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(d);
      }}
    >
      <Input
        aria-label="Server name"
        controlSize="sm"
        placeholder="name"
        value={d.name}
        disabled={locked}
        autoFocus
        autoCapitalize="off"
        spellCheck={false}
        onValueChange={(name) => setDraft({ ...d, name })}
      />
      {capability.transports.length > 1 && (
        <Select
          label="Transport"
          value={d.transport}
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
            setDraft({ ...d, transport: value as McpTransport })
          }
        />
      )}
      <Input
        aria-label={d.transport === "stdio" ? "Command" : "URL"}
        controlSize="sm"
        placeholder={d.transport === "stdio" ? "Command" : "https://"}
        value={d.target}
        disabled={locked}
        autoCapitalize="off"
        spellCheck={false}
        onValueChange={(target) => setDraft({ ...d, target })}
      />
      {d.transport === "stdio" && (
        <Textarea
          aria-label="Arguments, one per line"
          placeholder="Arguments, one per line"
          value={d.args}
          disabled={locked}
          onChange={(e) => setDraft({ ...d, args: e.target.value })}
        />
      )}
      <Textarea
        aria-label={
          d.transport === "stdio"
            ? "Environment variable names, one per line"
            : "Header names, one per line"
        }
        placeholder={
          d.transport === "stdio"
            ? "Environment variable names, one per line"
            : "Header names, one per line"
        }
        value={d.keys}
        disabled={locked}
        onChange={(e) => setDraft({ ...d, keys: e.target.value })}
      />
      {lines(d.keys).map((key) => {
        const has = !!old && saved.includes(envName(old.slot, key));
        return (
          <Input
            key={key}
            aria-label={`Value of ${key}`}
            controlSize="sm"
            type="password"
            placeholder={has ? `${key}: saved, leave empty to keep` : key}
            value={d.values[key] ?? ""}
            disabled={locked}
            autoComplete="off"
            onValueChange={(value) =>
              setDraft({ ...d, values: { ...d.values, [key]: value } })
            }
          />
        );
      })}
      {d.name && problem(d) && (
        <p className="m-0 text-caption text-subtle">{problem(d)}</p>
      )}
      <span className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setDraft(undefined);
            setError(undefined);
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="prominent"
          disabled={!!problem(d)}
          loading={pending}
        >
          Save
        </Button>
      </span>
    </form>
  );
  const empty = !list.servers.length && !inherited.length && !draft;
  return (
    <div className="mt-section-gap">
      <InlineHeader
        title="MCP servers"
        subtitle={
          check.ok && check.approvedAt > 0
            ? `Servers this agent starts with, approved ${new Date(check.approvedAt * 1000).toLocaleString()}. Values stay on this device.`
            : "Servers this agent starts with. Values stay on this device."
        }
        actions={
          <Button
            size="sm"
            disabled={locked || !!draft || !check.ok}
            onClick={() => setDraft(edit())}
          >
            <PlusIcon size={17} aria-hidden="true" />
            Add server
          </Button>
        }
      />
      {!check.ok && (
        <div className="mb-2">
          <SettingsGroup>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <p role="alert" className="m-0 text-body-sm">
                {check.reason}
              </p>
              <Button
                size="sm"
                disabled={locked}
                loading={pending}
                onClick={() => void save(EMPTY_LIST, undefined, "Reset")}
              >
                Reset MCP servers
              </Button>
            </div>
          </SettingsGroup>
        </div>
      )}
      <SettingsGroup>
        {empty ? (
          <p className="m-0 px-3 py-4 text-center text-body-sm text-subtle">
            No MCP servers yet
          </p>
        ) : (
          <div
            className={`${ROW} ${styles.headings} text-caption text-subtle`}
            aria-hidden="true"
          >
            <span>Server</span>
            <span>Values</span>
            <span>On</span>
            <span />
          </div>
        )}
        {list.servers.map((s) => {
          if (draft?.replacing === s.name) return editor(draft);
          const conflict = inherited.some((i) => i.name === s.name);
          const missing = unset(s);
          return (
            <div key={s.name} className={ROW}>
              <span className="flex min-w-0 flex-col">
                <span
                  className="truncate font-mono text-body-sm"
                  title={s.name}
                >
                  {s.name}
                </span>
                {conflict ? (
                  // Wraps, so the rename it asks for is never cut off.
                  <span className="text-caption text-subtle">
                    Skipped: the harness's own config has a server with this
                    name. Rename this one.
                  </span>
                ) : (
                  <span
                    className="truncate text-caption text-subtle"
                    title={targetOf(s)}
                  >
                    {targetOf(s)}
                  </span>
                )}
              </span>
              <span>
                {keysOf(s).length === 0 ? null : missing.length ? (
                  <span title={`Not set on this device: ${missing.join(", ")}`}>
                    <Badge>Not set</Badge>
                  </span>
                ) : (
                  <Badge>
                    <span aria-hidden="true">•••••• </span>Saved
                  </Badge>
                )}
              </span>
              <Switch
                aria-label={`Use ${s.name}`}
                checked={s.enabled}
                disabled={locked || !!draft}
                onCheckedChange={(on) => void toggle(s, on)}
              />
              <span className="flex justify-end">
                <MenuRoot>
                  <MenuTrigger
                    render={
                      <IconButton
                        aria-label={`${s.name} actions`}
                        title={`${s.name} actions`}
                        icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                        disabled={locked || !!draft}
                      />
                    }
                  />
                  <MenuPopup align="end" size="compact">
                    <MenuItem onClick={() => setDraft(edit(s))}>Edit</MenuItem>
                    <MenuItem tone="danger" onClick={() => void remove(s)}>
                      Remove
                    </MenuItem>
                  </MenuPopup>
                </MenuRoot>
              </span>
            </div>
          );
        })}
        {inherited.map((i) => (
          <div key={`inherited:${i.name}`} className={ROW}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-body-sm" title={i.name}>
                {i.name}
              </span>
              <span className="truncate text-caption text-subtle">
                {i.source}
              </span>
            </span>
            <span />
            <Switch
              aria-label={`Use ${i.name}`}
              checked={!list.disabledInherited.includes(i.name)}
              disabled={locked || !!draft || !check.ok}
              onCheckedChange={(on) => void toggleInherited(i.name, on)}
            />
            <span />
          </div>
        ))}
        {draft && !draft.replacing && editor(draft)}
      </SettingsGroup>
      {capability.note && (
        <p className="m-0 mt-2 text-caption text-subtle">{capability.note}</p>
      )}
      {error && (
        <p role="alert" className="m-0 mt-2 text-body-sm">
          {error}
        </p>
      )}
      {changed && (
        <div className="mt-2">
          <SettingsGroup>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <p role="status" className="m-0 text-body-sm">
                Your {capability.label} config changed since this agent started.
                Restart the agent to apply it.
              </p>
              <Button
                ref={restart}
                size="sm"
                disabled={locked || !!draft}
                loading={restarting}
                focusableWhenDisabled
                onClick={() => setConfirm(true)}
              >
                Restart agent
              </Button>
            </div>
          </SettingsGroup>
        </div>
      )}
      {confirm && (
        <AlertDialog
          title="Restart this agent?"
          description="Its processes stop, and its next message starts them with your current config. Other agents keep running."
          finalFocus={restart}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  setConfirm(false);
                  setRestarting(true);
                  setError(undefined);
                  restartAgent()
                    .then(() => {
                      setChanged(false);
                      read();
                    })
                    .catch((reason: unknown) => setError(message(reason)))
                    .finally(() => setRestarting(false));
                }}
              >
                Restart
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
