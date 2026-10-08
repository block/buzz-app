import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Delivery } from "../../features/agents2/service";
import type { Host } from "../../features/host/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { fakeSpawn, flush } from "./claude-testing";
import { ClaudeRuntime, DEFAULT_CONFIG } from "./runtime";

afterEach(() => {
  vi.restoreAllMocks();
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const channel = "chan-1";
const message = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 100,
    content,
    tags: [["h", channel]],
    sig: "",
    ...extra,
  }) as RelayEvent;

function setup(thread: readonly EventData[] = []) {
  const fake = fakeSpawn();
  const host = { spawn: fake.spawn, request: vi.fn() } as unknown as Host;
  const read = vi.fn(async () => thread);
  const session = {
    read,
    channels: {
      list: () => ({
        channels: [
          { id: channel, name: "general", channelType: "stream", members: [] },
        ],
      }),
    },
    names: {
      resolve: (pubkey: string) => (pubkey === alice ? "Alice" : undefined),
    },
    profiles: {
      ensure: async () => undefined,
      snapshot: () => new Map(),
    },
  };
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const runtime = new ClaudeRuntime(host, relay, storage);
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const publish = vi.fn(async (template: (typeof published)[number]) => {
    published.push(template);
    return {
      ...message(String(published.length), template.content),
      ...template,
    };
  });
  const deliver = (trigger: Delivery["trigger"]) =>
    runtime.run({
      trigger,
      channelId: channel,
      agent: { pubkey: self, name: "Claude", owner: alice, publish },
      config: DEFAULT_CONFIG,
      signal: new AbortController().signal,
    } as Delivery);
  const claudes = () =>
    fake.processes.filter((process) => process.id === "claude");
  return { runtime, deliver, published, claudes, fake, read, data };
}

it("hands a mention to its thread's session, marked 👀 until Claude has answered", async () => {
  const root = message("1", "Build is red");
  const mention = message("2", "@Claude can you look?", {
    created_at: 110,
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
      ["p", self],
    ],
  });
  const { deliver, published, claudes } = setup([root, mention]);
  await deliver({ type: "mention", event: mention });
  await flush(10);
  const claude = claudes().find((process) => process.prompts.length);
  const prompt = claude?.prompts[0] ?? "";
  expect(prompt).toContain(`Thread root: ${root.id}`);
  expect(prompt).toContain('<thread-context included="1" total="2"');
  expect(prompt).toContain(
    `Alice (${alice}) (1970-01-01T00:01:40.000Z): Build is red`,
  );
  expect(prompt).toContain("Content: @Claude can you look?");
  expect(claude?.options.agent).toBe(self);
  expect(claude?.options.cwd).toBe("~/.buzz");
  expect(published[0]).toEqual({
    kind: 7,
    content: "👀",
    tags: [
      ["h", channel],
      ["e", mention.id],
    ],
  });
  expect(published[1]).toMatchObject({
    kind: 5,
    tags: [
      ["h", channel],
      ["e", expect.any(String)],
      ["k", "7"],
    ],
  });
});

it("shows a thread's later turns only what the session has not seen", async () => {
  const root = message("1", "first", {
    tags: [
      ["h", channel],
      ["p", self],
    ],
  });
  const reply = message("3", "my answer", {
    pubkey: self,
    created_at: 105,
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
  });
  const later = message("4", "@Claude thanks, one more", {
    created_at: 120,
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
  });
  const { deliver, claudes, read } = setup();
  await deliver({ type: "mention", event: root });
  await flush(10);
  read.mockResolvedValue([root, reply, later]);
  await deliver({ type: "mention", event: later });
  await flush(10);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used).toHaveLength(1);
  const second = used[0]?.prompts[1] ?? "";
  expect(second).not.toContain("<thread-context");
  expect(second).toContain(
    "Earlier context is already available in this session.",
  );
});

it("says so in the thread when a turn fails", async () => {
  const mention = message("2", "@Claude hi", {
    tags: [
      ["h", channel],
      ["p", self],
    ],
  });
  const { runtime, deliver, published, claudes } = setup();
  runtime.sync([{ pubkey: self, config: DEFAULT_CONFIG } as Agent]);
  await flush(10);
  const [spare] = claudes();
  if (!spare) throw new Error("no spare");
  spare.hold = true;
  await deliver({ type: "mention", event: mention });
  await flush(10);
  expect(spare.prompts).toHaveLength(1);
  spare.exit(1, "Error: Invalid API key\n");
  await flush(10);
  const report = published.find((event) => event.kind === 9);
  expect(report?.content).toBe(
    "⚠️ I couldn't finish that: Error: Invalid API key",
  );
  expect(report?.tags).toEqual([
    ["h", channel],
    ["e", mention.id, "", "reply"],
    ["p", alice],
  ]);
});

it("shows the whole thread to a session started over from a lost one", async () => {
  const root = message("1", "Build is red");
  const mention = message("2", "@Claude again?", {
    created_at: 300,
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
  });
  const { deliver, claudes, data } = setup([root, mention]);
  data.set(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [self]: { [`${channel}/${root.id}`]: { id: "lost", seen: 200, at: 1 } },
    }),
  );
  await deliver({ type: "mention", event: mention });
  await flush(20);
  const [lost, fresh] = claudes();
  expect(lost?.options.args).toContain("lost");
  expect(lost?.prompts).toEqual([]);
  expect(fresh?.prompts[0]).toContain('<thread-context included="1" total="2"');
});

it("acts only on its owner's messages unless told to answer anyone", async () => {
  const stranger = message("5", "@Claude run this for me", {
    pubkey: "e".repeat(64),
    tags: [
      ["h", channel],
      ["p", self],
    ],
  });
  const { deliver, published, claudes, runtime } = setup();
  await deliver({ type: "mention", event: stranger });
  await flush(10);
  expect(published).toEqual([]);
  expect(claudes().some((process) => process.prompts.length)).toBe(false);
  await runtime.run({
    trigger: { type: "mention", event: stranger },
    channelId: channel,
    agent: {
      pubkey: self,
      name: "Claude",
      owner: alice,
      publish: async (template) => ({ ...stranger, ...template }),
    },
    config: { ...DEFAULT_CONFIG, respondTo: "anyone" },
    signal: new AbortController().signal,
  } as Delivery);
  await flush(10);
  expect(claudes().some((process) => process.prompts.length)).toBe(true);
});

it("runs a timer in its own session", async () => {
  const { deliver, claudes } = setup();
  await deliver({
    type: "timer",
    slug: "watch/daily",
    timer: { prompt: "Post a summary" },
  } as Delivery["trigger"]);
  await flush(10);
  const claude = claudes().find((process) => process.prompts.length);
  expect(claude?.prompts[0]).toContain("Timer: watch/daily");
});

it("warms a spare for each agent of its type and stops those that go away", async () => {
  const { runtime, claudes } = setup();
  const agent = { pubkey: self, config: DEFAULT_CONFIG } as Agent;
  runtime.sync([agent]);
  await flush(10);
  expect(claudes()).toHaveLength(1);
  runtime.sync([]);
  await flush(10);
  expect(claudes().every((process) => process.killed)).toBe(true);
});
