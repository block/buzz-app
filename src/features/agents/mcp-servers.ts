// An agent's own MCP servers: a list its owner approves by signing it, kept in
// the agent's settings and synced with them. Another channel member can write
// the settings around it (NIP-AP) but can't sign the list, so a device starts
// only a list its owner signed. Values of env vars and headers never sync:
// they stay in this device's credential store (`agent_env.rs`), under names
// `envName` gives, and only their names are in the list. Each server's values
// sit under its `slot`, which a save that changes the server replaces, so a
// published list never finds values meant for another definition.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { verifyEvent, type EventTemplate } from "nostr-tools";
import type { RelayEvent } from "../relay/events";

/** The approval's kind. It is never published on its own: it travels inside
 * the agent's `buzz.agent.settings` body as `mcpServers`. */
export const MCP_APPROVAL_KIND = 45015;

export type McpServer = Readonly<
  { name: string; enabled: boolean; slot: string } & (
    | { transport: "stdio"; command: string; args: string[]; env: string[] }
    | { transport: "http"; url: string; headers: string[] }
  )
>;
export type McpTransport = McpServer["transport"];

export type McpList = Readonly<{
  servers: readonly McpServer[];
  /** Names of servers from the harness's own config the owner turned off. */
  disabledInherited: readonly string[];
}>;

/** A server from the harness's own config, where it says it came from. */
export type McpInherited = Readonly<{ name: string; source: string }>;

export const EMPTY_LIST: McpList = { servers: [], disabledInherited: [] };

/** A server name: what a harness can take as a key and a tool prefix. */
export const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** An env var or header name. */
export const KEY = /^[A-Za-z0-9_.-]{1,48}$/;
/** Where a server's values are kept: 16 lowercase hex digits. */
const SLOT = /^[0-9a-f]{16}$/;

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const isKeys = (v: unknown): v is string[] =>
  isStrings(v) && v.every((k) => KEY.test(k)) && new Set(v).size === v.length;

/** Whether `url` is an http(s) URL. */
export function isHttpUrl(url: string) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Whether `v` is a server a list can hold: the one check the form and the
 * parser share, so the owner can't sign what a launch refuses. */
export function isServer(v: unknown): v is McpServer {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== "string" || !NAME.test(s.name)) return false;
  if (typeof s.enabled !== "boolean") return false;
  if (typeof s.slot !== "string" || !SLOT.test(s.slot)) return false;
  return s.transport === "stdio"
    ? typeof s.command === "string" &&
        s.command.trim() !== "" &&
        isStrings(s.args) &&
        isKeys(s.env)
    : s.transport === "http" &&
        typeof s.url === "string" &&
        isHttpUrl(s.url) &&
        isKeys(s.headers);
}

/** The list in an approval's content, or undefined when it isn't one. */
export function listOf(content: string): McpList | undefined {
  try {
    const body = JSON.parse(content) as Record<string, unknown>;
    if (body.version !== 1) return undefined;
    const { servers, disabledInherited } = body;
    if (!Array.isArray(servers) || !servers.every(isServer)) return undefined;
    if (!isStrings(disabledInherited)) return undefined;
    if (new Set(servers.map((s) => s.name)).size !== servers.length)
      return undefined;
    if (new Set(servers.map((s) => s.slot)).size !== servers.length)
      return undefined;
    return { servers, disabledInherited };
  } catch {
    return undefined;
  }
}

const tag = (event: RelayEvent, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];
const seqOf = (event: RelayEvent) => Number(tag(event, "seq"));

/** The unsigned approval of `list` for `agent` at `seq`; the owner signs it. */
export const approvalTemplate = (
  agent: string,
  seq: number,
  list: McpList,
): EventTemplate => ({
  kind: MCP_APPROVAL_KIND,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["agent", agent],
    ["seq", String(seq)],
  ],
  content: JSON.stringify({ version: 1, ...list }),
});

/** The next approval's `seq`: past every one this device accepted and the
 * synced one, when it is the owner's for this agent. Nothing else counts, so
 * a forged head can't push the counter out of reach. */
