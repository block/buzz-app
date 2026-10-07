import { afterEach, expect, it, vi } from "vitest";
import type { AgentDelivery } from "@buzz/author";
import { noLive } from "../../../../src/features/agent-types/live";
import { createRunner, RUN_TIMEOUT_MS } from "../src/run";
import type { Connect, Wire } from "../src/rpc";

afterEach(() => vi.useRealTimers());

function fixture(
  terminalsRemain = false,
  history?: (
    delivery: AgentDelivery<unknown>,
    signal: AbortSignal,
  ) => Promise<string>,
) {
  const saved = new Map<string, { threadId: string; signature: string }>();
  const published: string[] = [];
  const sent: Wire[] = [];
  const starts = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ] as const;
  const connections: { emit(message: Wire): void; closed: boolean }[] = [];
  let rejectResume = false;
  let turn = 0;
  let terminalReads = 0;
  const connect: Connect = async (_id, options) => {
    const connection = {
      emit: (message: Wire) => options.onLine(JSON.stringify(message)),
      closed: false,
    };
    connections.push(connection);
    const close = () => {
      connection.closed = true;
      options.signal.removeEventListener("abort", close);
      options.onClose(new Error("Closed"));
    };
    options.signal.addEventListener("abort", close, { once: true });
    return {
      close,
      async send(text) {
        const m: Wire = JSON.parse(text);
        sent.push(m);
        if (!m.method || m.id == null) return;
        if (m.method === "thread/backgroundTerminals/list") {
          connection.emit({
            id: m.id,
            result: {
              data:
                terminalReads++ === 0 || terminalsRemain
                  ? [{ processId: "42" }]
                  : [],
            },
          });
          return;
        }
        if (m.method === "thread/backgroundTerminals/terminate") {
          connection.emit({ id: m.id, result: { terminated: false } });
          return;
        }
        if (m.method === "thread/resume" && rejectResume) {
          connection.emit({
            id: m.id,
            error: { code: -32600, message: "Thread is missing" },
          });
          return;
        }
        connection.emit({
          id: m.id,
          result:
            m.method === "config/read"
              ? { config: {} }
              : m.method === "thread/start" || m.method === "thread/resume"
                ? { thread: { id: "session" } }
                : m.method === "turn/start"
                  ? { turn: { id: "turn" } }
                  : {},
        });
        if (m.method === "turn/start") starts[turn++]?.resolve();
      },
    };
  };
  const runner = createRunner(
    connect,
    {
      get: (key) => saved.get(key),
      set: (key, value) => {
        saved.set(key, value);
      },
      delete: (key) => {
        saved.delete(key);
      },
    },
    history,
  );
  const delivery = (content: string) =>
    ({
      event: { id: "event", pubkey: "owner", content, tags: [] },
      channelId: "channel",
      conversation: { channelName: "test" },
      agent: {
        id: "agent",
        pubkey: "bot",
        owner: "owner",
        name: "Codex",
        workspace: { path: "/tmp" },
        publish: async ({ content }: { content: string }) => {
          published.push(content);
          return { id: "published" };
        },
      },
      config: {},
      signal: new AbortController().signal,
      live: noLive,
      cancelQueued() {},
    }) as unknown as AgentDelivery<unknown>;
  const complete = (index: number) =>
    connections[index]?.emit({
      method: "turn/completed",
      params: {
        threadId: "session",
        turn: { id: "turn", status: "completed" },
      },
    });
  return {
    run: (text: string) => runner(delivery(text), "scope"),
    starts,
    connections,
    published,
    sent,
    complete,
    saved,
    rejectResume: () => {
      rejectResume = true;
    },
  };
}

