import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import type { VisibleEvent } from "../relay/projection";
import type { AgentControl, AgentView } from "./control";
import type { AgentProvider, AgentProviders, AgentWork } from "./providers";
import { bindAgentTriggers } from "./triggers";

const added = vi.hoisted(() => [] as [string, string][]);
vi.mock("../channel-members/members", () => ({
  addChannelMember: vi.fn(
    async (_session: unknown, channelId: string, pubkey: string) => {
      added.push([channelId, pubkey]);
    },
  ),
}));

const OWNER = `${"0".repeat(63)}1`;
const OTHER = `${"0".repeat(63)}2`;
const AGENT = "a".repeat(64);
const COMMUNITY = "wss://relay.example.test";
const CHANNEL = "11111111-1111-4111-8111-111111111111";
const STRANGER_CHANNEL = "22222222-2222-4222-8222-222222222222";
const NOW = 1_800_000_000;

function agentView(patch: Partial<AgentView> = {}): AgentView {
  return {
    id: "agent-1",
    pubkey: AGENT,
    relayUrl: COMMUNITY,
    name: "Acky",
    systemPrompt: "",
    workspace: "/w",
    harness: {
      command: "buzz.ackbot/ackbot",
      args: [],
      model: "",
      provider: "",
      environmentKeys: [],
    },
    revision: 1,
    runningRevision: null,
    enabled: false,
    status: "stopped",
    error: null,
    diagnostics: [],
    startOnAppLaunch: false,
    respondTo: "owner-only",
    backend: null,
    acpCommand: null,
    mcpCommand: null,
    launchModel: null,
    launchProvider: null,
    launchModelEnv: null,
    launchProviderEnv: null,
    restartDiff: [],
    provider: "buzz.ackbot/ackbot",
    providerConfig: { reply: "hi" },
    ...patch,
  };
}

function message(
  id: string,
  author: string,
  patch: Partial<VisibleEvent> = {},
): VisibleEvent {
  return {
    id: [...id]
      .map((c) => c.charCodeAt(0).toString(16))
      .join("")
      .padEnd(64, "0"),
    pubkey: author,
    created_at: NOW,
    kind: 9,
    content: `@Acky ${id}`,
    tags: [
      ["h", CHANNEL],
      ["p", AGENT],
    ],
    ...patch,
  };
}