export function nextSeq(agent: string, owner: string, current?: unknown) {
  const head = isEvent(current) && signedFor(current, owner, agent);
  // An unreadable record counts as none, so Reset can still replace it.
  const last = seen(agent);
  const seq = Math.max(last ? last.seq : 0, head ? seqOf(current) : 0) + 1;
  if (!Number.isSafeInteger(seq))
    throw new Error("These MCP servers can't be changed");
  return seq;
}

const isEvent = (v: unknown): v is RelayEvent =>
  !!v && typeof v === "object" && typeof (v as RelayEvent).sig === "string";

/** The approval a device last accepted, kept whole, so a settings save
 * that leaves it out doesn't read as never configured. One item per agent,
 * so a damaged record affects only its own agent. */
type Seen = { seq: number; id: string; event?: RelayEvent };
const SEEN_PREFIX = "buzz.agents.mcp-approval.v2:";
/** The record for `agent`: none when this device never accepted one, or
 * `false` when it can't be read or isn't a record, which is never "none". */
function seen(agent: string): Seen | undefined | false {
  // No storage at all, as outside a browser, has never kept a record.
  if (typeof localStorage === "undefined") return undefined;
  let text: string | null;
  try {
    text = localStorage.getItem(SEEN_PREFIX + agent);
  } catch {
    return false;
  }
  if (text === null) return undefined;
  try {
    const record = JSON.parse(text) as Partial<Seen> | null;
    if (
      !record ||
      typeof record !== "object" ||
      !Number.isSafeInteger(record.seq) ||
      (record.seq as number) <= 0 ||
      typeof record.id !== "string" ||
      (record.event !== undefined && !isEvent(record.event))
    )
      return false;
    return record as Seen;
  } catch {
    return false;
  }
}
const UNREADABLE =
  "This device can't read the MCP servers it used for this agent. Reset them to continue.";

/** Records `event` as the approval this device uses for `agent`: the owner's
 * own newest, once published, unless one accepted meanwhile is newer. It
 * replaces an unreadable record, which is how Reset recovers one. */
export function accept(agent: string, event: RelayEvent) {
  // Never back: a newer one, or the preferred one at its `seq`, accepted
  // meanwhile stays.
  const last = seen(agent);
  const seq = seqOf(event);
  if (last && (last.seq > seq || (last.seq === seq && last.id < event.id)))
    return;
  localStorage.setItem(
    SEEN_PREFIX + agent,
    JSON.stringify({ seq: seqOf(event), id: event.id, event }),
  );
}

/** Whether `pubkey` may approve `agent`'s server list. Today only its owner
 * may. A future team binding widens this to the members of the agent's
 * owning channel, never to the agent's own key. */
export const mayApprove = (pubkey: string, owner: string, agent: string) =>
  pubkey !== agent && pubkey === owner;

export type Approval =
  | Readonly<{
      ok: true;
      list: McpList;
      approvedAt: number;
      /** The approval's id, or none without one. */
      id?: string;
      /** Whether it is the one this device kept, the settings having none. */
      kept?: true;
    }>
  | Readonly<{ ok: false; reason: string }>;

/** Whether `event` is a valid approval signed for `agent` by one who may. */
function signedFor(event: RelayEvent, owner: string, agent: string) {
  try {
    return (
      event.kind === MCP_APPROVAL_KIND &&
      typeof event.pubkey === "string" &&
      mayApprove(event.pubkey, owner, agent) &&
      Array.isArray(event.tags) &&
      tag(event, "agent") === agent &&
      Number.isSafeInteger(seqOf(event)) &&
      seqOf(event) > 0 &&
      typeof event.content === "string" &&
      // Only its fields: nostr-tools trusts a mark a copy could carry.
      verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
      })
    );
  } catch {
    return false;
  }
}

/** The approval whose id a session's fingerprint holds: the one a launch
 * would use now, kept or synced. */
export const approvalId = (
  config: unknown,
  agent: Readonly<{ pubkey: string; owner: string }>,
) => {
  const check = approved(
    (config as { mcpServers?: unknown } | undefined)?.mcpServers,
    agent.owner,
    agent.pubkey,
  );
  return check.ok ? (check.id ?? null) : check.reason;
};

/** Whether this device accepts `approval` as `agent`'s list from `owner`. It
 * must be the owner's signed list for this agent, at a `seq` no older than
 * the newest this device accepted. At an equal `seq`, the lower event id
 * wins, so two devices that saved at once settle on the same list. Accepting
 * one records it. Without an approval, the agent has no servers. */
