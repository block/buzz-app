import type { Event } from "nostr-tools";

/** Background Schnorr checks for bulk relay reads. Workers only answer
 * valid/invalid for copies the caller already owns; they never supply event data. */
type Reply = { id: number; ok: boolean[]; ms: number };
type Slot = { worker: Worker; jobs: Map<number, (reply?: Reply) => void> };

const CHUNK = 64;
const SIZE = Math.max(
  1,
  Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
);
/** Created on first use; empty once workers proved unavailable. */
let slots: Slot[] | undefined;
let sequence = 0;

function spawn(): Slot {
  const worker = new Worker(new URL("./signature.worker.ts", import.meta.url), {
    type: "module",
  });
  const slot: Slot = { worker, jobs: new Map() };
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    slot.jobs.get(data.id)?.(data);
    slot.jobs.delete(data.id);
  };
  worker.onerror = disable;
  return slot;
}

function start() {
  const started: Slot[] = [];
  try {
    while (started.length < SIZE) started.push(spawn());
    return started;
  } catch {
    for (const slot of started) slot.worker.terminate();
    return [];
  }
}

/** A worker that cannot load or crashes sends every caller back to inline checks. */
function disable() {
  for (const slot of slots ?? []) {
    slot.worker.terminate();
    for (const settle of slot.jobs.values()) settle();
  }
  slots = [];
}

function run(slots: Slot[], events: readonly Event[]) {
  const slot = slots.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
  const id = ++sequence;
  return new Promise<Reply | undefined>((resolve) => {
    slot.jobs.set(id, resolve);
    try {
      slot.worker.postMessage({ id, events });
    } catch {
      slot.jobs.delete(id);
      resolve(undefined);
    }
  });
}

/** Per-event validity plus summed worker time, or undefined when the caller
 * must check inline (no Worker support, or the workers failed). */
export async function checkSignatures(
  events: readonly Event[],
): Promise<{ ok: boolean[]; ms: number } | undefined> {
  if (typeof Worker === "undefined") return undefined;
  slots ??= start();
  const pool = slots;
  if (!pool.length) return undefined;
  const chunks: Promise<Reply | undefined>[] = [];
  for (let index = 0; index < events.length; index += CHUNK)
    chunks.push(run(pool, events.slice(index, index + CHUNK)));
  const replies = await Promise.all(chunks);
  if (replies.some((reply) => !reply)) return undefined;
  return {
    ok: replies.flatMap((reply) => reply?.ok ?? []),
    ms: replies.reduce((total, reply) => total + (reply?.ms ?? 0), 0),
  };
}
