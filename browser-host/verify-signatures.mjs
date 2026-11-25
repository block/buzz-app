import { availableParallelism, cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { schnorr } from "@noble/curves/secp256k1.js";

export const VERIFY_YIELD_CHUNK = 64;
const WORKER_URL = new URL("./verify-signatures-worker.mjs", import.meta.url);
const DEFAULT_THREADS = Math.max(
  1,
  Math.min(
    4,
    (typeof availableParallelism === "function"
      ? availableParallelism()
      : cpus().length) - 1 || 1,
  ),
);
const DEFAULT_MAX_QUEUED_CHUNKS = 512;

/** Mirror `relay_verify_signatures` / `signs()` in `src-tauri/src/relay.rs`. */
export function verifySignatureClaim(claim) {
  if (
    !claim ||
    typeof claim !== "object" ||
    typeof claim.id !== "string" ||
    typeof claim.pubkey !== "string" ||
    typeof claim.sig !== "string" ||
    !/^[0-9a-f]{64}$/i.test(claim.id) ||
    !/^[0-9a-f]{64}$/i.test(claim.pubkey) ||
    !/^[0-9a-f]{128}$/i.test(claim.sig)
  )
    return false;
  try {
    return schnorr.verify(
      Buffer.from(claim.sig, "hex"),
      Buffer.from(claim.id, "hex"),
      Buffer.from(claim.pubkey, "hex"),
    );
  } catch {
    return false;
  }
}

export async function verifySignatureClaims(claims, signal) {
  signal?.throwIfAborted();
  const results = new Array(claims.length);
  for (let i = 0; i < claims.length; i++) {
    if (i > 0 && i % VERIFY_YIELD_CHUNK === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
    results[i] = verifySignatureClaim(claims[i]);
  }
  return results;
}

const wireClaim = (claim) =>
  claim &&
  typeof claim === "object" &&
  typeof claim.id === "string" &&
  typeof claim.pubkey === "string" &&
  typeof claim.sig === "string"
    ? { id: claim.id, pubkey: claim.pubkey, sig: claim.sig }
    : null;

/** Bounded, lazy `worker_threads` pool so large browser-mode verification
 * batches scale across CPU cores without blocking the broker's event loop. */
export function createSignatureVerifierPool({
  threads = DEFAULT_THREADS,
  chunkSize = VERIFY_YIELD_CHUNK,
  maxQueuedChunks = DEFAULT_MAX_QUEUED_CHUNKS,
} = {}) {
  let closed = false;
  let nextJobId = 1;
  const workers = new Set();
  const idle = [];
  const active = new Map();
  const queue = [];

  function spawn() {
    const worker = new Worker(WORKER_URL, { execArgv: [] });
    workers.add(worker);
    worker.on("message", ({ id, results }) => {
      const job = active.get(worker);
      active.delete(worker);
      if (!closed) {
        worker.unref();
        idle.push(worker);
      }
      if (job && job.id === id && !job.task.settled) {
        if (!Array.isArray(results) || results.length !== job.claims.length) {
          job.task.fail(
            new Error(
              "Signature verification worker returned malformed output",
            ),
          );
        } else {
          for (let i = 0; i < results.length; i++)
            job.task.results[job.offset + i] = results[i] === true;
          if (--job.task.remaining === 0) job.task.succeed();
        }
      }
      pump();
    });
    const onDrop = (error) => {
      if (!workers.delete(worker)) return;
      const index = idle.indexOf(worker);
      if (index !== -1) idle.splice(index, 1);
      const job = active.get(worker);
      active.delete(worker);
      if (job && !job.task.settled) {
        job.task.fail(
          error instanceof Error
            ? error
            : new Error("Signature verification worker exited unexpectedly"),
        );
      }
      pump();
    };
    worker.on("error", onDrop);
    worker.on("exit", (code) => {
      if (code !== 0 || active.has(worker))
        onDrop(new Error(`Signature verification worker exited (${code})`));
      else {
        workers.delete(worker);
        const index = idle.indexOf(worker);
        if (index !== -1) idle.splice(index, 1);
      }
    });
    return worker;
  }

  function pump() {
    while (queue.length && !closed) {
      if (queue[0].task.settled) {
        queue.shift();
        continue;
      }
      let worker = idle.pop();
      if (!worker) {
        if (workers.size >= threads) return;
        try {
          worker = spawn();
        } catch (error) {
          while (queue.length) queue.shift().task.fail(error);
          return;
        }
      }
      const chunk = queue.shift();
      const id = nextJobId++;
      active.set(worker, { id, ...chunk });
      worker.ref();
      worker.postMessage({ id, claims: chunk.claims });
    }
  }

  function verify(claims, signal) {
    if (closed)
      return Promise.reject(new Error("Signature verifier pool is closed"));
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    if (!claims.length) return Promise.resolve([]);
    const chunkCount = Math.ceil(claims.length / chunkSize);
    if (queue.length + chunkCount > maxQueuedChunks) {
      const error = new Error("Signature verifier queue is full");
      error.code = "VERIFY_BUSY";
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const task = {
        results: new Array(claims.length),
        remaining: chunkCount,
        settled: false,
        succeed() {
          if (task.settled) return;
          task.settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(task.results);
        },
        fail(error) {
          if (task.settled) return;
          task.settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        for (let i = queue.length - 1; i >= 0; i--)
          if (queue[i].task === task) queue.splice(i, 1);
        task.fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      for (let offset = 0; offset < claims.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, claims.length);
        const slice = new Array(end - offset);
        for (let i = offset; i < end; i++)
          slice[i - offset] = wireClaim(claims[i]);
        queue.push({ task, offset, claims: slice });
      }
      pump();
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    const error = new Error("Signature verifier pool closed");
    while (queue.length) queue.shift().task.fail(error);
    for (const job of active.values()) job.task.fail(error);
    active.clear();
    idle.length = 0;
    for (const worker of [...workers]) {
      workers.delete(worker);
      void worker.terminate();
    }
  }

  return { verify, close };
}
