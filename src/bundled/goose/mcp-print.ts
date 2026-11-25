// goose starts a loaded session's saved extensions as they were, before
// Buzz can change them, so a session resumes only on the MCP setup it was
// started on: the agent's approved list, whether it is strict, goose's own
// extension config, and which values the agent's servers have here. Any
// change leaves it for a new session. Values themselves are never hashed:
// a counter says they changed.
import { mcpGeneration } from "../../features/agents/mcp-servers";
import { configExtensions, type GooseProcess } from "./goose";

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

/** The MCP setup a session for the agent would start on now. */
export async function mcpPrint(
  goose: Pick<GooseProcess, "request">,
  agent: string,
  config: unknown,
  strict: boolean,
): Promise<string> {
  const own = strict
    ? []
    : [...(await configExtensions(goose))].sort((a, b) =>
        a.configKey < b.configKey ? -1 : 1,
      );
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
