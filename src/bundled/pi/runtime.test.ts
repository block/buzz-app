import { afterEach, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { ownerReads } from "../../features/agents/reads";
import type { MemoryEntry } from "../../features/agents/memory";
import type {
  Agent,
  Delivery,
  StandaloneTurn,
} from "../../features/agents/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { deferred, fakeHost, type Handler } from "./pi-testing";
import { type Config, DEFAULT_CONFIG, PiRuntime } from "./runtime";

afterEach(() => {
  vi.restoreAllMocks();
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const channel = "chan-1";
const CONVERSATION = 7;
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
const root = message("1", "Build is red");
const reply = (id: string, content: string, created_at = 110) =>
  message(id, content, {
    created_at,
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
      ["p", self],
    ],
  });

function setup(
  handlers: Readonly<Record<string, Handler>> = {},
  added: readonly AddedTool[] = [],
  /** The channel's Canvas, as it reads now. */
  canvas?: { content: string; pubkey?: string },
) {
  let submissions = 0;
  const host = fakeHost({
    deliver: () => ({
      submission: ++submissions,
      conversation: CONVERSATION,
    }),
    once: () => ({ submission: ++submissions, conversation: 99 }),
    place: () => ({ seen: 0 }),
    wait: () => new Promise(() => {}),
    ...handlers,
  });
  /** Channels that are the owner's own Solo chats; the owner is the viewer. */
  const solo = new Set<string>();
  const session = {
    read: vi.fn(async () => [root]),
    agentMemories: {
      read: vi.fn(async () => ({
        entries: [] as readonly MemoryEntry[],
        partial: false,
      })),
    },
    channels: {
      list: () => ({
        channels: [
          { id: channel, name: "general", channelType: "stream", members: [] },
          ...[...solo].map((id) => ({ id, channelType: "solo", members: [] })),
        ],
      }),
    },
    names: {
      resolve: (pubkey: string) => (pubkey === alice ? "Alice" : undefined),
    },
    profiles: {
      ensure: vi.fn(async (): Promise<void> => {}),
      snapshot: () => new Map(),
      event: vi.fn((_key: string): RelayEvent | undefined => undefined),
    },
    channelWrites: { startingCanvas: () => undefined },
    canvas: {
      available: !!canvas,
      read: vi.fn(
        async () =>
          canvas && {
            pubkey: alice,
            kind: 40100,
            created_at: 100,
            tags: [],
            ...canvas,
          },
      ),
    },
  };
  const relay = {
    snapshot: () => ({ status: "ready", session, viewer: alice }),
  } as unknown as RelayData;
  const core = vi.fn(async () => null as string | null | undefined);
  const runtime = new PiRuntime(
    { spawn: host.spawn },
    (pubkey) => ownerReads(relay, pubkey),
    core,
    () => added,
  );
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    pubkey: self,
    name: "Pi",
    owner: alice,
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return { ...message(String(published.length), template.content) };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
    upload: vi.fn(),
    media: vi.fn(),
    remember: vi.fn(),
    attention: {
      enabled: () => true,
      classifier: () => "unavailable" as const,
      show: vi.fn(),
      interests: vi.fn(() => ["ops"]),
      watches: vi.fn(() => []),
      write: vi.fn(),
    },
  };
  const deliver = (
    trigger: Delivery["trigger"],
    extra: Partial<Delivery<Config>> = {},
  ) => {
    const receipt = {
      workingUntil: vi.fn<Delivery["workingUntil"]>(),
      ignored: vi.fn(),
      step: vi.fn(),
      acknowledged: vi.fn(),
      superseded: vi.fn(),
    };
    const run = runtime.run({
      trigger,
      channelId: channel,
      agent,
      config: DEFAULT_CONFIG,
      signal: new AbortController().signal,
      ...receipt,
      ...extra,
    } as unknown as Delivery);
    return { run, ...receipt };
  };
  /** What the turn `workingUntil` was given settled with. */
  const settled = (receipt: {
    workingUntil: { mock: { calls: unknown[][] } };
  }) =>
    receipt.workingUntil.mock.calls[0]?.[0] as Promise<{
      ok: boolean;
      error?: string;
    }>;
  const runOnce = (
    key: string,
    text: string | undefined,
    signal = new AbortController().signal,
  ) =>
    runtime.runOnce({
      delivery: { agent, config: DEFAULT_CONFIG },
      key,
      signal,
      prompt: async () => text,
    } as unknown as StandaloneTurn);
  return {
    runtime,
    host,
    deliver,
    runOnce,
    settled,
    published,
    agent,
    session,
    solo,
  };
}

it("hands an owner's mention to its thread's Pi conversation", async () => {
  const { host, deliver, published } = setup();
  const mention = reply("2", "@Pi can you look?");
  const turn = deliver(
    { type: "mention", event: mention },
    { model: "claude-x", effort: "high" },
  );
  await turn.run;
  const [open] = host.requests("open");
  const tools = ((open?.params.tools ?? []) as { name: string }[]).map(
    (tool) => tool.name,
  );
  expect(tools).toEqual(expect.arrayContaining(["send", "read"]));
  // Loaded up front or on search, and what the search can find.
  const listed = open?.params.tools as { name: string; load: string }[];
  expect(listed.find((tool) => tool.name === "send")?.load).toBe("always");
  expect(listed.find((tool) => tool.name === "watch_add")?.load).toBe("search");
  expect(String(open?.params.hint)).toContain("Search for the rest");
  const [delivered] = host.requests("deliver");
  expect(delivered?.params).toMatchObject({
    agent: self,
    key: `${channel}/${root.id}`,
    at: 110,
    context: { channel, root: root.id },
    request: mention.id,
    provider: "",
    model: "",
    // The owner's pick, apart, so a steer changes only what it names.
    pick: { model: "claude-x", thinking: "high" },
    cwd: "~/.buzz",
  });
  const text = String(delivered?.params.text);
  expect(text).toContain(`Thread root: ${root.id}`);
  expect(text).toContain(`Alice (${alice})`);
  expect(text).toContain("Build is red");
  expect(text).toContain("Content: @Pi can you look?");
  expect(String(delivered?.params.steer)).toContain("@Pi can you look?");
  expect(String(delivered?.params.instructions)).toContain(self);
  expect(turn.workingUntil).toHaveBeenCalledTimes(1);
  expect(published).toEqual([]);
});

it("shows a conversation only the messages it was not shown, nor its own replies", async () => {
  const { host, deliver, session } = setup({ place: () => ({ seen: 105 }) });
  const later = (id: string, content: string, pubkey: string, at: number) => ({
    ...reply(id, content, at),
    pubkey,
  });
  session.read.mockResolvedValue([
    root,
    later("5", "Earlier from Pi", self, 107),
    later("6", "Bob checked it", bob, 108),
  ]);
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  const text = String(host.requests("deliver")[0]?.params.text);
  expect(text).toContain("Bob checked it");
  expect(text).not.toContain("Build is red");
  expect(text).not.toContain("Earlier from Pi");
});

it("ignores a mention from someone who is not the owner", async () => {
  const { host, deliver } = setup();
  const turn = deliver({
    type: "mention",
    event: { ...reply("2", "@Pi rm -rf"), pubkey: bob },
  });
  await turn.run;
  expect(turn.ignored).toHaveBeenCalled();
  expect(host.processes).toEqual([]);
});

it("shows a conversation's activity on the request Pi took last", async () => {
  let entries = 0;
  const { host, deliver } = setup({
    // Pi says it took each request before it answers.
    deliver: (params, process) => {
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: ++entries,
        },
      });
      return { submission: 1, conversation: CONVERSATION };
    },
  });
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run;
  await vi.waitFor(() => expect(first.acknowledged).toHaveBeenCalled());
  const second = deliver({ type: "mention", event: reply("3", "@Pi also") });
  await vi.waitFor(() => expect(second.acknowledged).toHaveBeenCalled());
  expect(first.superseded).toHaveBeenCalled();
  host.processes[0]?.send({
    method: "event",
    params: {
      agent: self,
      conversation: CONVERSATION,
      type: "step",
      tool: "bash",
      target: "npm test",
    },
  });
  await vi.waitFor(() =>
    expect(second.step).toHaveBeenCalledWith("bash", "npm test"),
  );
  expect(first.step).not.toHaveBeenCalled();
});

