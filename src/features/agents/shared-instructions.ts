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

/** Shared defaults travel with a launch, without changing the saved agent config. */
export function withSharedInstructions(shared: string, instructions: string) {
  return shared.trim()
    ? `Owner instructions are baseline preferences. Specific agent and team instructions and the current request take precedence.\n<owner-instructions>\n${shared.trim()}\n</owner-instructions>\n\n${instructions}`
    : instructions;
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