export function approved(
  approval: unknown,
  owner: string,
  agent: string,
): Approval {
  const last = seen(agent);
  if (last === false) return { ok: false, reason: UNREADABLE };
  if (approval === undefined) {
    if (!last) return { ok: true, list: EMPTY_LIST, approvedAt: 0 };
    // A settings save that left the list out: the one this device used.
    const kept = last.event;
    const list = kept && signedFor(kept, owner, agent) && listOf(kept.content);
    if (!kept || !list || kept.id !== last.id || seqOf(kept) !== last.seq)
      return {
        ok: false,
        reason:
          "This agent's settings no longer include the MCP servers this device used. Reset them to continue.",
      };
    return {
      ok: true,
      list,
      approvedAt: kept.created_at,
      id: kept.id,
      kept: true,
    };
  }
  const unapproved = { ok: false as const, reason: "MCP servers not approved" };
  if (!isEvent(approval) || !signedFor(approval, owner, agent))
    return unapproved;
  const event = { ...approval };
  const list = listOf(event.content);
  if (!list) return unapproved;
  const seq = seqOf(event);
  if (last && (seq < last.seq || (seq === last.seq && event.id > last.id)))
    return {
      ok: false,
      reason: "These MCP servers are older than ones this device has used",
    };
  if (!last || last.seq !== seq || last.id !== event.id || !last.event) {
    try {
      accept(agent, event);
    } catch {
      // Unrecorded, an older list could be taken for it later.
      return {
        ok: false,
        reason: "This device couldn't record the approved MCP servers",
      };
    }
  }
  return { ok: true, list, approvedAt: event.created_at, id: event.id };
}

const hex = (text: string) =>
  [...new TextEncoder().encode(text)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/** The prefix of every value kept under `slot`. */
export const slotPrefix = (slot: string) => `BUZZMCP_${slot.toUpperCase()}_`;

/** The variable a server's env var or header value is kept and passed under:
 * Buzz's prefix, the server's slot and the name in hex, so no two servers'
 * or names' values meet, even where names ignore case. Not a `BUZZ_` name,
 * which Buzz strips from agent processes. */
export const envName = (slot: string, name: string) =>
  `${slotPrefix(slot)}${hex(name)}`;

/** A new slot, none of `taken`. */
export function newSlot(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const slot = [...crypto.getRandomValues(new Uint8Array(8))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!used.has(slot)) return slot;
  }
}

/** The values of the agent's servers, by `envName`; empty without native.
 * Only harnesses that must send values in their protocol read them. */
export async function mcpValues(
  agent: string,
): Promise<Readonly<Record<string, string>>> {
  if (!isTauri()) return {};
  return invoke<Record<string, string>>("agent_mcp_env_values", { agent });
}

/** The value names saved for the agent here. */
export async function mcpValueNames(agent: string): Promise<readonly string[]> {
  if (!isTauri()) return [];
  const status = await invoke<{ names: string[] } | null>(
    "agent_mcp_env_status",
    { agent },
  );
  return status?.names ?? [];
}

const GENERATIONS = "buzz.agents.mcp-values-generation.v1";

function generations(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(GENERATIONS) ?? "{}") as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

/** Counts saves of the agent's values here, so a harness that keeps them
 * in a session can tell they changed without reading or hashing them. */
export const mcpGeneration = (agent: string) => generations()[agent] ?? 0;

/** Adds `rows` to the agent's saved values and deletes `remove`, leaving
 * every other value as it is. */
export async function saveMcpValues(
  agent: string,
  rows: readonly Readonly<{ name: string; value: string }>[],
  remove: readonly string[] = [],
) {
  if (!isTauri()) return;
  await invoke("agent_mcp_env_set", { agent, rows, remove });
  const all = generations();
  localStorage.setItem(
    GENERATIONS,
    JSON.stringify({ ...all, [agent]: (all[agent] ?? 0) + 1 }),
  );
}

const queues = new Map<string, Promise<unknown>>();
/** Runs `step` after the agent's earlier saves here, so a cleanup never
 * deletes values another save is staging. */
function serially<T>(agent: string, step: () => Promise<T>): Promise<T> {
  const run = (queues.get(agent) ?? Promise.resolve()).then(step, step);
  queues.set(
    agent,
    run.catch(() => undefined),
  );
  return run;
}