it("says which conversations a request works in, and lists the agent's places", async () => {
  const answered = deferred<unknown>();
  const { runtime, deliver, settled } = setup({
    deliver: (params, process) => {
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: 1,
        },
      });
      return { submission: 1, conversation: CONVERSATION };
    },
    wait: () => answered.promise,
    places: () => ({
      places: [
        { key: `${channel}/${root.id}`, conversation: CONVERSATION, seen: 110 },
        { key: "dm-1", conversation: 8, seen: 120 },
      ],
    }),
  });
  const changed = vi.fn();
  runtime.subscribe(changed);
  expect(runtime.working(self)).toEqual([]);
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await vi.waitFor(() => expect(runtime.working(self)).toEqual([CONVERSATION]));
  expect(changed).toHaveBeenCalled();
  // One view until it changes, as useSyncExternalStore needs.
  expect(runtime.working(self)).toBe(runtime.working(self));
  answered.resolve({ status: "done", answer: 1, text: "" });
  await settled(turn);
  expect(runtime.working(self)).toEqual([]);

  expect(await runtime.places(self)).toEqual([
    { key: "dm-1", conversation: 8, channelId: "dm-1", at: 120_000 },
    {
      key: `${channel}/${root.id}`,
      conversation: CONVERSATION,
      channelId: channel,
      root: root.id,
      name: "general",
      at: 110_000,
    },
  ]);
});

