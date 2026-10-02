import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../agents/control";
import type { RelayEvent } from "../relay/events";
import type { LiveBatch, LiveListener } from "../relay/incoming";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  AgentTypesService,
  parseSubscription,
  type AgentDelivery,
  type AgentType,
} from "./service";

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const bot = "c".repeat(64);
const relayUrl = "wss://relay.example.test";
const event = (id: string, pubkey = other, content = `hello ${id}`) =>
  ({
    id: id.padEnd(64, "0"),
    pubkey,
    kind: 9,
    created_at: 1,
    content,
    tags: [["h", "c1"]],
    sig: "",
  }) as unknown as RelayEvent;
type Config = { channel?: string; word: string };
const agent = (config: Config, patch: Partial<AgentView> = {}) =>
  ({
    id: "bot-1",
    pubkey: bot,
    relayUrl,
    name: "Echo",
    revision: 1,
    enabled: true,
    status: "running",
    plugin: { type: "example/echo", config },
    ...patch,
  }) as AgentView;

function fakeRelay() {
  const listeners = new Set<() => void>();
  const sessions: { live: Set<LiveListener>; session: RelaySession }[] = [];
  const makeSession = () => {
    const live = new Set<LiveListener>();
    const session = {
      subscribeLive(listener: LiveListener) {
        live.add(listener);
        return () => live.delete(listener);
      },
    } as unknown as RelaySession;
    sessions.push({ live, session });
    return session;
  };
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    // A session's scope is its community's https origin and the viewer.
    scope: `https://relay.example.test:${viewer}`,
    session: makeSession(),
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  return {
    relay,
    sessions,
    emit(batch: LiveBatch) {
      for (const listener of sessions.at(-1)?.live ?? []) listener(batch);
    },
    replace() {
      snapshot = { ...snapshot, generation: 2, session: makeSession() };
      for (const listener of listeners) listener();
    },
  };
}

function fakeControl(agents: AgentView[], status = "ready") {
  const listeners = new Set<() => void>();
  let state = { status, data: { agents }, busy: false };
  const refresh = vi.fn(async () => {});
  const publishAs = vi.fn(async () => ({ id: "f".repeat(64), created_at: 2 }));
  const secret = vi.fn(async (_id: string, name: string) => `value of ${name}`);
  const workspace = {
    read: vi.fn(async (_id: string, path: string) => `text of ${path}`),
    write: vi.fn(async () => {}),
    list: vi.fn(async () => [{ name: "src", directory: true }]),
    exec: vi.fn(
      (_id: string, _command: string, options?: { signal?: AbortSignal }) =>
        new Promise<number | null>((_, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("Command was cancelled")),
          ),
        ),
    ),
  };
  const control = {
    snapshot: () => state as unknown as AgentControlState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    publishAs,
    secret,
    workspace,
  } as unknown as AgentControl;
  return {
    control,
    publishAs,
    secret,
    workspace,
    refresh,
    set(agents: AgentView[]) {
      state = { ...state, data: { agents } };
      for (const listener of listeners) listener();
    },
  };
}

function setup(agents: AgentView[], status?: string) {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const fake = fakeRelay();
  const native = fakeControl(agents, status);
  const service = new AgentTypesService(ctx, fake.relay, native.control);
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "example", revision: "one" }),
  });
  const run =
    vi.fn<(delivery: AgentDelivery<Config>) => void | Promise<void>>();
  const register = (extra: Partial<AgentType<Config>> = {}) =>
    plugin.agentTypes.register<Config>({
      id: "echo",
      title: "Echo",
      defaults: { word: "" },
      Configure: () => null,
      validate: (config) => (config.word ? undefined : "Enter a word"),
      subscription: (config) => ({
        kinds: [9],
        ...(config.channel ? { "#h": [config.channel] } : {}),
      }),
      run,
      ...extra,
    });
  return { ctx, fake, native, service, run, register };
}

