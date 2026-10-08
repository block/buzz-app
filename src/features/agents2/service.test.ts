import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import type { LiveBatch, LiveListener } from "../relay/incoming";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { AgentIdentity, AgentsNative } from "./native";
import { Agents2Service, type AgentType, type Delivery } from "./service";
import { memoryStorage } from "./test-fakes";

// Delete's channel step has its own coverage (relay-removal); here only its
// place in the order matters.
const steps: string[] = [];
const leaveChannels = vi.hoisted(() => vi.fn());
vi.mock("../agents/relay-removal", () => ({
  removeAgentFromChannels: leaveChannels,
}));

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
  const changes = new Set<() => void>();
  const archived = new Set<string>();
  const archives = {
    archived,
    consent: vi.fn(
      async () => ({ auth: ["auth"] }) as { auth: string[] } | null,
    ),
    ensure: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    state: (pubkey: string) =>
      archived.has(pubkey) ? "archived" : "not-archived",
    writable: true,
    request: vi.fn(async (_: string, pubkey: string) => {
      steps.push("archive");
      archived.add(pubkey);
    }),
  };
  const session = {
    archives,
    subscribeLive(listener: LiveListener) {
      live.add(listener);
      return () => live.delete(listener);
    },
  } as unknown as RelaySession;
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    origin: "https://relay.example.test",
    scope: `https://relay.example.test:${viewer}`,
    session,
  };
  const connected_ = snapshot;
  return {
    relay: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
    } as unknown as RelayData,
    /** Drops the connection, or restores it with a new session. */
    connect(connected: boolean) {
      snapshot = connected
        ? { ...connected_, session: { ...session } as RelaySession }
        : { status: "disconnected", generation: 2, session };
      for (const listener of changes) listener();
    },
    emit: (batch: LiveBatch) => {
      for (const listener of live) listener(batch);
    },
    archives,
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
    remove: vi.fn(async () => void steps.push("key")),
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
  return {
    service,
    native,
    storage,
    run,
    emit: fake.emit,
    connect: fake.connect,
    archives: fake.archives,
    ctx,
  };
}