it("posts the answer of a turn that did not send, once for every request it answered", async () => {
  const answered = deferred();
  const { deliver, settled, published } = setup({
    wait: async () => {
      await answered.promise;
      return { status: "done", answer: 5, text: "The build is green." };
    },
  });
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run;
  const second = deliver({ type: "mention", event: reply("3", "@Pi also") });
  await vi.waitFor(() => expect(second.workingUntil).toHaveBeenCalled());
  answered.resolve();
  await expect(settled(first)).resolves.toEqual({ ok: true });
  await expect(settled(second)).resolves.toEqual({ ok: true });
  expect(published).toEqual([
    {
      kind: 9,
      content: "The build is green.",
      tags: [
        ["h", channel],
        ["e", root.id, "", "reply"],
      ],
    },
  ]);
});

it("posts a run's answer for a request it took after a send", async () => {
  const answered = deferred();
  const { host, deliver, settled, published } = setup({
    wait: async () => {
      await answered.promise;
      return { status: "done", answer: 5, text: "The build is green." };
    },
  });
  const first = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await first.run;
  const steer = reply("3", "@Pi also");
  const second = deliver({ type: "mention", event: steer });
  // Its receipt is known once it is handed over.
  await vi.waitFor(() => expect(host.requests("deliver")).toHaveLength(2));
  // The run sends for the first request, then takes the second.
  await host.processes[0]?.tool({
    agent: self,
    conversation: CONVERSATION,
    context: { channel, root: root.id },
    name: "send",
    arguments: { text: "On it", audience: "everyone" },
  });
  host.processes[0]?.send({
    method: "event",
    params: {
      agent: self,
      conversation: CONVERSATION,
      type: "placed",
      request: steer.id,
      entry: 3,
    },
  });
  await vi.waitFor(() => expect(second.acknowledged).toHaveBeenCalled());
  answered.resolve();
  await expect(settled(first)).resolves.toEqual({ ok: true });
  await expect(settled(second)).resolves.toEqual({ ok: true });
  expect(published.map((event) => event.content)).toEqual([
    "On it",
    "The build is green.",
  ]);
});

