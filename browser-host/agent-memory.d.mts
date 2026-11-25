import type { MemoryListing } from "../src/features/agents/memory.ts";

export function memoryFilter(body: unknown, viewer: string): unknown[];
export function decodeAgentMemory(
  events: unknown,
  secret: Uint8Array,
  viewer: string,
  agent: string,
  signal: AbortSignal,
): Promise<MemoryListing>;