it("reads the device's agents only once a type is registered", async () => {
  const { ctx, native, register } = setup([], "idle");
  expect(native.refresh).not.toHaveBeenCalled();
  register();
  expect(native.refresh).toHaveBeenCalledTimes(1);
  await ctx.fiber.dispose();
});

it("runs each enabled agent of a type as its own identity, from its own config", async () => {
  const quiet = agent(
    { channel: "elsewhere", word: "x" },
    { id: "bot-2", pubkey: "d".repeat(64) },
  );
  const off = agent({ word: "x" }, { id: "bot-3", enabled: false });
  const foreign = agent(
    { word: "x" },
    { id: "bot-4", relayUrl: "wss://other.example.test" },
  );
  const { ctx, fake, native, service, run, register } = setup([
    agent({ channel: "c1", word: "ping" }),
    quiet,
    off,
    foreign,
  ]);
  register();
  expect(service.activity()["bot-1"]?.subscription).toEqual([
    { kinds: [9], "#h": ["c1"] },
  ]);
  expect(Object.keys(service.activity()).sort()).toEqual(["bot-1", "bot-2"]);
  const message = event("m1");
  // The owner's messages are input; the agent's own are not.
  fake.emit({
    events: [message, event("m2", viewer), event("own", bot)],
    channelId: "c1",
  });
  fake.emit({ events: [message], channelId: "c1" });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const delivery = run.mock.calls[0]?.[0];
  expect(delivery).toMatchObject({
    event: message,
    channelId: "c1",
    config: { channel: "c1", word: "ping" },
    agent: { id: "bot-1", pubkey: bot, name: "Echo", owner: viewer },
  });
  // The identity can publish; it carries no key, session or UI object.
  expect(Object.keys(delivery?.agent ?? {}).sort()).toEqual([
    "id",
    "name",
    "owner",
    "pubkey",
    "publish",
    "secret",
  ]);
  await delivery?.agent.publish({ kind: 9, content: "pong" });
  expect(native.publishAs).toHaveBeenCalledWith("bot-1", {
    kind: 9,
    content: "pong",
    tags: [],
  });
  expect(service.activity()["bot-1"]).toMatchObject({ fired: 2, errors: 0 });
  await ctx.fiber.dispose();
});

it("recomputes the subscription on save and cuts off the replaced instance", async () => {
  const { ctx, fake, native, service, run, register } = setup([
    agent({ channel: "c1", word: "ping" }),
  ]);
  register();
  const deliveries: AgentDelivery<Config>[] = [];
  run.mockImplementation((delivery) => {
    deliveries.push(delivery);
    return new Promise<void>(() => {});
  });
  fake.emit({ events: [event("s1")], channelId: "c1" });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  native.set([agent({ word: "pong" }, { revision: 2 })]);
  expect(deliveries[0]?.signal.aborted).toBe(true);
  await expect(
    deliveries[0]?.agent.publish({ kind: 9, content: "late" }),
  ).rejects.toThrow();
  expect(native.publishAs).not.toHaveBeenCalled();
  expect(service.activity()["bot-1"]?.subscription).toEqual([{ kinds: [9] }]);
  fake.emit({ events: [event("s2")], channelId: "c2" });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(deliveries[1]?.config).toEqual({ word: "pong" });
  // A config the type rejects stops the agent listening and says why.
  native.set([agent({ word: "" }, { revision: 3 })]);
  expect(deliveries[1]?.signal.aborted).toBe(true);
  expect(service.activity()["bot-1"]).toMatchObject({
    lastError: "Not listening: Enter a word",
  });
  expect(service.activity()["bot-1"]?.subscription).toBeUndefined();
  fake.emit({ events: [event("s3")], channelId: "c2" });
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(2);
  await ctx.fiber.dispose();
});