it("gives queued work a full active deadline and publishes a timeout explanation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const first = f.run("First");
  await f.starts[0].promise;
  const queued = f.run("/queue Second");
  const timedOut = expect(queued).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS - 1);
  f.complete(0);
  await first;
  await f.starts[1].promise;
  await vi.advanceTimersByTimeAsync(1);
  expect(f.connections[1]?.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS - 1);
  await timedOut;
  expect(f.connections[1]?.closed).toBe(true);
  expect(f.published).toEqual([
    expect.stringContaining("without a final reply"),
    expect.stringContaining("29-minute work limit"),
  ]);
  expect(f.published.at(-1)).not.toContain("/reset");
});

it("recovers a missing saved session only after the owner's explicit reset", async () => {
  const f = fixture();
  f.saved.set(JSON.stringify(["scope", "agent", "channel", "channel"]), {
    threadId: "missing",
    signature: JSON.stringify(["bot", "/tmp"]),
  });
  f.rejectResume();
  await expect(f.run("Continue")).rejects.toThrow("Thread is missing");
  expect(f.published[0]).toContain("/reset");
  await f.run("/reset");
  expect(f.published[1]).toContain("previous Codex history is retained");
  const next = f.run("Start again");
  await f.starts[0].promise;
  f.complete(1);
  await next;
  expect(f.saved.values().next().value?.threadId).toBe("session");
});

it("rejects an interactive server request even when it has no thread ID", async () => {
  const f = fixture();
  const run = f.run("Work");
  await f.starts[0].promise;
  f.connections[0]?.emit({
    id: "refresh",
    method: "account/chatgptAuthTokens/refresh",
    params: {},
  });
  expect(f.sent).toContainEqual({
    id: "refresh",
    error: { code: -32601, message: expect.stringContaining("unsupported") },
  });
  f.complete(0);
  await run;
});

it.each([true, false])(
  "checks terminal cleanup before acknowledging stop (survives: %s)",
  async (survives) => {
    const f = fixture(survives);
    const run = f.run("Work");
    const result = survives
      ? expect(run).rejects.toThrow("background terminal")
      : run;
    await f.starts[0].promise;
    f.connections[0]?.emit({
      method: "turn/completed",
      params: {
        threadId: "session",
        turn: { id: "turn", status: "interrupted" },
      },
    });
    await result;
    expect(f.published).toEqual([
      expect.stringContaining(survives ? "could not finish" : "Stopped Codex"),
    ]);
  },
);

it("acknowledges an idle stop and a completed turn without final text", async () => {
  const f = fixture();
  await f.run("/stop");
  expect(f.published).toEqual([expect.stringContaining("not running")]);
  const run = f.run("Work");
  await f.starts[0].promise;
  f.complete(0);
  await run;
  expect(f.published.at(-1)).toContain("without a final reply");
});

it.each([false, true])(
  "preserves steering order across slow history reads and recovers after a failed read (%s)",
  async (rejectFirst) => {
    vi.useFakeTimers();
    const historyStarted = Promise.withResolvers<void>();
    const historyGate = Promise.withResolvers<string>();
    const f = fixture(false, async (delivery) => {
      if (delivery.event.content === "/steer Older") {
        historyStarted.resolve();
        return historyGate.promise;
      }
      return "";
    });
    const running = f.run("Work");
    await f.starts[0].promise;
    const older = f.run("/steer Older");
    const olderResult = rejectFirst
      ? expect(older).rejects.toThrow("History unavailable")
      : older;
    await historyStarted.promise;
    const newer = f.run("/steer Newer");
    // Drain ready promise jobs under the controlled clock while the older read
    // remains explicitly gated. No network/runner timing determines the order.
    await vi.advanceTimersByTimeAsync(0);
    if (rejectFirst) historyGate.reject(new Error("History unavailable"));
    else historyGate.resolve("");
    await Promise.all([olderResult, newer]);
    f.complete(0);
    await running;
    const sent = f.sent
      .filter((message) => message.method === "turn/steer")
      .map(
        (message) =>
          (message.params as { input: { text: string }[] }).input[0]?.text,
      );
    expect(sent).toEqual([
      ...(!rejectFirst ? [expect.stringContaining('Content: "Older"')] : []),
      expect.stringContaining('Content: "Newer"'),
    ]);
  },
);
