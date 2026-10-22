import { expect, it, vi, afterEach } from "vitest";
import { registerAttention } from "./attention-command";
import type { AttentionSource } from "./attention-sources";

afterEach(() => vi.useRealTimers());
type Input = Parameters<AttentionSource["run"]>[0];
function harness() {
  let run!: (input: Input) => Promise<void>;
  let output!: (text: string) => void;
  let exit!: (code: number) => void;
  const kill = vi.fn(async () => {
    exit(0);
  });
  registerAttention({
    agents: {
      addAttentionSource: (source) => {
        if (source.id === "command") run = source.run;
      },
    },
    host: {
      spawn: async (_id, options) => {
        output = options?.onStdout ?? (() => {});
        return {
          write: async () => {},
          end: async () => {},
          kill,
          exited: new Promise<number>((resolve) => {
            exit = resolve;
          }),
        };
      },
    },
  });
  const controller = new AbortController(),
    emit = vi.fn();
  return {
    run,
    controller,
    emit,
    kill,
    output: (text: string) => output(text),
    exit: (code: number) => exit(code),
  };
}
it("batches each burst, retries a refused queue, and drains the final output", async () => {
  vi.useFakeTimers();
  const h = harness();
  const done = h.run({
    agent: "a",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: "buzz.agents/command",
      channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      config: { command: ["check"] },
    },
    signal: h.controller.signal,
    emit: h.emit,
  });
  await Promise.resolve();
  h.output("first");
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.emit).toHaveBeenLastCalledWith("first");
  h.emit.mockImplementationOnce(() => {
    throw new Error("busy");
  });
  h.output("second");
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.emit).toHaveBeenLastCalledWith("second");
  h.output("last");
  h.exit(0);
  await done;
  expect(h.emit).toHaveBeenLastCalledWith("last");
});
it("kills execution on cancellation and discards buffered output", async () => {
  const h = harness();
  const done = h.run({
    agent: "a",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: "buzz.agents/command",
      channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      config: { command: ["check"] },
    },
    signal: h.controller.signal,
    emit: h.emit,
  });
  await Promise.resolve();
  h.output("pending");
  h.controller.abort();
  await done;
  expect(h.kill).toHaveBeenCalledTimes(1);
  expect(h.emit).not.toHaveBeenCalled();
});

it("keeps the process host receiver when starting a producer", async () => {
  let run!: (input: Input) => Promise<void>;
  const host = {
    spawn: vi.fn(async function (this: unknown) {
      expect(this).toBe(host);
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    }),
  };
  registerAttention({
    agents: {
      addAttentionSource: (source) => {
        if (source.id === "command") run = source.run;
      },
    },
    host,
  });
  await run({
    agent: "a",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: "buzz.agents/command",
      channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      config: { command: ["check"] },
    },
    signal: new AbortController().signal,
    emit: vi.fn(),
  });
  expect(host.spawn).toHaveBeenCalledTimes(1);
});

it("reports a process startup failure to the owning conversation", async () => {
  let run!: (input: Input) => Promise<void>;
  registerAttention({
    agents: {
      addAttentionSource: (source) => {
        if (source.id === "command") run = source.run;
      },
    },
    host: {
      spawn: async () => {
        throw new Error("program unavailable");
      },
    },
  });
  const emit = vi.fn();
  await run({
    agent: "a",
    watch: {
      type: "source",
      interest_id: "test",
      enabled: true,
      provider: "buzz.agents/command",
      channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      config: { command: ["check"] },
    },
    signal: new AbortController().signal,
    emit,
  });
  expect(emit).toHaveBeenCalledWith(
    expect.stringContaining("program unavailable"),
  );
});
