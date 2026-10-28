import { afterEach, expect, it, vi } from "vitest";

class FailingWorker {
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() {
    queueMicrotask(() => this.onmessage?.({ data: {} } as MessageEvent));
  }
  postMessage() {
    queueMicrotask(() => this.onerror?.());
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("hands reads back to the main thread when the worker fails", async () => {
  vi.stubGlobal("Worker", FailingWorker);
  const { createResponseIntake } = await import("./event-intake.ts");
  const intake = createResponseIntake();
  expect(intake).toBeDefined();
  await Promise.resolve();
  await expect(intake?.("[]")).resolves.toBeUndefined();
  await expect(intake?.("[]")).resolves.toBeUndefined();
});

it("is unavailable where workers are", async () => {
  vi.stubGlobal("Worker", undefined);
  const { createResponseIntake } = await import("./event-intake.ts");
  expect(createResponseIntake()).toBeUndefined();
});
