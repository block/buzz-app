import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import type { LiveBatch, LiveListener } from "../relay/incoming";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { AgentIdentity, AgentsNative } from "./native";
import { Agents2Service, type AgentType, type Delivery } from "./service";
import { memoryStorage } from "./test-fakes";

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const bot = "c".repeat(64);
const sibling = "d".repeat(64);
const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const event = (id: string, patch: Partial<RelayEvent> = {}) =>
  ({
    id: id.padEnd(64, "0"),
    pubkey: other,
    kind: 9,
    created_at: 100,
    content: `hello ${id}`,
    tags: [["h", channel]],
    sig: "",
    ...patch,
  }) as unknown as RelayEvent;

function fakeRelay() {
  const live = new Set<LiveListener>();
  const session = {
    subscribeLive(listener: LiveListener) {
      live.add(listener);
      return () => live.delete(listener);
    },
  } as unknown as RelaySession;
  const snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    origin: "https://relay.example.test",
    scope: `https://relay.example.test:${viewer}`,
    session,
  };
  return {
    relay: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
    } as unknown as RelayData,
    emit: (batch: LiveBatch) => {
      for (const listener of live) listener(batch);
    },
  };
}

function fakeNative(identities: AgentIdentity[] = []) {
  let published = 0;
  const keys = [bot, sibling];
  const native = {
    list: vi.fn(async () => [...identities]),
    prepare: vi.fn(async () => keys.shift() as string),
    authorize: vi.fn(async () => ["auth", viewer, "", "sig"]),
    commit: vi.fn(async (pubkey: string) => {
      const identity = {
        pubkey,
        relay: "wss://relay.example.test",
        owner: viewer,
      };
      identities.push(identity);
      return identity;
    }),
    remove: vi.fn(async () => {}),
    publish: vi.fn(async (pubkey: string, template: { kind: number }) =>
      event(`p${++published}`, { pubkey, kind: template.kind }),
    ),
  } satisfies AgentsNative;
  return native;
}

type Config = { reply: string };
async function setup({
  storage = memoryStorage(),
  identities = [] as AgentIdentity[],
} = {}) {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const fake = fakeRelay();
  const native = fakeNative(identities);
  const service = new Agents2Service(ctx, fake.relay, native, storage);
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "example", revision: "one" }),
  });
  const run = vi.fn<(delivery: Delivery<Config>) => void | Promise<void>>();
  const type: AgentType<Config> = {
    id: "echo",
    title: "Echo",
    defaults: () => ({
      config: { reply: "ok" },
      attention: {
        "interest/default": { type: "interest", instructions: "Be brief." },
        "watch/channel": {
          type: "event",
          interest_id: "default",
          enabled: true,
          since: 1,
          channels: [channel],
          kinds: [9],
          filter: 'content == "deploy"',
        },
      },
    }),
    run,
  };
  plugin.agents2.register(type);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  return { service, native, storage, run, emit: fake.emit, ctx };
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

it("creates an agent with the community's attestation and its type's defaults", async () => {
  const { service, native } = await setup();
  const agent = await service.create({ type: "example/echo", name: " Echo " });
  expect(native.prepare).toHaveBeenCalledWith(
    "https://relay.example.test",
    viewer,
  );
  expect(native.commit).toHaveBeenCalledWith(bot, ["auth", viewer, "", "sig"]);
  expect(native.publish).toHaveBeenCalledWith(bot, {
    kind: 0,
    content: JSON.stringify({ name: "Echo", bot: true }),
  });
  expect(agent).toMatchObject({
    pubkey: bot,
    name: "Echo",
    config: { reply: "ok" },
  });
  expect(Object.keys(agent.attention)).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  expect(service.find(bot)).toBe(agent);
});