function fixture(agent = agentView()) {
  let events: VisibleEvent[] = [];
  const reads: unknown[] = [];
  const incoming = new Set<() => void>();
  const lists = new Set<() => void>();
  let listStatus = "ready";
  const members = new Map([
    [CHANNEL, [OWNER, AGENT]],
    [STRANGER_CHANNEL, [OTHER, AGENT]],
  ]);
  const session = {
    viewer: OWNER,
    read: vi.fn(async (filters: { until?: number; limit: number }[]) => {
      reads.push(filters);
      const until = filters[0]?.until ?? Number.POSITIVE_INFINITY;
      return events
        .filter((event) => event.created_at <= until)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filters[0]?.limit);
    }),
    channels: {
      list: () => ({
        status: listStatus,
        channels: [...members].map(([id, list]) => ({ id, members: list })),
      }),
      ensureList: () => {},
      subscribeList(listener: () => void) {
        lists.add(listener);
        return () => lists.delete(listener);
      },
    },
    subscribeIncoming(listener: () => void) {
      incoming.add(listener);
      return () => incoming.delete(listener);
    },
  } as unknown as RelaySession;
  const control = {
    snapshot: () => ({
      status: "ready",
      busy: false,
      error: null,
      data: { runtimeAvailable: true, agents: [agent] },
    }),
    subscribe: () => () => {},
    refresh: async () => {},
    invoke: vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  } as unknown as AgentControl;
  const handled: AgentWork[] = [];
  const provider: AgentProvider = {
    id: "ackbot",
    title: "Ackbot",
    async handle(work, host) {
      handled.push(work);
      await host.invoke({ program: "buzz", args: ["x"] });
    },
  };
  let active = [
    {
      ...provider,
      key: "buzz.ackbot/ackbot",
      pluginId: "buzz.ackbot",
      revision: "1",
    },
  ];
  const providerListeners = new Set<() => void>();
  const providers = {
    snapshot: () => active,
    subscribe(listener: () => void) {
      providerListeners.add(listener);
      return () => providerListeners.delete(listener);
    },
    register() {},
  } as unknown as AgentProviders;
  const communities = {
    snapshot: () => ({ viewer: OWNER, selected: COMMUNITY, memberships: [] }),
    subscribe: () => () => {},
    relay: {
      snapshot: () => ({ status: "ready", session, viewer: OWNER }),
      subscribe: () => () => {},
    },
  } as unknown as Communities;
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  return {
    bind: () => bindAgentTriggers(control, providers, communities, storage),
    setEvents: (next: VisibleEvent[]) => {
      events = next;
    },
    arrive: () => {
      for (const listener of incoming) listener();
    },
    setListStatus: (status: string) => {
      listStatus = status;
      for (const listener of lists) listener();
    },
    store,
    disable: () => {
      active = [];
      for (const listener of providerListeners) listener();
    },
    reads,
    handled,
    control,
    members,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  added.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

test("an owner mention is handed to the provider once, as the agent", async () => {
  const f = fixture();
  const stop = f.bind();
  const top = message("top", OWNER);
  const reply = message("reply", OWNER, {
    created_at: NOW + 1,
    tags: [
      ["h", CHANNEL],
      ["e", top.id, "", "reply"],
      ["p", AGENT],
    ],
  });
  f.setEvents([reply, top]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.handled.map((work) => [work.message.id, work.replyTo])).toEqual([
    [top.id, top.id],
    [reply.id, top.id],
  ]);
  expect(f.handled[0]?.agent.config).toEqual({ reply: "hi" });
  expect(f.control.invoke).toHaveBeenCalledWith({
    program: "buzz",
    args: ["x"],
    id: "agent-1",
    provider: "buzz.ackbot/ackbot",
  });
  // One filter per agent, never before its first-seen floor.
  expect(f.reads[0]).toEqual([
    { kinds: [9], "#p": [AGENT], since: NOW + 1 - 60, limit: 100 },
  ]);
  f.arrive();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.handled).toHaveLength(2);
  stop();
});

test("owner-only ignores others, and the owner must be in the channel", async () => {
  const f = fixture();
  const stop = f.bind();
  f.setEvents([
    message("other", OTHER),
    message("stranger", OWNER, {
      tags: [
        ["h", STRANGER_CHANNEL],
        ["p", AGENT],
      ],
    }),
    message("self", AGENT),
    message("pending", OWNER, { delivery: "sending" }),
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.handled).toEqual([]);
  stop();
});

test("respond-to anyone admits other members", async () => {
  const f = fixture(agentView({ respondTo: "anyone" }));
  const stop = f.bind();
  f.setEvents([message("other", OTHER)]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.handled.map((work) => work.message.author)).toEqual([OTHER]);
  stop();
});

test("the owner invites a non-member agent before it acts", async () => {
  const f = fixture();
  f.members.set(CHANNEL, [OWNER]);
  const stop = f.bind();
  f.setEvents([message("invite", OWNER)]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(added).toEqual([[CHANNEL, AGENT]]);
  expect(f.handled).toHaveLength(1);
  stop();
});

test("a disabled provider reads nothing and dispatches nothing", async () => {
  const f = fixture();
  f.disable();
  const stop = f.bind();
  f.setEvents([message("waiting", OWNER)]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.reads).toEqual([]);
  expect(f.handled).toEqual([]);
  stop();
});

test("mentions wait for the channel roster instead of being dropped", async () => {
  const f = fixture();
  f.setListStatus("loading");
  const stop = f.bind();
  f.setEvents([message("early", OWNER, { created_at: NOW - 30 })]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.handled).toEqual([]);
  expect(f.reads).toEqual([]);
  f.setListStatus("ready");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.handled.map((work) => work.message.content)).toEqual([
    "@Acky early",
  ]);
  stop();
});

test("a full page reads back further and holds the floor if it runs out", async () => {
  const f = fixture();
  const stop = f.bind();
  f.setEvents(
    Array.from({ length: 250 }, (_, index) =>
      message(`m${index}`, OWNER, { created_at: NOW - 50 + (index % 50) }),
    ),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.handled).toHaveLength(250);
  expect(f.reads.length).toBeGreaterThan(1);
  stop();
});
