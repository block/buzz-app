import * as React from "react";
import { apply } from "./index";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Delivery } from "../../features/agents2/service";
import type { RelayData } from "../../features/relay/service";
import type { EventData } from "../../features/relay/events";
import type { HostProcessOptions } from "../../features/host/service";
import { CodexRuntime } from "./runtime";
import type { Wire } from "./rpc";

const owner = "a".repeat(64);
const pubkey = "b".repeat(64);
const root = "c".repeat(64);
const scope = "https://relay.test:owner";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const runtimes: CodexRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes.length = 0;
  vi.unstubAllGlobals();
});

/** External app-server protocol fixture: turns complete only when released by
 * the test. The runtime owns routing, steering, cleanup and publication. */
function fixture(
  remainingTerminals: unknown[] = [],
  termination?: Promise<void>,
  plugin = false,
) {
  let terminals = remainingTerminals;
  let options: HostProcessOptions | undefined;
  let thread = 0;
  let turn = 0;
  const sent: Wire[] = [];
  const exits = deferred<number | null>();
  const storage = new Map<string, string>();
  const process = {
    write: async (data: string) => {
      const request: Wire = JSON.parse(data);
      sent.push(request);
      if (request.id == null) return;
      const params = request.params as Record<string, unknown>;
      let result: unknown = {};
      if (request.method === "model/list")
        result = {
          data: [
            {
              model: "test-model",
              isDefault: true,
              defaultReasoningEffort: "medium",
            },
          ],
          nextCursor: null,
        };
      if (request.method === "config/read")
        result = {
          config: {
            mcp_servers: {
              "company.tools": {
                command: "secret-tool",
                enabled: true,
                url: null,
              },
            },
          },
        };
      if (request.method === "thread/start")
        result = { thread: { id: `thread-${++thread}`, cwd: params.cwd } };
      if (request.method === "thread/resume")
        result = { thread: { id: params.threadId, cwd: params.cwd } };
      if (request.method === "turn/start")
        result = { turn: { id: `turn-${++turn}` } };
      if (request.method === "turn/interrupt")
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "interrupted" },
          },
        });
      if (request.method === "thread/backgroundTerminals/list")
        result = { data: terminals, nextCursor: null };
      if (
        request.method === "thread/backgroundTerminals/terminate" &&
        termination
      ) {
        await termination;
        terminals = [];
      }
      emit({ id: request.id, result });
    },
    end: vi.fn(async () => {
      exits.resolve(0);
    }),
    kill: vi.fn(async () => {
      exits.resolve(null);
    }),
    exited: exits.promise,
  };
  const spawn = vi.fn(async (_id: string, value?: HostProcessOptions) => {
    options = value;
    return process;
  });
  const emit = (value: Wire) =>
    options?.onStdout?.(`${JSON.stringify(value)}\n`);
  const publish = vi.fn(async (event: unknown) => ({
    ...(event as object),
    id: "d".repeat(64),
  }));
  const read = vi.fn(async () => [] as EventData[]);
  const snapshot = {
    status: "ready",
    scope: scope as string | undefined,
    session: {
      read,
      channels: {
        list: () => ({
          channels: [{ id: "channel", name: "test", channelType: "stream" }],
        }),
      },
    },
  };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  } as Storage;
  const runtime = new CodexRuntime(spawn, relay, store);
  runtimes.push(runtime);
  const agent = { pubkey, owner, name: "Codex", publish };
  runtime.sync([{ pubkey } as Agent], scope);
  let id = 0;
  const delivery = (content: string, threadRoot = root): Delivery => ({
    trigger: {
      type: "mention",
      event: {
        id: (++id).toString(16).padStart(64, "0"),
        pubkey: owner,
        kind: 9,
        content,
        created_at: 10,
        tags: [
          ["h", "channel"],
          ["e", threadRoot, "", "reply"],
        ],
      } as Extract<Delivery["trigger"], { type: "mention" }>["event"],
    },
    channelId: "channel",
    agent: agent as unknown as Delivery["agent"],
    config: {
      workspace: "/tmp/codex-test",
      model: "test-model",
      effort: "low",
      instructions: "TEST_INSTRUCTIONS",
    },
    signal: new AbortController().signal,
  });
  const selection = { selected: "community", viewer: owner };
  const listeners: (() => void)[] = [];
  let runPlugin: (delivery: Delivery) => Promise<void> = (delivery) =>
    runtime.run(delivery);
  let pluginDispose = () => {};
  if (plugin) {
    vi.stubGlobal("localStorage", store);
    apply({
      react: React,
      host: { spawn },
      communityReader: {
        snapshot: () => selection,
        subscribe: (listener: () => void) => {
          listeners.push(listener);
          return () => {};
        },
      },
      relay: {
        ...relay,
        subscribe: (listener: () => void) => {
          listeners.push(listener);
          return () => {};
        },
      },
      agents2: {
        snapshot: () => ({
          status: snapshot.status === "ready" ? "ready" : "loading",
          agents: [{ ...agent, type: "buzz.codex/codex" }],
        }),
        subscribe: (listener: () => void) => {
          listeners.push(listener);
          return () => {};
        },
        register: (type: { run: typeof runPlugin }) => {
          runPlugin = type.run;
        },
      },
      effect: (effect: () => () => void) => {
        pluginDispose = effect();
      },
    } as unknown as Parameters<typeof apply>[0]);
  }
  const starts = () => sent.filter((wire) => wire.method === "turn/start");
  const interrupt = () => {
    const index = starts().length - 1;
    const params = starts()[index]?.params as { threadId: string };
    emit({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: `turn-${index + 1}`, status: "interrupted" },
      },
    });
  };
  const complete = (index = starts().length - 1, text = "DONE") => {
    const params = starts()[index]?.params as { threadId: string };
    emit({
      method: "item/completed",
      params: {
        threadId: params.threadId,
        item: { type: "agentMessage", text, phase: "final_answer" },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: `turn-${index + 1}`, status: "completed" },
      },
    });
  };
  return {
    runtime,
    selection,
    runPlugin: (delivery: Delivery) => runPlugin(delivery),
    notify: () =>
      listeners.forEach((listener) => {
        listener();
      }),
    pluginDispose: () => pluginDispose(),
    spawn,
    process,
    sent,
    emit,
    publish,
    read,
    storage,
    delivery,
    starts,
    complete,
    interrupt,
    snapshot,
    exits,
  };
}
it("hands over promptly and runs conversations independently on one server", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.publish).not.toHaveBeenCalled();
  await f.runtime.run(f.delivery("@Codex independent", "e".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.complete(0, "FIRST");
  f.complete(1, "OTHER");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  const started = f.sent.find((wire) => wire.method === "thread/start")
    ?.params as Record<string, unknown>;
  expect(started).toMatchObject({
    model: "test-model",
    sandbox: "workspace-write",
    approvalPolicy: "never",
  });
  expect(started.baseInstructions).toBeUndefined();
  expect(started.developerInstructions).toContain("coding agent in Buzz");
  expect(f.starts()[0]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        kind: "application",
        value: expect.stringContaining("TEST_INSTRUCTIONS"),
      },
    },
  });
  expect((started.config as Record<string, unknown>).mcp_servers).toEqual({
    "company.tools": { enabled: false, command: "secret-tool" },
  });
  expect(started.config).toMatchObject({
    mcp_servers: { "company.tools": { enabled: false } },
    "features.apps": false,
    "features.plugins": false,
  });
  expect(f.spawn.mock.calls[0]?.[1]?.agent).toBeUndefined();
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9,
    content: "FIRST",
    tags: expect.arrayContaining([
      ["e", root, "", "root"],
      ["e", "1".padStart(64, "0"), "", "reply"],
    ]),
  });
});
it("serializes steering history reads and waits for them before final publication", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  const a = f.runtime.run(f.delivery("🤖 @Codex FIRST_STEER"));
  const b = f.runtime.run(f.delivery("SECOND_STEER"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve([]);
  }
  await Promise.all([a, b]);
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(2),
  );
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const steering = f.sent.filter((wire) => wire.method === "turn/steer");
  expect(JSON.stringify(steering[0]?.params)).toContain("FIRST_STEER");
  expect(JSON.stringify(steering[1]?.params)).toContain("SECOND_STEER");
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    tags: expect.arrayContaining([["e", "3".padStart(64, "0"), "", "reply"]]),
  });
});
it("cleans background terminals on server interruption and permits same-thread recovery", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Interrupted"),
  );
  expect(
    f.sent.some((wire) => wire.method === "thread/backgroundTerminals/clean"),
  ).toBe(true);
  expect(f.starts()).toHaveLength(1);
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("turn was interrupted"),
  });
  await f.runtime.run(f.delivery("recover"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    1,
  );
});
it("closes a native process returned after runtime disposal", async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  f.spawn.mockImplementationOnce(async (id, options) => {
    await original?.(id, options);
    started.resolve();
    return gate.promise;
  });
  await f.runtime.run(f.delivery("work"));
  await started.promise;
  f.runtime.dispose();
  try {
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve(f.process);
  }
  await f.exits.promise;
  expect(f.starts()).toHaveLength(0);
  expect(f.process.end).toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
it("ignores non-owner messages without spawning", async () => {
  const f = fixture();
  const other = f.delivery("work");
  if (other.trigger.type !== "timer")
    other.trigger.event.pubkey = "f".repeat(64);
  await f.runtime.run(other);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
it("publishes unexpected exit and empty-completion failures instead of silently losing work", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete(0, "");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("without a final reply"),
  });
  await f.runtime.run(f.delivery("next"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.publish.mock.calls[1]?.[0]).toMatchObject({
    content: expect.stringContaining("Codex exited"),
  });
});
it("ends the server on community change and suppresses a late final answer", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.runtime.sync([], "other-community");
  f.complete();
  await f.exits.promise;
  expect(f.process.end).toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it("reports an interruption cleanup failure when Codex reports surviving terminals", async () => {
  const f = fixture([{ processId: "42" }]);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining(
      "background terminals could not be stopped",
    ),
  });
  expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Needs attention");
  expect(f.process.end).toHaveBeenCalled();
});
it("restores a persisted binding after reload and starts fresh in a different workspace", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete();
  await vi.waitFor(() =>
    expect(f.sent.some((w) => w.method === "thread/unsubscribe")).toBe(true),
  );
  f.runtime.dispose();
  await f.exits.promise;
  const restored = fixture();
  for (const [key, value] of f.storage) restored.storage.set(key, value);
  await restored.runtime.run(restored.delivery("continue"));
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(1));
  expect(
    restored.sent.find((w) => w.method === "thread/resume")?.params,
  ).toMatchObject({ excludeTurns: true });
  restored.complete();
  await vi.waitFor(() =>
    expect(restored.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  const useDefaults = restored.delivery("defaults");
  await restored.runtime.run({
    ...useDefaults,
    config: { workspace: "/tmp/codex-test" },
  });
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(2));
  expect(restored.starts()[1]?.params).toMatchObject({
    model: "test-model",
    effort: "medium",
  });
  restored.complete();
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledTimes(2));
  const changed = restored.delivery("new workspace");
  await restored.runtime.run({
    ...changed,
    config: { workspace: "/tmp/different-workspace" },
  });
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(3));
  expect(restored.sent.some((w) => w.method === "thread/start")).toBe(true);
  expect(restored.starts()[2]?.params).toMatchObject({
    model: "test-model",
    effort: "medium",
  });
  restored.complete();
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledTimes(3));
});

