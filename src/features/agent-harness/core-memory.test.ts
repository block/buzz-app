import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentMemories,
  type MemoryEntry,
  type MemoryListing,
} from "../agents/memory";
import { CoreMemory, coreMemorySection, readMemories } from "./core-memory";

const agent = "a".repeat(64);
const core = {
  slug: "core",
  body: "I am Claude.",
  eventId: "e".repeat(64),
  createdAt: 1,
};

function memories(read: (signal: AbortSignal) => Promise<MemoryListing>) {
  let open = 0;
  const owner = createAgentMemories(
    (_, signal) => read(signal),
    "b".repeat(64),
    () => true,
  );
  return {
    open: () => open,
    capability: {
      open(pubkey: string) {
        open++;
        const view = owner.capability.open(pubkey);
        const dispose = view.dispose;
        view.dispose = () => {
          open--;
          view.dispose = () => {};
          dispose();
        };
        return view;
      },
    },
  };
}

it("reads the agent's memories through a view it releases", async () => {
  const owner = memories(async () => ({ entries: [core], partial: false }));
  await expect(readMemories(owner.capability, agent)).resolves.toEqual([core]);
  expect(owner.open()).toBe(0);
});

it("fails when the memories cannot be read", async () => {
  const owner = memories(async () => {
    throw new Error("relay down");
  });
  await expect(readMemories(owner.capability, agent)).rejects.toThrow(
    "Memory unavailable (error)",
  );
  expect(owner.open()).toBe(0);
});

it("ends a read that is aborted while it is held", async () => {
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const owner = memories(
    (signal) =>
      new Promise((_, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const controller = new AbortController();
  const read = readMemories(owner.capability, agent, controller.signal);
  await reading;
  controller.abort(new Error("turn ended"));
  await expect(read).rejects.toThrow("turn ended");
  expect(owner.open()).toBe(0);
});

it("does not open a view for a read that is already aborted", async () => {
  const owner = memories(async () => ({ entries: [core], partial: false }));
  await expect(
    readMemories(owner.capability, agent, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(owner.open()).toBe(0);
});

it("shows core memory, prompts for one when there is none, and omits unknown", () => {
  expect(coreMemorySection(" I am Claude.\n")).toBe(
    "<core-memory>\nI am Claude.\n</core-memory>",
  );
  expect(coreMemorySection(null)).toContain("No core memory found.");
  expect(coreMemorySection(undefined)).toBe("");
  expect(coreMemorySection("  ")).toBe("");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("reuses a core memory read for five minutes", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => [core]);
  const memory = new CoreMemory(read);
  await expect(memory.get()).resolves.toBe("I am Claude.");
  vi.advanceTimersByTime(5 * 60_000 - 1);
  await memory.get();
  expect(read).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  await memory.get();
  expect(read).toHaveBeenCalledTimes(2);
});

it("shares one read between concurrent turns", async () => {
  const read = vi.fn(async () => [core]);
  const memory = new CoreMemory(read);
  await expect(Promise.all([memory.get(), memory.get()])).resolves.toEqual([
    "I am Claude.",
    "I am Claude.",
  ]);
  expect(read).toHaveBeenCalledTimes(1);
});

it("is null when the agent has none, and undefined while it cannot be read", async () => {
  await expect(new CoreMemory(async () => []).get()).resolves.toBeNull();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const read = vi.fn(async () => {
    throw new Error("relay down");
  });
  const failing = new CoreMemory(read);
  await expect(failing.get()).resolves.toBeUndefined();
  await failing.get();
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not keep a read that started before the agent wrote core", async () => {
  let release!: (entries: readonly MemoryEntry[]) => void;
  const read = vi
    .fn<() => Promise<readonly MemoryEntry[]>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue([{ ...core, body: "I am Claude, renamed." }]);
  const memory = new CoreMemory(read);
  const stale = memory.get();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  memory.forget();
  release([core]);
  await expect(stale).resolves.toBe("I am Claude.");
  await expect(memory.get()).resolves.toBe("I am Claude, renamed.");
});