/** Lets every pending promise chain finish: a macrotask runs only after the
 * microtask queue is empty, so this does not depend on how fast runners are. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
  steps.length = 0;
  leaveChannels.mockReset();
  leaveChannels.mockImplementation(async () => void steps.push("channels"));
});
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
    slug: "watch/channel",
    interest: { instructions: "Be brief." },
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

it("keeps queued work across a disconnect and runs it once on reconnect", async () => {
  const { service, run, emit, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  connect(false);
  expect(service.find(bot)).toBeUndefined();
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, { config: { reply: "new" } });
  connect(true);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].config).toEqual({ reply: "new" });
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
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
  await settle();
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
  await settle();
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

it("commits no identity when its record cannot be saved", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  const setItem = vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
    throw new Error("QuotaExceededError");
  });
  await expect(
    service.create({ type: "example/echo", name: "Echo" }),
  ).rejects.toThrow("QuotaExceededError");
  expect(native.commit).not.toHaveBeenCalled();
  // Memory did not take the failed write, so a later save cannot expose it.
  await service.create({ type: "example/echo", name: "Next" });
  expect(storage.getItem("buzz.agents2.v1")).not.toContain(bot);
  expect(service.snapshot().agents.map((agent) => agent.name)).toEqual([
    "Next",
  ]);
  setItem.mockRestore();
});

it("keeps the record of a create whose native commit fails, for the identity it may have left", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  native.commit.mockRejectedValueOnce(new Error("Credential store refused"));
  await expect(
    service.create({ type: "example/echo", name: "Echo" }),
  ).rejects.toThrow("Credential store refused");
  // Not shown without an identity, but there to manage one by after a reload.
  expect(service.find(bot)).toBeUndefined();
  expect(storage.getItem("buzz.agents2.v1")).toContain(bot);
});

it("returns the created agent after the community changes mid-create", async () => {
  const { service, native, connect } = await setup();
  native.commit.mockImplementationOnce(async (pubkey: string) => {
    connect(false);
    return { pubkey, relay: "wss://relay.example.test", owner: viewer };
  });
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  expect(agent).toMatchObject({ pubkey: bot, name: "Echo" });
  expect(service.find(bot)).toBeUndefined();
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

it("keeps an agent created while identities are still loading", async () => {
  const storage = memoryStorage();
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const native = fakeNative();
  let release: (value: AgentIdentity[]) => void = () => {};
  native.list.mockImplementationOnce(
    () => new Promise<AgentIdentity[]>((resolve) => (release = resolve)),
  );
  const service = new Agents2Service(ctx, fakeRelay().relay, native, storage);
  ctx
    .extend({ pluginOwner: Object.freeze({ id: "example", revision: "one" }) })
    .agents2.register<Config>({
      id: "echo",
      title: "Echo",
      defaults: () => ({ config: { reply: "ok" } }),
    });
  await vi.waitFor(() => expect(native.list).toHaveBeenCalled());
  await service.create({ type: "example/echo", name: "Echo" });
  release([]);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  expect(service.find(bot)?.name).toBe("Echo");
  expect(storage.getItem("buzz.agents2.v1")).toContain(bot);
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
        armed_at: 1_000,
        max_occurrences: 2,
        expires_at: null,
      },
      // Armed long ago with no run state: what was due counts as used, so it
      // neither fires at once nor ever (both of its runs are spent).
      "watch/stale": {
        type: "timer",
        interest_id: "default",
        prompt: "stale",
        enabled: true,
        interval_secs: 60,
        armed_at: 0,
        max_occurrences: 2,
        expires_at: null,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(55_000);
  expect(run).not.toHaveBeenCalled();
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
  expect(stored().timers["watch/stale"]).toMatchObject({ used: 16 });
  await service.save(bot, { attention: { "watch/tick": null } });
  expect(Object.keys(stored().timers)).toEqual(["watch/stale"]);
});

it("leaves its channels and archives it before removing the agent's key and record", async () => {
  const { service, native, storage, archives } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.remove(bot);
  expect(steps).toEqual(["channels", "archive", "key"]);
  expect(leaveChannels).toHaveBeenCalledWith(
    expect.objectContaining({ archives }),
    bot,
    expect.any(AbortSignal),
  );
  expect(archives.request).toHaveBeenCalledWith(
    "archive",
    bot,
    expect.any(AbortSignal),
  );
  expect(native.remove).toHaveBeenCalledWith(bot);
  expect(service.snapshot().agents).toEqual([]);
  expect(storage.getItem("buzz.agents2.v1")).not.toContain(bot);
});

it("keeps the key when a relay step of Delete fails, and retries without archiving twice", async () => {
  const { service, native, archives } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  leaveChannels.mockRejectedValueOnce(new Error("Channel removal refused"));
  await expect(service.remove(bot)).rejects.toThrow("Channel removal refused");
  archives.request.mockRejectedValueOnce(new Error("Archive refused"));
  await expect(service.remove(bot)).rejects.toThrow("Archive refused");
  expect(native.remove).not.toHaveBeenCalled();
  expect(service.find(bot)).toBeDefined();
  archives.request.mockClear();
  archives.archived.add(bot);
  await service.remove(bot);
  expect(archives.request).not.toHaveBeenCalled();
  expect(native.remove).toHaveBeenCalledWith(bot);
});

it("deletes an agent with no owner-attested profile without archiving it", async () => {
  const { service, native, archives } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  archives.consent.mockResolvedValueOnce(null);
  await service.remove(bot);
  expect(archives.request).not.toHaveBeenCalled();
  expect(native.remove).toHaveBeenCalledWith(bot);
});

it("refuses Delete outside the agent's community", async () => {
  const { service, native, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  connect(false);
  await expect(service.remove(bot)).rejects.toThrow(
    "Open this agent's community to delete it",
  );
  expect(leaveChannels).not.toHaveBeenCalled();
  expect(native.remove).not.toHaveBeenCalled();
});

it("runs once per matching watch, and passes a classifier watch it cannot classify", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, {
    attention: {
      "watch/classified": {
        type: "event",
        interest_id: "missing",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
        classifier: {
          questions: {
            deploy: {
              question: "Is it about a deploy?",
              true: "It is",
              false: "It is not",
              threshold: 0.5,
            },
          },
        },
      },
    },
  });
  emit({ events: [event("w", { content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const triggers = run.mock.calls.map(([delivery]) => delivery.trigger);
  expect(triggers).toEqual([
    expect.objectContaining({ slug: "watch/channel" }),
    expect.objectContaining({
      slug: "watch/classified",
      classifier: "not run",
    }),
  ]);
  // Its Interest does not exist, so it arrives without instructions.
  expect(triggers[1]).not.toHaveProperty("interest");
});

it("keeps DMs and reactions to its own messages away from watches", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, {
    attention: {
      "watch/everything": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
      },
    },
  });
  run.mockImplementationOnce(async ({ agent }) => {
    await agent.publish({ kind: 9, content: "hi", tags: [["h", channel]] });
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  emit({
    events: [
      event("dm", { kind: 4, tags: [["p", bot]] }),
      // p2 is what the run above published (p1 was the profile).
      event("like", { kind: 7, tags: [["e", "p2".padEnd(64, "0")]] }),
      event("note", { kind: 1 }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    type: "watch",
    slug: "watch/everything",
    event: { id: "note".padEnd(64, "0") },
  });
});

it("keeps an Interest while a watch still uses it", async () => {
  const { service } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await expect(
    service.save(bot, { attention: { "interest/default": null } }),
  ).rejects.toThrow(/use this Interest/);
  expect(service.find(bot)?.attention).toHaveProperty("interest/default");
  await service.save(bot, {
    attention: { "watch/channel": null, "interest/default": null },
  });
  expect(service.find(bot)?.attention).toEqual({});
});