it("stops on Stop and session replacement, and rebinds to the new session", async () => {
  const { ctx, fake, native, run, register } = setup([agent({ word: "x" })]);
  register();
  const signals: AbortSignal[] = [];
  run.mockImplementation(({ signal }) => {
    signals.push(signal);
    return new Promise<void>(() => {});
  });
  fake.emit({ events: [event("r1")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  fake.replace();
  expect(signals[0]?.aborted).toBe(true);
  expect(fake.sessions[0]?.live.size).toBe(0);
  fake.emit({ events: [event("r2")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  native.set([agent({ word: "x" }, { enabled: false, status: "stopped" })]);
  expect(signals[1]?.aborted).toBe(true);
  fake.emit({ events: [event("r3")] });
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(2);
  await ctx.fiber.dispose();
  expect(fake.sessions[1]?.live.size).toBe(0);
});

it("counts failures without stopping the agent and caps runs per minute", async () => {
  const { ctx, fake, service, run, register } = setup([agent({ word: "x" })]);
  register();
  run.mockImplementationOnce(() => {
    throw new Error("boom");
  });
  // Thirty at a time stays under the queue limit, so only the rate cap drops.
  for (const [batch, fired] of [
    ["a", 30],
    ["b", 60],
    ["c", 60],
  ] as const) {
    fake.emit({
      events: Array.from({ length: 30 }, (_, n) => event(`${batch}${n}-`)),
    });
    await vi.waitFor(() =>
      expect(service.activity()["bot-1"]?.fired).toBe(fired),
    );
  }
  expect(service.activity()["bot-1"]).toMatchObject({
    errors: 1,
    lastError: "boom",
    dropped: 30,
  });
  expect(run).toHaveBeenCalledTimes(60);
  await ctx.fiber.dispose();
});

it("accepts a subscription as plain filter data only", () => {
  const filter = { kinds: [9], "#h": ["c1"] };
  const [stored] = parseSubscription(filter);
  filter.kinds.push(7);
  expect(stored).toEqual({ kinds: [9], "#h": ["c1"] });
  expect(Object.isFrozen(stored?.kinds)).toBe(true);
  for (const subscription of [
    [],
    { search: "deploy" },
    { limit: 1 },
    { kinds: ["9"] },
    { "#p": viewer },
    { when: () => true },
  ])
    expect(() => parseSubscription(subscription)).toThrow();
});

it("shows a run's steps in its event's thread until the run ends", async () => {
  const { ctx, fake, service, run, register } = setup([agent({ word: "x" })]);
  register();
  let finish = () => {};
  run.mockImplementation(({ live }) => {
    const command = live.step({ kind: "command", label: "pnpm test" });
    const reply = live.step({ kind: "message" });
    reply.append("Hel");
    reply.append("lo");
    command.finish();
    return new Promise<void>((resolve) => {
      finish = () => {
        reply.finish({ published: "f".repeat(64) });
        resolve();
      };
    });
  });
  const root = "9".repeat(64);
  const mention = {
    ...event("l1"),
    tags: [
      ["h", "c1"],
      ["e", root, "", "reply"],
    ],
  } as RelayEvent;
  fake.emit({ events: [mention], channelId: "c1" });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(service.runs.snapshot()).toMatchObject([
    {
      agent: { id: "bot-1", pubkey: bot, name: "Echo" },
      channelId: "c1",
      eventId: mention.id,
      threadRootId: root,
      steps: [
        { kind: "command", label: "pnpm test", state: "done" },
        { kind: "message", text: "Hello", state: "running" },
      ],
    },
  ]);
  finish();
  await vi.waitFor(() => expect(service.runs.snapshot()).toEqual([]));
  // A top-level event is the root of the thread a reply starts. Without a channel
  // there is nowhere to show the run, and `live` does nothing.
  run.mockImplementation(({ live }) => {
    live.step({ kind: "thinking" }).append("…");
    return new Promise<void>(() => {});
  });
  const top = event("l2");
  fake.emit({ events: [top], channelId: "c1" });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(service.runs.snapshot()).toMatchObject([
    { eventId: top.id, threadRootId: top.id },
  ]);
  await ctx.fiber.dispose();
  expect(service.runs.snapshot()).toEqual([]);
});

it("runs up to the type's concurrency at once and the rest in order", async () => {
  const { ctx, fake, run, register } = setup([agent({ word: "x" })]);
  register({ concurrency: 2 });
  const ends: (() => void)[] = [];
  run.mockImplementation(
    () => new Promise<void>((resolve) => ends.push(resolve)),
  );
  fake.emit({ events: [event("p1"), event("p2"), event("p3")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(2);
  ends[0]?.();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(run.mock.calls[2]?.[0].event.id).toBe(event("p3").id);
  await ctx.fiber.dispose();
});

it("hands a run only the secrets its type declares", async () => {
  const { ctx, fake, native, run, register } = setup([agent({ word: "x" })]);
  register({ secrets: [{ name: "apiKey", label: "API key" }] });
  fake.emit({ events: [event("k1")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const identity = run.mock.calls[0]?.[0].agent;
  await expect(identity?.secret("apiKey")).resolves.toBe("value of apiKey");
  expect(native.secret).toHaveBeenCalledWith("bot-1", "apiKey");
  await expect(identity?.secret("PATH")).rejects.toThrow("no secret named");
  expect(native.secret).toHaveBeenCalledTimes(1);
  // Stopped: the function is no longer the agent.
  native.set([agent({ word: "x" }, { enabled: false, status: "stopped" })]);
  await expect(identity?.secret("apiKey")).rejects.toThrow();
  expect(native.secret).toHaveBeenCalledTimes(1);
  await ctx.fiber.dispose();
});

it("gives a run its agent's workspace only when the type asks and the owner chose one", async () => {
  const { ctx, fake, native, run, register } = setup([
    agent({ word: "x" }, { workspace: "/work" }),
    agent({ word: "x" }, { id: "bot-2", pubkey: "d".repeat(64) }),
  ]);
  register({ workspace: true });
  fake.emit({ events: [event("w1")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const [chosen, none] = run.mock.calls.map(([delivery]) => delivery.agent);
  expect(none?.workspace).toBeUndefined();
  const workspace = chosen?.workspace;
  expect(workspace?.path).toBe("/work");
  await expect(workspace?.readFile("a.ts")).resolves.toBe("text of a.ts");
  expect(native.workspace.read).toHaveBeenCalledWith("bot-1", "a.ts");
  await workspace?.writeFile("b.ts", "b");
  expect(native.workspace.write).toHaveBeenCalledWith("bot-1", "b.ts", "b");
  await expect(workspace?.list(".")).resolves.toEqual([
    { name: "src", directory: true },
  ]);
  // Stopping the agent kills a command in progress and refuses later calls.
  const command = workspace?.exec("sleep 60");
  native.set([
    agent(
      { word: "x" },
      { workspace: "/work", enabled: false, status: "stopped" },
    ),
  ]);
  await expect(command).rejects.toThrow("cancelled");
  await expect(workspace?.readFile("a.ts")).rejects.toThrow("no longer");
  await expect(workspace?.exec("ls")).rejects.toThrow("no longer");
  expect(native.workspace.exec).toHaveBeenCalledTimes(1);
  await ctx.fiber.dispose();
});

it("keeps a saved workspace from a type that does not ask for one", async () => {
  const { ctx, fake, run, register } = setup([
    agent({ word: "x" }, { workspace: "/work" }),
  ]);
  register();
  fake.emit({ events: [event("w2")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].agent.workspace).toBeUndefined();
  await ctx.fiber.dispose();
});

it("rejects a type whose concurrency or secrets are malformed", async () => {
  const { ctx, register } = setup([]);
  for (const extra of [
    { concurrency: 0 },
    { concurrency: 1.5 },
    { concurrency: 17 },
    { secrets: [{ name: "api-key", label: "API key" }] },
    { secrets: [{ name: "apiKey", label: "" }] },
    {
      secrets: [
        { name: "apiKey", label: "One" },
        { name: "apiKey", label: "Two" },
      ],
    },
  ] as Partial<AgentType<Config>>[])
    expect(() => register(extra)).toThrow();
  await ctx.fiber.dispose();
});
