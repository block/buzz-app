import type { Event } from "nostr-tools";

/** Background Schnorr checks for bulk relay reads. Workers only answer
 * valid/invalid for copies the caller already owns; they never supply event data. */
type Reply = { ok: boolean; ms: number };
type Job = { events: readonly Event[]; settle: (reply?: Reply) => void };
/** Each worker holds at most one chunk, so a cancelled read's undispatched
 * chunks leave the queue instead of delaying the reads behind them. */
type Slot = { worker: Worker; job?: Job | undefined };

const CHUNK = 64;
const SIZE = Math.max(
  1,
  Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
);
/** Created on first use; empty once workers proved unavailable. */
let slots: Slot[] | undefined;
const queue: Job[] = [];

function spawn(): Slot {
  const worker = new Worker(new URL("./signature.worker.ts", import.meta.url), {
    type: "module",
  });
  const slot: Slot = { worker };
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    slot.job?.settle(data);
    slot.job = undefined;
    dispatch();
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
    slot.job?.settle();
  }
  for (const job of queue.splice(0)) job.settle();
  slots = [];
}

function dispatch() {
  for (const slot of slots ?? []) {
    if (slot.job) continue;
    const job = queue.shift();
    if (!job) return;
    slot.job = job;
    slot.worker.postMessage(job.events);
  }
}

/** Whether every signature is valid, plus summed worker time, or undefined when
 * the caller must check inline (no Worker support, or the workers failed) or the
 * read was cancelled. Cancelling drops chunks that have not reached a worker. */
export async function checkSignatures(
  events: readonly Event[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; ms: number } | undefined> {
  if (typeof Worker === "undefined" || signal?.aborted) return undefined;
  slots ??= start();
  if (!slots.length) return undefined;
  const jobs: Job[] = [];
  const replies: Promise<Reply | undefined>[] = [];
  for (let index = 0; index < events.length; index += CHUNK)
    replies.push(
      new Promise((settle) =>
        jobs.push({ events: events.slice(index, index + CHUNK), settle }),
      ),
    );
  const cancel = () => {
    for (const job of jobs) {
      const queued = queue.indexOf(job);
      if (queued >= 0) queue.splice(queued, 1);
      job.settle();
    }
  };
  queue.push(...jobs);
  signal?.addEventListener("abort", cancel, { once: true });
  dispatch();
  const settled = await Promise.all(replies);
  signal?.removeEventListener("abort", cancel);
  if (settled.some((reply) => !reply)) return undefined;
  return {
    ok: settled.every((reply) => reply?.ok),
    ms: settled.reduce((total, reply) => total + (reply?.ms ?? 0), 0),
  };
}
