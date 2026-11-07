import { abortable } from "../agent-harness/core-memory";
import type { AgentStore } from "./store";

export const SHARED_INSTRUCTIONS_PREFIX = "buzz.owner-instructions.v1:";
export const SHARED_INSTRUCTIONS_LIMIT = 16 * 1024;

const key = (owner: string) => {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error("Account unavailable.");
  return `${SHARED_INSTRUCTIONS_PREFIX}${owner}`;
};
export { key as sharedInstructionsKey };

/** Device-local text shared by this owner's agents across communities. */
export function readSharedInstructions(storage: AgentStore, owner?: string) {
  return owner ? (storage.get(key(owner)) ?? "") : "";
}

/** Runtime snapshots wait for pending persistence and remain cancelable. */
export async function settledSharedInstructions(
  storage: AgentStore,
  owner: string | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  return (
    (await abortable(
      Promise.resolve().then(() => (owner ? storage.read(key(owner)) : null)),
      signal,
    )) ?? ""
  );
}

export async function saveSharedInstructions(
  storage: AgentStore,
  owner: string,
  text: string,
) {
  const value = text.trim();
  if (new TextEncoder().encode(value).length > SHARED_INSTRUCTIONS_LIMIT)
    throw new Error("Shared instructions must be 16 KB or less.");
  await storage.set(key(owner), value || null);
  return value;
}