it("delivers mentions and matching watches once, and never the agent's own events", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const mention = event("m", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  const watched = event("w", { content: "deploy" });
  emit({ events: [mention, mention, event("x"), watched], channelId: channel });
  emit({ events: [event("own", { pubkey: bot, content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const [first, second] = run.mock.calls.map(([delivery]) => delivery);
  expect(first?.trigger).toEqual({ type: "mention", event: mention });
  expect(second?.trigger).toMatchObject({
    type: "watch",
    event: watched,
    watches: [
      { slug: "watch/channel", interest: { instructions: "Be brief." } },
    ],
  });
  expect(first?.channelId).toBe(channel);
  expect(first?.config).toEqual({ reply: "ok" });
});

it("treats a reply to something the agent published as addressed", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  run.mockImplementationOnce(async ({ agent }) => {
    await agent.publish({ kind: 9, content: "hi", tags: [["h", channel]] });
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The publish above returned event p2 (p1 was the profile).
  emit({ events: [event("r", { tags: [["e", "p2".padEnd(64, "0")]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].trigger.type).toBe("mention");
});

it("keeps the in-flight run and the queue across edits; each job reads the agent as it starts", async () => {
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  let held: Delivery<Config> | undefined;
  run.mockImplementationOnce(
    (delivery) =>
      new Promise<void>((resolve) => {
        held = delivery;
        release = resolve;
      }),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(held).toBeDefined());
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, { name: "Echo two", config: { reply: "new" } });
  await service.save(bot, {
    attention: { "watch/channel": null },
  });
  expect(held?.signal.aborted).toBe(false);
  await held?.agent.publish({ kind: 7, content: "+" });
  expect(native.publish).toHaveBeenLastCalledWith(bot, {
    kind: 7,
    content: "+",
  });
  release();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const queued = run.mock.calls[1]?.[0];
  expect(queued?.config).toEqual({ reply: "new" });
  expect(queued?.agent.name).toBe("Echo two");
});

it("aborts the in-flight run, and drops what is queued, when the agent is removed", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let held: Delivery<Config> | undefined;
  run.mockImplementationOnce(
    (delivery) =>
      new Promise(() => {
        held = delivery;
      }),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(held).toBeDefined());
  await service.remove(bot);
  expect(held?.signal.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(run).toHaveBeenCalledTimes(1);
});

it("is not woken by reactions, deletions or DMs", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const ownMessage = "p1".padEnd(64, "0");
  emit({
    events: [
      event("react", {
        kind: 7,
        tags: [
          ["e", ownMessage],
          ["p", bot],
        ],
      }),
      event("delete", { kind: 5, tags: [["e", ownMessage]] }),
      event("dm", { kind: 4, tags: [["p", bot]] }),
    ],
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({ type: "mention" });
});

it("does not let one owner's agents wake each other by replying", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.create({ type: "example/echo", name: "Sibling" });
  run.mockImplementation(async ({ agent, trigger }) => {
    if (trigger.type === "timer") return;
    await agent.publish({ kind: 9, content: "hi" });
  });
  const start = event("start", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  emit({ events: [start] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The sibling replies to Echo's message, naming it, and also says "deploy",
  // which Echo's watch matches. Neither wakes Echo.
  const echoMessage = "p3".padEnd(64, "0");
  emit({
    events: [
      event("reply", {
        pubkey: sibling,
        content: "deploy",
        tags: [
          ["h", channel],
          ["e", echoMessage],
          ["p", bot],
        ],
      }),
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(run).toHaveBeenCalledTimes(1);
  // A fresh mention from the sibling still does.
  emit({
    events: [
      event("ask", {
        pubkey: sibling,
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
});

it("keeps a created agent when its profile cannot be published", async () => {
  const { service, native } = await setup();
  native.publish.mockRejectedValueOnce(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  expect(service.find(bot)).toBe(agent);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("forgets records whose key is gone when identities load", async () => {
  const storage = memoryStorage();
  storage.setItem(
    "buzz.agents2.v1",
    JSON.stringify({
      version: 1,
      agents: {
        [bot]: {
          pubkey: bot,
          type: "example/echo",
          name: "Echo",
          attention: {},
          config: {},
        },
        [sibling]: {
          pubkey: sibling,
          type: "example/echo",
          name: "Gone",
          attention: {},
          config: {},
        },
      },
    }),
  );
  const { service } = await setup({
    storage,
    identities: [
      { pubkey: bot, relay: "wss://relay.example.test", owner: viewer },
    ],
  });
  expect(service.snapshot().agents.map((agent) => agent.name)).toEqual([
    "Echo",
  ]);
  expect(storage.getItem("buzz.agents2.v1")).not.toContain(sibling);
});

it("fires a due timer once, then again an interval after it ran", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, {
    attention: {
      "watch/tick": {
        type: "timer",
        interest_id: "default",
        prompt: "check in",
        enabled: true,
        interval_secs: 60,
        armed_at: 0,
        max_occurrences: 2,
        expires_at: null,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    type: "timer",
    slug: "watch/tick",
    interest: { instructions: "Be brief." },
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run).toHaveBeenCalledTimes(2);
  // Its run state lives in the agent's record and goes when the timer does.
  const stored = () =>
    JSON.parse(storage.getItem("buzz.agents2.v1") ?? "{}").agents[bot];
  expect(stored().timers["watch/tick"]).toMatchObject({ used: 2 });
  await service.save(bot, { attention: { "watch/tick": null } });
  expect(stored().timers).toEqual({});
});

it("removes the agent's key and record", async () => {
  const { service, native, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.remove(bot);
  expect(native.remove).toHaveBeenCalledWith(bot);
  expect(service.snapshot().agents).toEqual([]);
  expect(storage.getItem("buzz.agents2.v1")).not.toContain(bot);
});