it("posts a run's answer where the latest request it took is, not one placed after it", async () => {
  const answered = deferred();
  let submissions = 0;
  const { deliver, settled, published } = setup({
    // Requests are placed at entries 10, 20 and 30; the run that took the
    // first two answers at 25.
    deliver: (params, process) => {
      const submission = ++submissions;
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: submission * 10,
        },
      });
      return { submission, conversation: CONVERSATION };
    },
    wait: async ({ submission }) => {
      if (submission === 3) return new Promise(() => {});
      await answered.promise;
      return { status: "done", answer: 25, text: "Both done." };
    },
  });
  // One conversation for the channel, each message its own thread.
  const config = { ...DEFAULT_CONFIG, scope: "channel" as const };
  const top = (id: string, created_at: number) =>
    message(id, "@Pi", { created_at, tags: [["h", channel]] });
  const latest = top("3", 120);
  const first = deliver({ type: "mention", event: top("2", 110) }, { config });
  const second = deliver({ type: "mention", event: latest }, { config });
  const third = deliver({ type: "mention", event: top("4", 130) }, { config });
  await vi.waitFor(() => expect(third.acknowledged).toHaveBeenCalled());
  answered.resolve();
  await expect(settled(first)).resolves.toEqual({ ok: true });
  await expect(settled(second)).resolves.toEqual({ ok: true });
  expect(published).toEqual([
    {
      kind: 9,
      content: "Both done.",
      tags: [
        ["h", channel],
        ["e", latest.id, "", "reply"],
      ],
    },
  ]);
});

it("runs Pi's Buzz tools in the conversation's thread, and posts nothing more after a send", async () => {
  const answered = deferred();
  const { host, deliver, settled, published } = setup({
    wait: async () => {
      await answered.promise;
      return { status: "done", answer: 5, text: "Posted it." };
    },
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  const sent = await host.processes[0]?.tool({
    agent: self,
    conversation: CONVERSATION,
    context: { channel, root: root.id },
    name: "send",
    arguments: { text: "On it", audience: "everyone", final: true },
  });
  // A final send ends Pi's run.
  expect(sent?.result).toMatchObject({ final: true });
  expect(sent?.result).not.toMatchObject({ isError: true });
  answered.resolve();
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ kind: 9, content: "On it" });
  expect(published[0]?.tags).toContainEqual(["e", root.id, "", "reply"]);
});

it("lists the tools plugins add, and runs them for Pi", async () => {
  const lookup = vi.fn<AddedTool["call"]>(async (_client, _context, args) => {
    if (args.q === "bad") throw new Error("No such thing");
    return `found ${String(args.q)}`;
  });
  const { host, deliver } = setup({}, [
    {
      name: "lookup",
      description: "Look it up",
      inputSchema: { type: "object" },
      call: lookup,
    },
  ]);
  await deliver({ type: "mention", event: reply("2", "@Pi look") }).run;
  const listed = host.requests("open")[0]?.params.tools as { name: string }[];
  expect(listed.at(-1)?.name).toBe("lookup");
  const call = async (q: string) =>
    (
      await host.processes[0]?.tool({
        agent: self,
        conversation: CONVERSATION,
        context: { channel, root: root.id },
        name: "lookup",
        arguments: { q },
      })
    )?.result;
  await expect(call("logs")).resolves.toEqual({
    content: [{ type: "text", text: "found logs" }],
  });
  expect(lookup).toHaveBeenCalledWith(
    expect.anything(),
    { channel, root: root.id },
    { q: "logs" },
  );
  await expect(call("bad")).resolves.toEqual({
    content: [{ type: "text", text: "No such thing" }],
    isError: true,
  });
});