it("waits for terminal termination after asynchronous clean acknowledgement before reporting interruption", async () => {
  const gate = deferred<void>();
  const f = fixture([{ processId: "42" }], gate.promise);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  try {
    await vi.waitFor(() =>
      expect(
        f.sent.some((w) => w.method === "thread/backgroundTerminals/terminate"),
      ).toBe(true),
    );
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("turn was interrupted"),
  });
  expect(f.process.end).not.toHaveBeenCalled();
});

it("publishes workspace errors without starting work", async () => {
  const f = fixture();
  await f.runtime.run({ ...f.delivery("hello"), config: {} });
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("absolute workspace"),
  });
  expect(f.spawn).not.toHaveBeenCalled();
});

it("publishes every answer part in order and excludes commentary", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const threadId = (f.starts()[0]?.params as { threadId: string } | undefined)
    ?.threadId;
  for (const [phase, text] of [
    ["commentary", "STATUS"],
    ["partial_answer", "PART ONE"],
    ["partial_answer", "PART TWO"],
  ])
    f.emit({
      method: "item/completed",
      params: { threadId, item: { type: "agentMessage", phase, text } },
    });
  f.complete(0, "FINAL");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: "PART ONE\n\nPART TWO\n\nFINAL",
  });
});
it("delivers a plain follow-up after startup without waiting for the running turn", async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  f.spawn.mockImplementationOnce(async (id, options) => {
    await original?.(id, options);
    started.resolve();
    return gate.promise;
  });
  await f.runtime.run(f.delivery("first"));
  await started.promise;
  try {
    await f.runtime.run(f.delivery("during startup"));
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve(f.process);
  }
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(1),
  );
  expect(f.starts()).toHaveLength(1);
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
});

