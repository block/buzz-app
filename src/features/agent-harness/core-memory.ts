// An agent's memory as the harness plugins read it. It is encrypted to the
// owner, so it is read back through the owner's session; no agent key is
// needed.
import type { createAgentMemories, MemoryEntry } from "../agents/memory";

type AgentMemories = ReturnType<typeof createAgentMemories>["capability"];

/** Reads the agent's memories once. Aborting `signal` ends the read. */
export async function readMemories(
  memories: AgentMemories,
  agent: string,
  signal?: AbortSignal,
): Promise<readonly MemoryEntry[]> {
  signal?.throwIfAborted();
  const view = memories.open(agent);
  const abort = () => view.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await view.refresh();
    signal?.throwIfAborted();
    const { status, listing } = view.snapshot();
    if (status !== "ready" || !listing)
      throw new Error(`Memory unavailable (${status})`);
    return listing.entries;
  } finally {
    signal?.removeEventListener("abort", abort);
    view.dispose();
  }
}

/** The `core` memory section of a prompt: its text, a prompt to create one
 * when it is `null`, or nothing when it is unknown or empty. */
export function coreMemorySection(memory: string | null | undefined) {
  const body =
    memory === null
      ? "No core memory found. Use `mem_set` with slug `core` to create one (it will hold your identity, rules, and goals across sessions). Ask your user about yourself."
      : memory?.trim();
  return body ? `<core-memory>\n${body}\n</core-memory>` : "";
}

/** How long a read of the agent's `core` memory is reused. */
const CORE_TTL_MS = 5 * 60_000;

/** An agent's `core` memory as a harness injects it into its prompt: its
 * text, `null` when it has none, or undefined when it could not be read. A
 * read, even a failed one, is reused for five minutes or until `forget`, and
 * concurrent turns share one. */
export class CoreMemory {
  private cached:
    | Readonly<{ value: string | null | undefined; at: number }>
    | undefined;
  private reading: Promise<string | null | undefined> | undefined;
  /** Bumped by `forget`, so a read started before a write is not kept. */
  private version = 0;
  constructor(
    private readonly read: () => Promise<
      readonly Pick<MemoryEntry, "slug" | "body">[]
    >,
  ) {}

  get(): Promise<string | null | undefined> {
    if (this.cached && Date.now() - this.cached.at < CORE_TTL_MS)
      return Promise.resolve(this.cached.value);
    if (this.reading) return this.reading;
    const version = this.version;
    const reading = (async () => {
      let value: string | null | undefined;
      try {
        const memories = await this.read();
        value = memories.find((memory) => memory.slug === "core")?.body ?? null;
      } catch (error) {
        console.warn("Could not read the agent's core memory", error);
      }
      if (version === this.version) this.cached = { value, at: Date.now() };
      return value;
    })().finally(() => {
      if (this.reading === reading) this.reading = undefined;
    });
    this.reading = reading;
    return reading;
  }

  /** After the agent writes `core`, the next turn reads it again. */
  forget() {
    this.version++;
    this.cached = undefined;
    this.reading = undefined;
  }
}