/** Saves `next` as the agent's list: stages `values` (new slots' values,
 * by `envName`) beside the saved ones and checks they're there, then has
 * `approve` sign and publish it. Only once that's confirmed does it delete
 * values that neither `next` nor the list `current` accepts now uses. A
 * failed or unknown publish deletes none, nor does a `current` that isn't
 * known or changes while it looks, since a newer list may need them. */
export function saveMcp(
  agent: string,
  next: McpList,
  values: readonly Readonly<{ name: string; value: string }>[],
  approve: (list: McpList) => Promise<void>,
  current: () => Approval | undefined,
) {
  return serially(agent, async () => {
    if (!next.servers.every(isServer))
      throw new Error("Check this server's settings");
    if (values.length) {
      await saveMcpValues(agent, values);
      const saved = new Set(await mcpValueNames(agent));
      if (isTauri() && !values.every((v) => saved.has(v.name)))
        throw new Error("These values couldn't be saved on this device");
    }
    await approve(next);
    const before = current();
    const names = await mcpValueNames(agent);
    const after = current();
    if (!before?.ok || !after?.ok || before.id !== after.id) return;
    const used = [...next.servers, ...after.list.servers].map((s) =>
      slotPrefix(s.slot),
    );
    const unused = names.filter(
      (name) => !used.some((prefix) => name.startsWith(prefix)),
    );
    if (unused.length)
      await saveMcpValues(agent, [], unused).catch(() => undefined);
  });
}

/** What a harness launches with: the enabled servers it may start, minus
 * any whose name the harness's own config already has (that one wins), and
 * the inherited names to turn off. */
export function launchList(
  list: McpList,
  inherited: readonly string[] = [],
): McpList {
  const taken = new Set(inherited);
  return {
    servers: list.servers.filter((s) => s.enabled && !taken.has(s.name)),
    disabledInherited: list.disabledInherited.filter((n) => taken.has(n)),
  };
}

/** The list an agent starts with from its config's `mcpServers`, as
 * `launchList` gives it; without `inherited`, its enabled servers and every
 * off name, for a harness that matches them against its own config at
 * launch. Throws, so the launch shows why, when the owner
 * didn't approve it. */
export function startList(
  config: unknown,
  agent: Readonly<{ pubkey: string; owner: string }>,
  inherited?: readonly string[],
): McpList {
  const check = approved(
    (config as { mcpServers?: unknown } | undefined)?.mcpServers,
    agent.owner,
    agent.pubkey,
  );
  if (!check.ok) throw new Error(check.reason);
  if (inherited) return launchList(check.list, inherited);
  return {
    servers: check.list.servers.filter((s) => s.enabled),
    disabledInherited: check.list.disabledInherited,
  };
}

const names = (s: McpServer) => (s.transport === "stdio" ? s.env : s.headers);

/** Claude Code's `--mcp-config` servers: values as `${VAR}` references,
 * which it expands from the process environment, so none is in its args. */
export function claudeServers(list: McpList) {
  const ref = (s: McpServer) =>
    Object.fromEntries(names(s).map((n) => [n, `\${${envName(s.slot, n)}}`]));
  return Object.fromEntries(
    list.servers.map((s) => [
      s.name,
      s.transport === "stdio"
        ? { type: "stdio", command: s.command, args: s.args, env: ref(s) }
        : { type: "http", url: s.url, headers: ref(s) },
    ]),
  );
}

/** A server's values by name, from `mcpValues`; an unset one is empty. */
export const valuesOf = (
  s: McpServer,
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    names(s).map((n) => [n, values[envName(s.slot, n)] ?? ""]),
  );

/** ACP `mcpServers` entries, values included: the protocol message is
 * where an ACP agent takes them. */
export function acpServers(
  list: McpList,
  values: Readonly<Record<string, string>>,
) {
  const pairs = (s: McpServer) =>
    Object.entries(valuesOf(s, values)).map(([name, value]) => ({
      name,
      value,
    }));
  return list.servers.map((s) =>
    s.transport === "stdio"
      ? { name: s.name, command: s.command, args: s.args, env: pairs(s) }
      : { type: "http" as const, name: s.name, url: s.url, headers: pairs(s) },
  );
}