it("keeps plugin work alive through relay reconnect and disposes on real community change", async () => {
  const f = fixture([], undefined, true);
  try {
    await f.runPlugin(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    f.snapshot.status = "connecting";
    f.snapshot.scope = undefined;
    f.notify();
    f.snapshot.status = "ready";
    f.snapshot.scope = scope;
    f.notify();
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    expect(f.process.end).not.toHaveBeenCalled();
    await f.runPlugin(f.delivery("more work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    f.selection.selected = "other-community";
    f.snapshot.status = "connecting";
    f.snapshot.scope = undefined;
    f.notify();
    f.complete();
    await f.exits.promise;
    expect(f.process.end).toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(1);
  } finally {
    f.pluginDispose();
  }
});

it("starts the next turn when completion races a plain follow-up's history read", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  await f.runtime.run(f.delivery("follow-up"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    f.complete(0, "FIRST");
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve([]);
  }
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(0);
  f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.publish.mock.calls[1]?.[0]).toMatchObject({ content: "SECOND" });
});

it.each(["/queue", "/stop", "/steer", "/reset"])(
  "delivers %s as ordinary steering text",
  async (command) => {
    const f = fixture();
    await f.runtime.run(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const content = `${command} ordinary text`;
    await f.runtime.run(f.delivery(content));
    await vi.waitFor(() =>
      expect(
        f.sent.filter((wire) => wire.method === "turn/steer"),
      ).toHaveLength(1),
    );
    const steer = f.sent.find((wire) => wire.method === "turn/steer")
      ?.params as { input: { text: string }[] };
    expect(steer.input[0]?.text).toContain(
      `Request: ${JSON.stringify(content)}`,
    );
    expect(f.publish).not.toHaveBeenCalled();
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  },
);
it("starts fresh instead of restoring an earlier plugin's conversation", async () => {
  const f = fixture();
  f.storage.set(
    `buzz.codex.sessions.v1:${scope}:${pubkey}`,
    JSON.stringify({
      [JSON.stringify(["channel", root])]: {
        threadId: "legacy-thread",
        workspace: "/tmp/codex-test",
      },
    }),
  );
  await f.runtime.run(f.delivery("new work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    0,
  );
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
});
