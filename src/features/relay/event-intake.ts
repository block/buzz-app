import type { CheckedResponse } from "./event-checks.ts";

type Settle = (checked: CheckedResponse | undefined) => void;
const pending = new Map<number, Settle>();
let nextRequest = 0;
// undefined: not started yet; null: unavailable, so this thread checks reads.
let worker: Worker | null | undefined;
// Until the worker has loaded, reads are checked here rather than waiting for it.
let loaded = false;

function intakeWorker() {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./event-intake.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return worker;
  }
  worker.onmessage = (
    message: MessageEvent<{ id?: number; checked?: CheckedResponse }>,
  ) => {
    if (message.data.id === undefined) {
      loaded = true;
      return;
    }
    pending.get(message.data.id)?.(message.data.checked);
    pending.delete(message.data.id);
  };
  // A worker that cannot load, crashes or sends an unreadable reply hands its
  // reads back to this thread.
  const fail = () => {
    worker?.terminate();
    worker = null;
    for (const settle of pending.values()) settle(undefined);
    pending.clear();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  return worker;
}

function checkOffThread(text: string) {
  return new Promise<CheckedResponse | undefined>((resolve) => {
    const target = intakeWorker();
    if (!target || !loaded) return resolve(undefined);
    const id = nextRequest++;
    pending.set(id, resolve);
    target.postMessage({ id, text });
  });
}

/** Relay read responses are parsed, checked and signature-verified in one
 * shared module worker, so none of that CPU runs on the main thread.
 * Undefined where workers are unavailable. Starts the worker. */
export function createResponseIntake() {
  return intakeWorker() ? checkOffThread : undefined;
}
