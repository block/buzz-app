// goose starts a loaded session's saved extensions as they were, before
// Buzz can change them, so a session resumes only on the MCP setup it was
// started on: the agent's approved list, whether it is strict, goose's own
// extension config, and which values the agent's servers have here. Any
// change leaves it for a new session. Values themselves are never hashed:
// a counter says they changed.
import { mcpGeneration } from "../../features/agents/mcp-servers";
import { REQUEST_TIMEOUT_MS, type GooseProcess } from "./goose";

const KEY = "buzz.goose.mcp-prints.v1";
/** Prints kept, newest last; older sessions start new. */
const KEPT = 500;

function prints(storage: Storage): [string, string][] {
  try {
    const read = JSON.parse(storage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(read) ? (read as [string, string][]) : [];
  } catch {
    return [];
  }
}

/** `value` with each header and env entry reduced to its name, so a print
 * never depends on a secret. */
function named(value: unknown, key = ""): unknown {
  if (
    (key === "headers" || key === "env") &&
    value &&
    typeof value === "object"
  )
    return (
      Array.isArray(value)
        ? value.map((entry) => (entry as { name?: unknown })?.name)
        : Object.keys(value)
    ).sort();
  if (Array.isArray(value)) return value.map((item) => named(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== "description" && k !== "display_name")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, named(v, k)]),
  );
}

/** goose's own extensions as v1.60.2 lists them: key, enabled and the
 * definition (type, command, args, URL, env and header names, socket,
 * scopes, tool allowlist, timeout), without values. goose doesn't list a
 * stdio server's working folder, so a change to only that isn't seen. */
async function nativeDefinitions(goose: Pick<GooseProcess, "request">) {
  const { extensions } = (await goose.request(
    "_goose/unstable/config/extensions/list",
    {},
    REQUEST_TIMEOUT_MS,
  )) as { extensions?: unknown[] };
  return (extensions ?? [])
    .map((e) => named(e))
    .sort((a, b) => {
      const ka = String((a as { configKey?: unknown }).configKey);
      const kb = String((b as { configKey?: unknown }).configKey);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/** The MCP setup a session for the agent would start on now. */
export async function mcpPrint(
  goose: Pick<GooseProcess, "request">,
  agent: string,
  config: unknown,
  strict: boolean,
): Promise<string> {
  const own = strict ? [] : await nativeDefinitions(goose);
  const list = (config as { mcpServers?: { id?: unknown } }).mcpServers?.id;
  const text = JSON.stringify([
    list ?? null,
    strict,
    own,
    mcpGeneration(agent),
  ]);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Notes the setup `session` started on. */
export function savePrint(storage: Storage, session: string, print: string) {
  const next = prints(storage).filter(([id]) => id !== session);
  next.push([session, print]);
  try {
    storage.setItem(KEY, JSON.stringify(next.slice(-KEPT)));
  } catch {
    // Unsaved, it starts a new session next time.
  }
}

/** Whether `session` started on `print`; one with no print never resumes. */
export const startedOn = (storage: Storage, session: string, print: string) =>
  prints(storage).some(([id, p]) => id === session && p === print);