it("reports a turn Pi left unanswered to the owner, in its thread", async () => {
  const { deliver, settled, published } = setup({
    wait: () => ({
      status: "unanswered",
      reason: "model_error",
      detail: "401 invalid x-api-key",
    }),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({
    ok: false,
    error: "401 invalid x-api-key",
  });
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]).toEqual({
    kind: 9,
    content: "⚠️ I couldn't finish that: 401 invalid x-api-key",
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
      ["p", alice],
    ],
  });
});

it("continues an owner's Solo chat at the top level, answers and failures alike", async () => {
  const { host, deliver, settled, published, solo } = setup({
    wait: ({ submission }) =>
      submission === 1
        ? { status: "done", answer: 5, text: "Here it is." }
        : { status: "unanswered", reason: "model_error", detail: "Overloaded" },
  });
  solo.add("solo-1");
  const me = (id: string) => message(id, "@Pi", { tags: [["h", "solo-1"]] });
  const answered = deliver(
    { type: "mention", event: me("2") },
    { channelId: "solo-1" },
  );
  await answered.run;
  await expect(settled(answered)).resolves.toEqual({ ok: true });
  expect(host.requests("deliver")[0]?.params).toMatchObject({
    key: "solo-1",
    context: { channel: "solo-1", topLevel: true },
  });
  const failed = deliver(
    { type: "mention", event: me("3") },
    { channelId: "solo-1" },
  );
  await vi.waitFor(() => expect(failed.workingUntil).toHaveBeenCalled());
  await expect(settled(failed)).resolves.toMatchObject({ ok: false });
  await vi.waitFor(() => expect(published).toHaveLength(2));
  expect(published.map((event) => event.tags)).toEqual([
    [["h", "solo-1"]],
    [
      ["h", "solo-1"],
      ["p", alice],
    ],
  ]);
});

it("hands a Solo chat's Canvas to each turn, and no one else's", async () => {
  const { host, deliver, solo } = setup({}, [], {
    content: "Work in ~/src/app.",
  });
  solo.add("solo-1");
  const turn = deliver(
    {
      type: "mention",
      event: message("2", "@Pi", { tags: [["h", "solo-1"]] }),
    },
    { channelId: "solo-1" },
  );
  await turn.run;
  expect(String(host.requests("deliver")[0]?.params.text)).toContain(
    "Work in ~/src/app.",
  );
  // A thread is no Solo chat: its Canvas is not read.
  await deliver({ type: "mention", event: reply("3", "@Pi look") }).run;
  expect(String(host.requests("deliver")[1]?.params.text)).not.toContain(
    "workspace-canvas",
  );
});

it("stops a mention's run when the owner stops it, and posts nothing", async () => {
  const answered = deferred<unknown>();
  const { host, deliver, settled, published } = setup({
    wait: () => answered.promise,
    abort: () => {
      answered.resolve({ status: "unanswered", reason: "aborted" });
      return {};
    },
  });
  const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
  const turn = deliver(
    { type: "mention", event: reply("2", "@Pi look") },
    { interruptible },
  );
  await turn.run;
  expect(interruptible).toHaveBeenCalledTimes(1);
  await interruptible.mock.calls[0]?.[0]();
  expect(host.requests("abort")[0]?.params).toEqual({
    agent: self,
    conversation: CONVERSATION,
  });
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(published).toEqual([]);
});

