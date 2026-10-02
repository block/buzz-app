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
  const control = {
    snapshot: () => state as unknown as AgentControlState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    publishAs,
  } as unknown as AgentControl;
  return {
    control,
    publishAs,
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
  const register = () =>
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