it("lists the agent's sessions from Pi's storage, and whether each works", async () => {
  const answered = deferred<unknown>();
  const key = `${channel}/${root.id}`;
  const { runtime, deliver, settled, host, agent } = setup({
    places: () => ({
      places: [
        { key, conversation: CONVERSATION, seen: 105 },
        { key: "chan-2", conversation: 3, seen: 90 },
      ],
    }),
    deliver: (params, process) => {
      process.send({
        method: "event",
        params: {
          agent: self,
          conversation: CONVERSATION,
          type: "placed",
          request: params.request,
          entry: 1,
        },
      });
      return { submission: 1, conversation: CONVERSATION };
    },
    wait: () => answered.promise,
  });
  const listener = vi.fn();
  runtime.subscribe(listener);
  // An agent that does not run here keeps its storage closed.
  expect(runtime.sessions(self)).toEqual([]);
  expect(host.requests("places")).toEqual([]);
  runtime.sync([{ ...agent, config: DEFAULT_CONFIG } as unknown as Agent]);
  // Read from storage on first ask; subscribers hear when it is in.
  expect(runtime.sessions(self)).toEqual([]);
  await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  expect(runtime.sessions(self)).toEqual([
    { channelId: channel, root: root.id, at: 105_000 },
    { channelId: "chan-2", at: 90_000 },
  ]);
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await vi.waitFor(() => expect(turn.acknowledged).toHaveBeenCalled());
  expect(runtime.sessions(self)).toEqual([
    { channelId: channel, root: root.id, at: 110_000, status: "Working" },
    { channelId: "chan-2", at: 90_000, status: "Idle" },
  ]);
  answered.resolve({ status: "done", answer: 2, text: "" });
  await settled(turn);
  await vi.waitFor(() =>
    expect(runtime.sessions(self)[0]?.status).toBe("Idle"),
  );
});

it("waits for a turn again once the agent's failed storage is opened again", async () => {
  let waits = 0;
  const { host, deliver, settled, published } = setup({
    wait: () =>
      ++waits === 1
        ? { status: "reopen" }
        : { status: "done", answer: 5, text: "Resumed." },
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(host.requests("open")).toHaveLength(2);
  await vi.waitFor(() => expect(published).toHaveLength(1));
  expect(published[0]?.content).toBe("Resumed.");
});

it("waits for a turn again in a new host when the host stops", async () => {
  let hosts = 0;
  const { host, deliver, settled, published } = setup({
    // The first host stops before it answers; the next one, which continues
    // the run from Pi's storage, does.
    wait: (_params, process) => {
      if (++hosts === 1) {
        queueMicrotask(() => process.exit(1, "Killed\n"));
        return new Promise(() => {});
      }
      return { status: "done", answer: 5, text: "Resumed." };
    },
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(host.processes).toHaveLength(2);
  expect(host.processes[1]?.requests.map((request) => request.method)).toEqual([
    "open",
    "wait",
  ]);
  expect(published.map((item) => item.content)).toEqual(["Resumed."]);
});

it("hands a turn to the next host when the host stops before it answers", async () => {
  let hosts = 0;
  const { host, deliver, settled } = setup({
    // The first host may have taken the turn; the next finds it by request.
    deliver: (_params, process) => {
      if (++hosts === 1) {
        queueMicrotask(() => process.exit(1, "Killed\n"));
        return new Promise(() => {});
      }
      return { submission: 1, conversation: CONVERSATION };
    },
    wait: () => ({ status: "done", answer: 5, text: "Done." }),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  const delivered = host.requests("deliver");
  expect(delivered).toHaveLength(2);
  expect(delivered[1]?.params).toEqual(delivered[0]?.params);
  expect(host.processes[1]?.requests[0]?.method).toBe("open");
});

it("hands over no queued mention of an agent removed while it waited", async () => {
  const first = deferred<object>();
  let delivers = 0;
  const { runtime, host, deliver, settled, published } = setup({
    deliver: () =>
      ++delivers === 1
        ? first.promise
        : { submission: 2, conversation: CONVERSATION },
  });
  const one = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await vi.waitFor(() => expect(host.requests("deliver")).toHaveLength(1));
  const two = deliver({ type: "mention", event: reply("3", "@Pi and this") });
  await two.run;
  runtime.sync([]);
  first.resolve({ submission: 1, conversation: CONVERSATION });
  await one.run;
  await expect(settled(two)).resolves.toEqual({ ok: true });
  expect(host.requests("deliver")).toHaveLength(1);
  expect(host.requests("open")).toHaveLength(1);
  expect(published).toEqual([]);
});

it("leaves a removed agent's turn in Pi's storage without a report", async () => {
  const closing = deferred();
  const { runtime, host, deliver, settled, published } = setup({
    // Closed, the agent is not open for the wait.
    wait: async () => {
      await closing.promise;
      throw new Error("The agent is not open");
    },
    close: () => closing.resolve(),
  });
  const turn = deliver({ type: "mention", event: reply("2", "@Pi look") });
  await turn.run;
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  runtime.sync([]);
  await expect(settled(turn)).resolves.toEqual({ ok: true });
  expect(host.requests("close")[0]?.params).toEqual({ agent: self });
  expect(published).toEqual([]);
});

it("runs a standalone turn in a one-off conversation", async () => {
  const { host, runOnce, published } = setup({
    wait: () => ({ status: "done", answer: 5, text: "Nothing to report." }),
  });
  await expect(runOnce("timer/t1", "Run t1")).resolves.toEqual({ ok: true });
  const [once] = host.requests("once");
  expect(String(once?.params.request)).toMatch(/^timer\/t1\//);
  expect(once?.params.text).toBe("Run t1");
  expect(host.requests("deliver")).toEqual([]);
  // A wake's answer is for Pi alone; it acts with its tools.
  expect(published).toEqual([]);
});

it("starts no standalone turn once its prompt is no longer wanted", async () => {
  const { host, runOnce } = setup();
  await expect(runOnce("watch/w1", undefined)).resolves.toEqual({ ok: true });
  expect(host.requests("once")).toEqual([]);
});

it("stops a standalone turn's conversation when its signal aborts", async () => {
  const waiting = deferred<unknown>();
  const { host, runOnce } = setup({
    wait: () => waiting.promise,
    abort: () => {
      waiting.resolve({ status: "unanswered", reason: "aborted" });
      return {};
    },
  });
  const stop = new AbortController();
  const turn = runOnce("timer/t1", "Run t1", stop.signal);
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  stop.abort();
  await expect(turn).resolves.toEqual({
    ok: false,
    error: "The turn was stopped",
  });
  expect(host.requests("abort")[0]?.params).toEqual({
    agent: self,
    conversation: 99,
  });
});

it("offers the provider's models with the thinking levels each supports", async () => {
  let defaults = { provider: "anthropic", model: "claude-x", thinking: "high" };
  const { runtime } = setup({
    defaults: () => defaults,
    models: () => [
      { id: "claude-x", name: "Claude X", thinking: ["off", "low", "high"] },
      { id: "claude-y", name: "Claude Y", thinking: ["off"] },
    ],
  });
  const agent = { pubkey: self, config: DEFAULT_CONFIG } as Agent<Config>;
  await expect(runtime.models(agent)).resolves.toEqual({
    current: "claude-x",
    models: [
      {
        id: "claude-x",
        label: "Claude X",
        efforts: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        effort: "high",
      },
      {
        id: "claude-y",
        label: "Claude Y",
        efforts: [{ id: "off", label: "Off" }],
        effort: "off",
      },
    ],
  });
  // The agent's saved level is Pi's, or the nearest a model has.
  const saved = {
    pubkey: self,
    config: { ...DEFAULT_CONFIG, effort: "medium" },
  } as Agent<Config>;
  const efforts = (await runtime.models(saved)).models.map(
    (model) => model.effort,
  );
  expect(efforts).toEqual(["high", "off"]);
  // Pi's settings as they are now: the pi command changes them.
  defaults = { provider: "anthropic", model: "claude-y", thinking: "low" };
  await expect(runtime.models(agent)).resolves.toMatchObject({
    current: "claude-y",
    models: [{ effort: "low" }, { effort: "off" }],
  });
});

it("runs a turn at the agent's saved thinking level, apart from a pick", async () => {
  const { host, deliver } = setup();
  await deliver(
    { type: "mention", event: reply("2", "@Pi look") },
    { config: { ...DEFAULT_CONFIG, effort: "low" } },
  ).run;
  expect(host.requests("deliver")[0]?.params).toMatchObject({
    thinking: "low",
    pick: {},
  });
});
