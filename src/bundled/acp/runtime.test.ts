import {
  ALREADY_STARTED,
  assignConversationFolder,
} from "../../features/agents/conversation-folders";
import { workspaceCanvas } from "../../features/solo/workspace";
import type { SectionChoices } from "../../features/agent-harness/sections/choices";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
// ACP agents' turns, end to end against a fake plain-ACP harness.
import { describe, expect, it, vi } from "vitest";
import { modelCache, picks } from "./models";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { RelayData } from "../../features/relay/service";
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import { flush } from "../goose/goose-testing";
import { fakeHarness } from "./acp-testing";
import { approve, type Config, DEFAULT_CONFIG } from "./config";
import { missing } from "./harness";
import manifest from "./manifest.json";
import { AcpRuntime } from "./runtime";
import { localSessions } from "./sessions";
import {
  PROMPTS_PREFIX,
  sessionPrompts,
} from "../../features/agents/session-prompts";
import { localStore, type AgentStore } from "../../features/agents/store";
import { loadAgentStorage } from "../../features/agents/state";
import { eventDto, type RelayEvent } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";

const appClient = vi.hoisted(() => vi.fn());
vi.mock("../../buzz-mcp/app-client", async (actual) => {
  const real = await actual<typeof import("../../buzz-mcp/app-client")>();
  return {
    ...real,
    appClient: appClient.mockImplementation(real.appClient),
  };
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const mallory = "b".repeat(64);
const channel = "chan-1";
const INSTRUCTIONS = "Always answer in haiku.";

/** A host that grants only what the manifest declares, as the native host
 * does, so the runtime can't rely on an undeclared grant. */
function declared(fake: ReturnType<typeof fakeHarness>): Host {
  const { processes, files } = manifest.host as {
    processes: { id: string }[];
    files?: boolean;
  };
  const refuse = async () => {
    throw new Error("Files are not declared");
  };
  return {
    spawn: (id: string, ...rest: unknown[]) => {
      if (!processes.some((process) => process.id === id))
        throw new Error(`Process ${id} is not declared`);
      return (fake.spawn as (...args: unknown[]) => unknown)(id, ...rest);
    },
    serveMcp: fake.serve,
    resolveDirectory: files ? async (path: string) => path : refuse,
    readFile: files ? async () => new Uint8Array() : refuse,
  } as unknown as Host;
}

const FAILED = "⚠️ I couldn't finish that. Details are in my activity.";

const message = (id: string, content: string, pubkey = alice): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
  }) as RelayEvent;

const confirmed = (value: Partial<Config> = {}) =>
  approve({
    ...DEFAULT_CONFIG,
    preset: "opencode",
    command: "opencode",
    args: ["acp"],
    instructions: INSTRUCTIONS,
    ...value,
  });

/** A runtime for one of Alice's agents in `channel`, on a fake harness. */
function setup(
  options: Parameters<typeof fakeHarness>[0] = {},
  {
    core = async () => null,
    added = () => [],
    read = async (_filters: { ids?: string[] }[]) => [] as RelayEvent[],
    solo = false,
    canvas,
    storage = memoryStorage(),
    agentStore = localStore(storage),
    workflowAuthority = "workflow-authority",
    gone = [],
  }: {
    /** Folders that no longer exist. */
    gone?: readonly string[];
    /** Agent storage, which desktop keeps apart from `storage`. */
    agentStore?: AgentStore;
    /** The community's relay workflow key. */
    workflowAuthority?: string;
    /** Where saved conversations and models are kept. */
    storage?: Storage;
    solo?: boolean;
    /** The channel's Canvas. */
    canvas?: string;
    core?: () => Promise<string | null | undefined>;
    added?: () => readonly AddedTool[];
    read?: (filters: { ids?: string[] }[]) => Promise<RelayEvent[]>;
  } = {},
) {
  const fake = fakeHarness(options);
  const host = declared(fake);
  /** The working folder of each file read. */
  const fileReads: string[] = [];
  const readFile = host.readFile;
  host.readFile = async (path, options) => {
    fileReads.push(options?.cwd ?? "");
    return readFile?.(path, options) ?? new Uint8Array();
  };
  const resolve = host.resolveDirectory;
  host.resolveDirectory = async (path, options) => {
    if (gone.includes(path)) throw new Error(`Could not find ${path}`);
    return resolve?.(path, options) ?? path;
  };
  const session = {
    read: vi.fn(read),
    channels: {
      list: () => ({
        channels: [
          {
            id: channel,
            name: "general",
            channelType: solo ? "solo" : "stream",
            members: [],
          },
        ],
      }),
    },
    relayAuthor: "relay-author",
    workflowAuthority,
    channelWrites: { startingCanvas: () => undefined },
    canvas: {
      available: canvas !== undefined,
      read: vi.fn(async () =>
        canvas === undefined
          ? null
          : {
              pubkey: alice,
              kind: 40100,
              created_at: 1,
              tags: [],
              content: canvas,
            },
      ),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: { ensure: vi.fn(async () => {}), snapshot: () => new Map() },
    agentMemories: { read: vi.fn(async () => ({ entries: [] })) },
    mePlacement: {
      snapshot: () => ({ status: "ready" }),
      refresh: vi.fn(async () => {}),
      has: () => false,
    },
  };
  // A reconnect tells its subscribers once the community is ready again.
  const state = { status: "ready" };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => ({
      status: state.status,
      ...(state.status === "ready" ? { session } : {}),
      viewer: alice,
      origin: "https://acp.example",
      scope: `https://acp.example:${alice}`,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  const connect = (status: string) => {
    state.status = status;
    for (const listener of [...listeners]) listener();
  };
  // Another community of the same identity: its own session, with its own memory.
  const awaySession = {
    ...session,
    agentMemories: { read: vi.fn(async () => ({ entries: [] })) },
  };
  const awayRelay = {
    snapshot: () => ({
      status: "ready",
      session: awaySession,
      viewer: alice,
      origin: "https://away.example",
      scope: `https://away.example:${alice}`,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const cache = modelCache(storage);
  const runtime = new AcpRuntime(
    host,
    (key) => (key === self ? relay : awayRelay),
    core,
    added,
    cache,
    storage,
    agentStore,
  );
  const published: { content: string; tags: string[][] }[] = [];
  const agent = {
    key: self,
    pubkey: self,
    name: "Opal",
    owner: alice,
    relay: "wss://acp.example",
    type: "buzz.acp/acp",
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return { ...message("9", template.content), ...template };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
  };
  const workingUntil = vi.fn((_done: Promise<unknown>) => undefined);
  const deliver = (
    event: RelayEvent,
    config: Config,
    signal = new AbortController().signal,
    extra: Partial<Delivery> = {},
  ) => {
    const ignored = vi.fn();
    const run = runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config,
      signal,
      workingUntil,
      ignored,
      ...extra,
    } as unknown as Delivery);
    return { run, ignored };
  };
  const sync = (config: Config) =>
    runtime.sync([
      { ...agent, config } as unknown as Parameters<
        AcpRuntime["sync"]
      >[0][number],
    ]);
  return {
    fake,
    runtime,
    session,
    awaySession,
    deliver,
    sync,
    published,
    workingUntil,
    cache,
    storage,
    agent,
    connect,
    fileReads,
  };
}

/** A `Storage` that lives only as long as the test. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

/** Resolves once a turn has settled and its report step has finished. */
async function reported(
  runtime: { subscribe(listener: () => void): () => void },
  workingUntil: { mock: { calls: unknown[][] } },
) {
  await vi.waitFor(() => expect(workingUntil.mock.calls).toHaveLength(1));
  await workingUntil.mock.calls[0]?.[0];
  // Subscribed before the report step's continuation runs; that step ends by
  // notifying, after any post it makes.
  await new Promise<void>((resolve) => {
    const stop = runtime.subscribe(() => {
      stop();
      resolve();
    });
  });
}

describe("AcpRuntime", () => {
  it("runs an owner's mention in the confirmed harness, with Buzz tools over HTTP MCP", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    expect(harness?.options.args).toEqual(["opencode", "acp"]);
    const [opened] = harness?.opened ?? [];
    expect(opened?.mcpServers).toEqual([
      expect.objectContaining({ type: "http", name: "buzz" }),
    ]);
    // No extension `_meta`, and no standard prompt it didn't advertise.
    expect(opened).not.toHaveProperty("_meta");
    expect(opened).not.toHaveProperty("systemPrompt");
    const sessionId = harness?.turns[0]?.sessionId ?? "";
    const listed = await harness?.mcp(sessionId, "tools/list");
    const result = listed?.result as { tools?: { name: string }[] } | undefined;
    expect(result?.tools?.map((tool) => tool.name)).toContain("send");
    // Buzz tools act with the relay session's authorities, as Goose's do.
    expect(appClient).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        relayAuthor: "relay-author",
        signingAuthority: "workflow-authority",
      }),
    );
  });

  it("keeps each community membership's handle for its own sessions' tools", async () => {
    const config = await confirmed();
    // Both turns run through the tool calls: a call after its turn is refused.
    const { fake, deliver, sync, session, awaySession } = setup({ hold: true });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [home] = fake.harnesses;
    const homeSession = home?.turns[0]?.sessionId ?? "";
    // The same identity, delivered to in another community it belongs to.
    const away = {
      key: `${self}@away.example`,
      pubkey: self,
      owner: alice,
      relay: "wss://away.example",
    };
    await deliver(message("2", "@Opal over here"), config, undefined, {
      agent: away,
    } as Partial<Delivery>).run;
    await home?.mcp(homeSession, "tools/call", {
      name: "mem_get",
      arguments: { slug: "notes" },
    });
    // The read goes to the home community, never the other one.
    expect(session.agentMemories.read).toHaveBeenCalledTimes(1);
    expect(awaySession.agentMemories.read).not.toHaveBeenCalled();
    expect(appClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: self }),
      expect.anything(),
    );
    expect(appClient).not.toHaveBeenLastCalledWith(away, expect.anything());
    // And the other membership's session reads only its own community.
    await vi.waitFor(() => expect(fake.harnesses[1]?.turns).toHaveLength(1));
    const awayHarness = fake.harnesses[1];
    await awayHarness?.mcp(
      awayHarness.turns[0]?.sessionId ?? "",
      "tools/call",
      {
        name: "mem_get",
        arguments: { slug: "notes" },
      },
    );
    expect(awaySession.agentMemories.read).toHaveBeenCalledTimes(1);
    expect(session.agentMemories.read).toHaveBeenCalledTimes(1);
    home?.turns[0]?.finish();
    awayHarness?.turns[0]?.finish();
  });

  it("refuses a Buzz tool call that arrives after its turn ended", async () => {
    const config = await confirmed();
    const { fake, runtime, deliver, sync, session, workingUntil } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await reported(runtime, workingUntil);
    const [harness] = fake.harnesses;
    const late = await harness?.mcp(
      harness.turns[0]?.sessionId ?? "",
      "tools/call",
      { name: "mem_get", arguments: { slug: "notes" } },
    );
    expect(JSON.stringify(late)).toMatch(/error/i);
    expect(session.agentMemories.read).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "builds a call's client again once its community's reload settles (stopped: %s)",
    async (stop) => {
      const config = await confirmed();
      const { fake, deliver, sync, session, agent, published } = setup({
        hold: true,
      });
      let reloaded!: () => void;
      const settle = vi.fn(
        () => new Promise<void>((resolve) => (reloaded = resolve)),
      );
      Object.assign(agent, { settle });
      sync(config);
      const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
      await deliver(message("1", "@Opal hi"), config, undefined, {
        interruptible,
      }).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const [harness] = fake.harnesses;
      appClient.mockClear();
      const call = harness?.mcp(
        harness.turns[0]?.sessionId ?? "",
        "tools/call",
        { name: "send", arguments: { text: "hello", audience: "everyone" } },
      );
      await vi.waitFor(() => expect(settle).toHaveBeenCalled());
      // The community reloaded with a new session and new details.
      Object.assign(session, { relayAuthor: "new-author" });
      if (stop) await interruptible.mock.calls[0]?.[0]();
      reloaded();
      const answer = JSON.stringify(await call);
      if (stop) {
        expect(answer).toMatch(/turn has ended/i);
        expect(published).toEqual([]);
      } else
        expect(appClient.mock.calls.at(-1)?.[1]).toMatchObject({
          relayAuthor: "new-author",
        });
      harness?.turns[0]?.finish(stop ? "cancelled" : undefined);
    },
  );

  it("refuses a read's result once Stop overtakes it", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, session } = setup({ hold: true });
    let answer!: (memories: { entries: [] }) => void;
    session.agentMemories.read.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    sync(config);
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Opal hi"), config, undefined, {
      interruptible,
    }).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    const call = harness?.mcp(harness.turns[0]?.sessionId ?? "", "tools/call", {
      name: "mem_get",
      arguments: { slug: "notes" },
    });
    await vi.waitFor(() =>
      expect(session.agentMemories.read).toHaveBeenCalledTimes(1),
    );
    await interruptible.mock.calls[0]?.[0]();
    answer({ entries: [] });
    expect(JSON.stringify(await call)).toMatch(/turn has ended/i);
    harness?.turns[0]?.finish("cancelled");
  });

  it("hands a Solo chat's Canvas to each turn, and a shared channel's to none", async () => {
    const config = await confirmed();
    for (const solo of [true, false]) {
      const { fake, deliver, sync } = setup(
        {},
        { solo, canvas: "Use tokens." },
      );
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const text = fake.harnesses[0]?.turns[0]?.text ?? "";
      if (solo) {
        expect(text).toContain("<workspace-canvas>");
        expect(text).toContain("Use tokens.");
      } else expect(text).not.toContain("Use tokens.");
    }
  });

  it("answers a mention that arrives during a reconnect in its Solo chat once the community is ready", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, connect } = setup({}, { solo: true });
    sync(config);
    connect("connecting");
    const { run, ignored } = deliver(message("1", "@Opal hello"), config);
    await flush(20);
    expect(fake.harnesses).toEqual([]);
    connect("ready");
    await run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    // Answered as the Solo chat it is, not as a thread.
    const text = fake.harnesses[0]?.turns[0]?.text ?? "";
    expect(text).toContain("Scope: channel");
    expect(text).not.toContain("Thread root:");
    expect(ignored).not.toHaveBeenCalled();
  });

  it("leads only a new session's first prompt with the instructions", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await flush(50);
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    const [one, two] = fake.harnesses[0]?.turns ?? [];
    expect(one?.text).toContain(INSTRUCTIONS);
    expect(one?.text).toContain("@Opal one");
    expect(two?.sessionId).toBe(one?.sessionId);
    expect(two?.text).toContain("@Opal two");
    expect(two?.text).not.toContain(INSTRUCTIONS);
  });

  it("ends a turn's prompt with its conversation's instructions", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, agent } = setup();
    sync(config);
    const conversationInstructions = vi.fn(() => ({
      plugin: "acme.tasks",
      text: "Review only.",
    }));
    Object.assign(agent, { conversationInstructions });
    const mention = message("1", "@Opal hi");
    await deliver(mention, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(fake.harnesses[0]?.turns[0]?.text).toMatch(
      /<owner-instructions source="acme\.tasks">\n[\s\S]*\n\nReview only\.\n<\/owner-instructions>/,
    );
    expect(conversationInstructions).toHaveBeenCalledWith(channel, mention.id);
  });

  it.each(["thread", "channel"] as const)(
    "adds the %s session's plugin notes to its prompt",
    async (scope) => {
      const config = await confirmed({ scope });
      const { fake, deliver, sync, agent } = setup();
      sync(config);
      const notes = vi.fn(() => ["<note>Ticket ABC-1 is open.</note>"]);
      Object.assign(agent, { notes, restoreNotes: vi.fn() });
      const mention = message("1", "@Opal hi");
      await deliver(mention, config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      expect(fake.harnesses[0]?.turns[0]?.text).toContain(
        "<note>Ticket ABC-1 is open.</note>",
      );
      expect(notes).toHaveBeenCalledWith(
        channel,
        scope === "thread" ? mention.id : undefined,
      );
    },
  );

  it("gives plugin notes back when its turn is stopped while its prompt is built", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, agent } = setup();
    sync(config);
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    const taken = ["<note>Ticket ABC-1 is open.</note>"];
    const notes = vi.fn(() => {
      void interruptible.mock.calls[0]?.[0]();
      return taken;
    });
    const restoreNotes = vi.fn();
    Object.assign(agent, { notes, restoreNotes });
    const mention = message("1", "@Opal hi");
    await deliver(mention, config, undefined, { interruptible }).run;
    await vi.waitFor(() => expect(restoreNotes).toHaveBeenCalledTimes(1));
    expect(restoreNotes).toHaveBeenCalledWith(channel, taken, mention.id);
    expect(fake.harnesses[0]?.turns ?? []).toHaveLength(0);
  });

  it("takes no plugin notes when its harness exits while its prompt is built", async () => {
    const config = await confirmed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const { fake, deliver, sync, agent } = setup(
      {},
      {
        read: async () => {
          reads++;
          await gate;
          return [];
        },
      },
    );
    sync(config);
    const pending = ["<note>Ticket ABC-1 is open.</note>"];
    const notes = vi.fn(() => pending.splice(0));
    const restoreNotes = vi.fn((_c: string, back: readonly string[]) =>
      pending.push(...back),
    );
    // The builder's last step reads the plugins' instructions.
    let built!: () => void;
    const finished = new Promise<void>((resolve) => (built = resolve));
    const instructions = vi.fn(() => {
      built();
      return undefined;
    });
    Object.assign(agent, { notes, restoreNotes, instructions });
    const mention = message("1", "@Opal hi");
    const settled = vi.fn();
    await deliver(mention, config, undefined, {
      workingUntil: (done: Promise<unknown>) => void done.finally(settled),
    } as unknown as Partial<Delivery>).run;
    await vi.waitFor(() => expect(reads).toBe(1));
    fake.harnesses[0]?.exit();
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    release();
    await finished;
    expect(notes).not.toHaveBeenCalled();
    expect(pending).toEqual(["<note>Ticket ABC-1 is open.</note>"]);
    expect(fake.harnesses.flatMap((h) => h.turns)).toHaveLength(0);
  });

  it("sends the instructions as ACP's appended system prompt when advertised", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
      },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [opened] = fake.harnesses[0]?.opened ?? [];
    const prompt = opened?.systemPrompt as {
      mode: string;
      content: { text: string }[];
    };
    expect(prompt.mode).toBe("append");
    expect(prompt.content[0]?.text).toContain(INSTRUCTIONS);
    expect(fake.harnesses[0]?.turns[0]?.text).not.toContain(INSTRUCTIONS);
  });

  it("tells each session what it is: a thread, a whole conversation or a standalone run", async () => {
    const capabilities = {
      mcpCapabilities: { http: true },
      sessionCapabilities: { systemPrompt: {} },
    };
    const promptOf = (opened: Record<string, unknown> | undefined) =>
      (opened?.systemPrompt as { content: { text: string }[] } | undefined)
        ?.content[0]?.text ?? "";
    const config = await confirmed();
    // A thread in a channel.
    const thread = setup({ capabilities });
    thread.sync(config);
    await thread.deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() =>
      expect(thread.fake.harnesses[0]?.opened).toHaveLength(1),
    );
    expect(promptOf(thread.fake.harnesses[0]?.opened[0])).toContain(
      "This session is one thread",
    );
    // A Solo chat, one whole conversation.
    const solo = setup({ capabilities }, { solo: true });
    solo.sync(config);
    await solo.deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() =>
      expect(solo.fake.harnesses[0]?.opened).toHaveLength(1),
    );
    expect(promptOf(solo.fake.harnesses[0]?.opened[0])).toContain(
      "This session is one whole conversation",
    );
    // A timer's run, which joins none.
    const timer = setup({ capabilities });
    timer.sync(config);
    const done = timer.runtime.runOnce({
      delivery: {
        agent: {
          key: self,
          pubkey: self,
          name: "Opal",
          owner: alice,
          relay: "wss://acp.example",
        },
        config,
      } as unknown as Delivery,
      key: "timer",
      signal: new AbortController().signal,
      prompt: async () => "wake",
    });
    await vi.waitFor(() =>
      expect(timer.fake.harnesses[0]?.turns).toHaveLength(1),
    );
    expect(promptOf(timer.fake.harnesses[0]?.opened[0])).toContain(
      "This run joins no conversation",
    );
    timer.fake.harnesses[0]?.turns[0]?.finish();
    await done;
  });

  describe("section choices", () => {
    const capabilities = {
      mcpCapabilities: { http: true },
      sessionCapabilities: { systemPrompt: {} },
    };
    const promptOf = (opened: Record<string, unknown> | undefined) =>
      (opened?.systemPrompt as { content: { text: string }[] } | undefined)
        ?.content[0]?.text ?? "";
    const terse: SectionChoices = {
      owner: { etiquette: { mode: "custom", text: "Be terse." } },
    };
    const inThread = (event: RelayEvent, root: string) => ({
      ...event,
      tags: [...event.tags, ["e", root, "", "reply"]],
    });
    /** A handle whose choices are read per thread root, as the host's are. */
    const choosing = (agent: object) => {
      const choices = new Map<string, SectionChoices>();
      return {
        choices,
        agent: {
          ...agent,
          promptSections: (_channelId?: string, root?: string) =>
            root ? choices.get(root) : undefined,
        },
      };
    };

    it("gives a busy conversation's next turn a new session once its choices change, and leaves others alone", async () => {
      const config = await confirmed();
      const f = setup({ capabilities });
      f.sync(config);
      const { choices, agent } = choosing(f.agent);
      const extra = { agent } as unknown as Partial<Delivery>;
      const [a, b] = ["1".repeat(64), "3".repeat(64)];
      await f.deliver(message("1", "@Opal A"), config, undefined, extra).run;
      await f.deliver(message("3", "@Opal B"), config, undefined, extra).run;
      await vi.waitFor(() =>
        expect(f.fake.harnesses[0]?.turns).toHaveLength(2),
      );
      const [harness] = f.fake.harnesses;
      const [first, other] = harness?.turns ?? [];
      // A is still busy when its choices change.
      choices.set(a, terse);
      await f.deliver(
        inThread(message("2", "@Opal A again"), a),
        config,
        undefined,
        extra,
      ).run;
      other?.finish();
      await f.deliver(
        inThread(message("4", "@Opal B again"), b),
        config,
        undefined,
        extra,
      ).run;
      first?.finish();
      await vi.waitFor(() => expect(harness?.turns).toHaveLength(4));
      const turns = harness?.turns ?? [];
      // The fake numbers its sessions in the order they open.
      const prompts = new Map(
        (harness?.opened ?? []).map((opened, i) => [
          `session-${i + 1}`,
          promptOf(opened),
        ]),
      );
      const [againA, againB] = [
        turns.find((turn) => turn.text.includes("A again")),
        turns.find((turn) => turn.text.includes("B again")),
      ];
      // A's next turn runs on a successor, with the new choices.
      expect(againA?.sessionId).not.toBe(first?.sessionId);
      expect(prompts.get(againA?.sessionId ?? "")).toContain("Be terse.");
      expect(prompts.get(first?.sessionId ?? "")).not.toContain("Be terse.");
      // B's choices never changed: it keeps its session.
      expect(againB?.sessionId).toBe(other?.sessionId);
      for (const turn of harness?.turns ?? []) turn.finish();
    });

    it("keeps a session's prompt on the choices it was pinned with when they change during its launch", async () => {
      let release = () => {};
      let reads = 0;
      const core = () => {
        reads++;
        return reads > 1
          ? Promise.resolve(null)
          : new Promise<null>((resolve) => {
              release = () => resolve(null);
            });
      };
      const config = await confirmed();
      const f = setup({ capabilities }, { core });
      f.sync(config);
      const { choices, agent } = choosing(f.agent);
      const extra = { agent } as unknown as Partial<Delivery>;
      const a = "1".repeat(64);
      const run = f.deliver(
        message("1", "@Opal A"),
        config,
        undefined,
        extra,
      ).run;
      await vi.waitFor(() => expect(reads).toBe(1));
      // Changed while the launch reads its memory.
      choices.set(a, terse);
      release();
      await run;
      await vi.waitFor(() =>
        expect(f.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      const [harness] = f.fake.harnesses;
      const [first] = harness?.turns ?? [];
      expect(promptOf(harness?.opened[0])).not.toContain("Be terse.");
      first?.finish();
      // The next turn is a new session's, on the choices as they are now.
      await f.deliver(
        inThread(message("2", "@Opal A again"), a),
        config,
        undefined,
        extra,
      ).run;
      await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
      expect(harness?.turns[1]?.sessionId).not.toBe(first?.sessionId);
      expect(promptOf(harness?.opened[1])).toContain("Be terse.");
      harness?.turns[1]?.finish();
    });

    it("tells a Solo chat's agent its Canvas folders are for reading when a plugin moves its work", async () => {
      const config = await confirmed();
      const f = setup(
        { capabilities },
        {
          solo: true,
          canvas: workspaceCanvas({
            folders: ["~/Development/app"],
            canvas: "Use the design system.",
          }),
        },
      );
      f.sync(config);
      const moved: SectionChoices = {
        plugin: {
          id: "plugin",
          sections: { "working-location": "Work in the plugin's folder." },
        },
      };
      const agent = { ...f.agent, promptSections: () => moved };
      await f.deliver(message("1", "@Opal hi"), config, undefined, {
        agent,
      } as unknown as Partial<Delivery>).run;
      await vi.waitFor(() =>
        expect(f.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      const [harness] = f.fake.harnesses;
      const text = harness?.turns[0]?.text ?? "";
      expect(text).toContain("They are for reading.");
      expect(text).not.toContain("This chat's work happens in these folders");
      expect(promptOf(harness?.opened[0])).toContain(
        "Work in the plugin's folder.",
      );
      harness?.turns[0]?.finish();
    });
  });

  describe("conversation folders", () => {
    const capabilities = {
      mcpCapabilities: { http: true },
      sessionCapabilities: { systemPrompt: {} },
      loadSession: true,
    };
    const promptOf = (opened: Record<string, unknown> | undefined) =>
      (opened?.systemPrompt as { content: { text: string }[] } | undefined)
        ?.content[0]?.text ?? "";
    const scope = `https://acp.example:${alice}`;
    const folder = "/repos/app";
    const workspace = "/home/opal";
    const a = message("1", "@Opal A");
    const b = message("3", "@Opal B");
    const assign = (agentStore: AgentStore, root: string) =>
      assignConversationFolder(
        agentStore,
        scope,
        self,
        `${channel}/${root}`,
        folder,
      );

    it("starts a conversation given a folder there, on the launch it was confirmed with", async () => {
      const config = await confirmed({ workspace });
      const f = setup({ capabilities });
      f.sync(config);
      await assign(localStore(f.storage), a.id);
      await f.deliver(a, config).run;
      await f.deliver(b, config).run;
      await vi.waitFor(() =>
        expect(f.fake.harnesses[0]?.turns).toHaveLength(2),
      );
      const [harness] = f.fake.harnesses;
      // The fake numbers its sessions in the order they open.
      const openedFor = (text: string) => {
        const turn = harness?.turns.find((t) => t.text.includes(text));
        return harness?.opened[Number(turn?.sessionId.split("-")[1]) - 1];
      };
      const [inFolder, inWorkspace] = [
        openedFor("@Opal A"),
        openedFor("@Opal B"),
      ];
      expect(inFolder).toMatchObject({ cwd: folder });
      expect(promptOf(inFolder)).toContain(
        `Current working directory: ${folder}`,
      );
      expect(inWorkspace).toMatchObject({ cwd: workspace });
      expect(promptOf(inWorkspace)).toContain(
        `Current working directory: ${workspace}`,
      );
      // One process, on the confirmed command, args and workspace.
      expect(f.fake.harnesses).toHaveLength(1);
      expect(harness?.options.args).toEqual(["opencode", "acp"]);
      for (const turn of harness?.turns ?? []) turn.finish();
    });

    it("fails a conversation whose folder is gone, without starting it anywhere else", async () => {
      const config = await confirmed({ workspace });
      const f = setup({ capabilities }, { gone: [folder] });
      f.sync(config);
      await assign(localStore(f.storage), a.id);
      await f.deliver(a, config).run;
      await vi.waitFor(() => expect(f.workingUntil).toHaveBeenCalledTimes(1));
      expect(await f.workingUntil.mock.calls[0]?.[0]).toMatchObject({
        ok: false,
      });
      expect(f.fake.harnesses.flatMap((h) => h.opened)).toEqual([]);
    });

    it("replays a conversation's sessions in its folder, after a restart too", async () => {
      const config = await confirmed({ workspace });
      const storage = memoryStorage();
      const one = setup({ capabilities }, { storage });
      one.sync(config);
      await assign(localStore(storage), a.id);
      await one.deliver(a, config).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      one.fake.harnesses[0]?.turns[0]?.finish();
      await flush(20);
      one.runtime.dispose();
      const two = setup(
        {
          capabilities,
          replay: [
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "hi" },
            },
          ],
        },
        { storage },
      );
      two.sync(config);
      await two.runtime.transcript(
        self,
        `${channel}/${a.id}`,
        new AbortController().signal,
      );
      const loads = two.fake.harnesses.flatMap((h) => h.sent("session/load"));
      expect(loads.length).toBeGreaterThan(0);
      for (const load of loads)
        expect(load.params).toMatchObject({ cwd: folder });
    });

    it("refuses to replay a conversation whose folder is gone", async () => {
      const config = await confirmed({ workspace });
      const storage = memoryStorage();
      const one = setup({ capabilities }, { storage });
      one.sync(config);
      await assign(localStore(storage), a.id);
      await one.deliver(a, config).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      one.fake.harnesses[0]?.turns[0]?.finish();
      await flush(20);
      one.runtime.dispose();
      const two = setup({ capabilities }, { storage, gone: [folder] });
      two.sync(config);
      await expect(
        two.runtime.transcript(
          self,
          `${channel}/${a.id}`,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(two.fake.harnesses.flatMap((h) => h.sent("session/load"))).toEqual(
        [],
      );
    });

    it("works in the folder saved storage settled on, even when this program's copy missed it", async () => {
      const config = await confirmed({ workspace });
      /** Runs a Solo chat, given a folder in saved storage, and what it did. */
      const run = async (stale: boolean) => {
        const storage = memoryStorage();
        const local = localStore(storage);
        // Another program saved the folder; this one's copy hasn't seen it.
        const agentStore: AgentStore = stale
          ? {
              ...local,
              get: (key) =>
                key.startsWith("buzz.agents.conversation-folder")
                  ? null
                  : local.get(key),
            }
          : local;
        await assignConversationFolder(local, scope, self, channel, folder);
        const f = setup(
          {
            capabilities: { ...capabilities, sessionCapabilities: {} },
            hold: true,
          },
          {
            storage,
            agentStore,
            solo: true,
            canvas: workspaceCanvas({
              folders: ["~/Development/app"],
              canvas: "Use the design system.",
            }),
          },
        );
        f.sync(config);
        await f.deliver(message("1", "@Opal hi"), config).run;
        await vi.waitFor(() =>
          expect(f.fake.harnesses[0]?.turns).toHaveLength(1),
        );
        const [harness] = f.fake.harnesses;
        const turn = harness?.turns[0];
        await harness?.mcp(turn?.sessionId ?? "", "tools/call", {
          name: "send",
          arguments: { path: "note.md", audience: "everyone" },
        });
        turn?.finish();
        await vi.waitFor(() =>
          expect(localSessions(storage, self).load(channel)).toHaveProperty(
            "context",
          ),
        );
        return {
          cwd: harness?.opened[0]?.cwd,
          reads: f.fileReads,
          canvas: turn?.text ?? "",
          context: localSessions(storage, self).load(channel)?.context,
        };
      };
      const known = await run(false);
      const missed = await run(true);
      expect(missed.cwd).toBe(folder);
      expect(missed.reads).toEqual([folder]);
      expect(missed.canvas).toContain("They are for reading.");
      // The same session, saved as one opened in the folder.
      expect(missed.context).toBe(known.context);
    });

    it("refuses a folder given once the conversation started in the workspace", async () => {
      const config = await confirmed({ workspace });
      const f = setup({ capabilities });
      f.sync(config);
      await f.deliver(a, config).run;
      await vi.waitFor(() =>
        expect(f.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      expect(f.fake.harnesses[0]?.opened[0]).toMatchObject({ cwd: workspace });
      await expect(assign(localStore(f.storage), a.id)).rejects.toThrow(
        ALREADY_STARTED,
      );
      f.fake.harnesses[0]?.turns[0]?.finish();
    });

    it("tells a Solo chat given a folder that its Canvas folders are for reading", async () => {
      const config = await confirmed({ workspace });
      const f = setup(
        { capabilities },
        {
          solo: true,
          canvas: workspaceCanvas({
            folders: ["~/Development/app"],
            canvas: "Use the design system.",
          }),
        },
      );
      f.sync(config);
      await assignConversationFolder(
        localStore(f.storage),
        scope,
        self,
        channel,
        folder,
      );
      await f.deliver(message("1", "@Opal hi"), config).run;
      await vi.waitFor(() =>
        expect(f.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      const text = f.fake.harnesses[0]?.turns[0]?.text ?? "";
      expect(text).toContain("They are for reading.");
      expect(text).not.toContain("This chat's work happens in these folders");
      f.fake.harnesses[0]?.turns[0]?.finish();
    });
  });

  it("closes sessions with session/close only when advertised", async () => {
    for (const close of [false, true]) {
      const config = await confirmed();
      const { fake, runtime, deliver, sync } = setup({
        capabilities: {
          mcpCapabilities: { http: true },
          ...(close && { sessionCapabilities: { close: {} } }),
        },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      await flush(50);
      runtime.dispose();
      await flush(50);
      const harness = fake.harnesses[0];
      expect(harness?.sent("session/cancel")).toHaveLength(1);
      expect(harness?.sent("session/close")).toHaveLength(close ? 1 : 0);
      expect(fake.servers.every((server) => server.closed)).toBe(true);
      expect(harness?.killed).toBe(true);
    }
  });

  it("runs an addressed wake in its thread, with its own prompt", async () => {
    const config = await confirmed();
    const { fake, runtime, sync, workingUntil } = setup();
    sync(config);
    const ignored = vi.fn();
    const root = "d".repeat(64);
    await runtime.run({
      trigger: {
        type: "attention",
        id: "e".repeat(64),
        channel,
        root,
        text: "The watched PR merged.",
        at: 200_000,
      },
      channelId: channel,
      agent: {
        key: self,
        pubkey: self,
        name: "Opal",
        owner: alice,
        relay: "wss://acp.example",
      },
      config,
      signal: new AbortController().signal,
      workingUntil,
      ignored,
    } as unknown as Delivery);
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(ignored).not.toHaveBeenCalled();
    const text = fake.harnesses[0]?.turns[0]?.text ?? "";
    expect(text).toContain("The watched PR merged.");
    expect(runtime.sessions(self).map((view) => view.key)).toEqual([
      `${channel}/${root}`,
    ]);
    fake.harnesses[0]?.turns[0]?.finish();
  });

  it("carries on a resumed mention, with its thread past the request", async () => {
    const config = await confirmed();
    const mention = message("1", "@Opal ship it");
    const later = message("2", "Also bump the version.", "b".repeat(64));
    later.tags.push(["e", mention.id, "", "root"]);
    const elsewhere = message(
      "3",
      "Unrelated top-level chatter.",
      "b".repeat(64),
    );
    const { fake, sync, deliver } = setup(
      {},
      { read: async () => [mention, later, elsewhere] },
    );
    sync(config);
    await deliver(mention, config, undefined, {
      trigger: { type: "mention", event: mention, resumed: true },
    } as unknown as Partial<Delivery>).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const text = fake.harnesses[0]?.turns[0]?.text ?? "";
    expect(text).toContain(RESUMED_PROMPT);
    expect(text).toContain("Also bump the version.");
    expect(text).not.toContain("Unrelated top-level chatter.");
    fake.harnesses[0]?.turns[0]?.finish();
  });

  it("resumes two threads of one channel session, each with its own history", async () => {
    const config = await confirmed({ scope: "channel" });
    const at = (event: RelayEvent, created_at: number, root?: RelayEvent) => {
      event.created_at = created_at;
      if (root) event.tags.push(["e", root.id, "", "root"]);
      return event;
    };
    const a = at(message("1", "@Opal thread A"), 101);
    const aLater = at(message("2", "A: also this.", "b".repeat(64)), 150, a);
    const b = at(message("3", "@Opal thread B"), 102);
    const bDone = at(message("4", "B: done, deployed.", self), 120, b);
    const bFix = at(
      message("5", "B: use staging instead.", "b".repeat(64)),
      121,
      b,
    );
    const { fake, sync, deliver } = setup(
      { hold: true },
      { read: async () => [a, aLater, b, bDone, bFix] },
    );
    sync(config);
    const resume = (event: RelayEvent) =>
      deliver(event, config, undefined, {
        trigger: { type: "mention", event, resumed: true },
      } as unknown as Partial<Delivery>).run;
    await resume(a);
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    fake.harnesses[0]?.turns[0]?.finish();
    await resume(b);
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    const [first, second] = fake.harnesses[0]?.turns ?? [];
    expect(second?.sessionId).toBe(first?.sessionId);
    const text = second?.text ?? "";
    expect(text).toContain("B: done, deployed.");
    expect(text).toContain("B: use staging instead.");
    // Still only its own thread, and nothing the session already saw.
    expect(text).not.toContain("A: also this.");
    second?.finish();
  });

  it("lets a channel-level wake reply in a thread", async () => {
    const config = await confirmed();
    const { fake, runtime, sync, workingUntil, published, agent } = setup({
      hold: true,
    });
    sync(config);
    const thread = message("7", "a thread");
    Object.assign(agent, { query: vi.fn(async () => [thread]) });
    await runtime.run({
      trigger: {
        type: "attention",
        id: "e".repeat(64),
        channel,
        topLevel: true,
        text: "The watched PR merged.",
        at: 200_000,
      },
      channelId: channel,
      agent,
      config,
      signal: new AbortController().signal,
      workingUntil,
    } as unknown as Delivery);
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    await harness?.mcp(harness.turns[0]?.sessionId ?? "", "tools/call", {
      name: "send",
      arguments: { text: "merged", audience: "everyone", reply: thread.id },
    });
    const sent = published.find((item) => item.content === "merged");
    expect(sent?.tags).toContainEqual(["e", thread.id, "", "reply"]);
    harness?.turns[0]?.finish();
  });

  it("drops an addressed wake with no conversation to go to", async () => {
    const config = await confirmed();
    const { fake, runtime, sync, workingUntil } = setup();
    sync(config);
    const ignored = vi.fn();
    await runtime.run({
      trigger: {
        type: "attention",
        id: "e".repeat(64),
        channel,
        text: "x",
        at: 1,
      },
      channelId: channel,
      agent: {
        key: self,
        pubkey: self,
        name: "Opal",
        owner: alice,
        relay: "wss://acp.example",
      },
      config,
      signal: new AbortController().signal,
      workingUntil,
      ignored,
    } as unknown as Delivery);
    expect(ignored).toHaveBeenCalled();
    expect(fake.harnesses.flatMap((h) => h.turns)).toEqual([]);
  });

  it("sends no prompt for a delivery that stopped being current", async () => {
    const config = await confirmed();
    let open!: () => void;
    const opening = new Promise<void>((resolve) => (open = resolve));
    const { fake, runtime, deliver, sync } = setup({ opening });
    sync(config);
    let live = true;
    const signal = new AbortController().signal;
    await deliver(message("1", "@Opal hello"), config, signal, {
      current: () => live,
    }).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.opened).toHaveLength(1));
    // Turned off while its session opens.
    live = false;
    open();
    await flush();
    const wake = await runtime.runOnce({
      delivery: {
        agent: {
          key: self,
          pubkey: self,
          name: "Opal",
          owner: alice,
          relay: "wss://acp.example",
        },
        config,
        current: () => false,
      } as unknown as Delivery,
      key: "timer",
      signal,
      prompt: async () => "wake",
    });
    expect(wake).toMatchObject({ ok: true });
    await flush();
    expect(fake.harnesses.flatMap((h) => h.sent("session/prompt"))).toEqual([]);
  });

  it("names each message's author in the prompt", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, session } = setup();
    (session.profiles as { snapshot: () => Map<string, unknown> }).snapshot =
      () =>
        new Map([[alice, { name: "Alice Liddell", nameIsFallback: false }]]);
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(fake.harnesses[0]?.turns[0]?.text).toContain("Alice Liddell");
    fake.harnesses[0]?.turns[0]?.finish();
  });

  it("names the person a workflow's message is from, not the signing authority", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, session } = setup(
      {},
      {
        read: async () => [
          {
            ...message("1", "Deploy finished", "workflow-authority"),
            tags: [
              ["h", channel],
              ["actor", alice],
            ],
          },
        ],
      },
    );
    (session.profiles as { snapshot: () => Map<string, unknown> }).snapshot =
      () =>
        new Map([[alice, { name: "Alice Liddell", nameIsFallback: false }]]);
    sync(config);
    await deliver(
      {
        ...message("2", "@Opal what happened?"),
        tags: [
          ["h", channel],
          ["p", self],
          ["e", "1".repeat(64), "", "reply"],
        ],
      },
      config,
    ).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const text = fake.harnesses[0]?.turns[0]?.text ?? "";
    expect(text).toContain("Deploy finished");
    expect(text.match(/Alice Liddell/g)).toHaveLength(2);
    fake.harnesses[0]?.turns[0]?.finish();
  });

  it("ignores a mention from someone other than the owner", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    const { run, ignored } = deliver(
      message("1", "@Opal rm -rf", mallory),
      config,
    );
    await run;
    await flush(50);
    expect(ignored).toHaveBeenCalled();
    expect(fake.harnesses).toEqual([]);
  });

  describe("a workflow's mention", () => {
    const workflow = (named: boolean) => {
      const relay = keypair();
      return {
        relay,
        event: eventDto(
          signed(relay, {
            kind: 9,
            content: "@Opal workflow",
            tags: [
              ["h", channel],
              ["p", self],
              ["buzz:workflow", "true"],
              ["buzz:workflow-owner", alice],
              ...(named ? [["buzz:workflow-mention", self]] : []),
            ],
          }),
        ) as RelayEvent,
      };
    };

    it("that arrives during a reconnect is answered once the community is ready", async () => {
      const config = await confirmed();
      const { relay, event } = workflow(true);
      const { fake, deliver, sync, connect } = setup(
        {},
        { workflowAuthority: relay.pubkey },
      );
      sync(config);
      connect("connecting");
      const { run, ignored } = deliver(event, config);
      await flush(20);
      expect(fake.harnesses).toEqual([]);
      connect("ready");
      await run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      expect(ignored).not.toHaveBeenCalled();
    });

    it("that doesn't name the agent is refused with the workflow reason", async () => {
      const config = await confirmed();
      const { relay, event } = workflow(false);
      const { fake, deliver, sync } = setup(
        {},
        { workflowAuthority: relay.pubkey },
      );
      sync(config);
      const { run, ignored } = deliver(event, config);
      await run;
      expect(ignored).toHaveBeenCalledExactlyOnceWith("workflow");
      expect(fake.harnesses).toEqual([]);
    });
  });

  it.each([
    ["a provider error", "Request failed: https://p.test/v1?key=SENTINEL"],
    ["a plain answer", "Here is my answer, SENTINEL"],
  ])(
    "posts nothing for %s the harness wrote without send",
    async (_, chunk) => {
      const config = await confirmed();
      const { runtime, deliver, sync, published, workingUntil } = setup({
        chunk,
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await reported(runtime, workingUntil);
      expect(published).toEqual([]);
    },
  );

  it("says in the thread that it can't run an unconfirmed launch", async () => {
    const config = { ...(await confirmed()), command: "edited" };
    const { fake, deliver, sync, published } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toContain(
      "Confirm this agent's command in its settings.",
    );
    expect(fake.harnesses).toEqual([]);
  });

  it("gives a missing program's install hint, and nothing it wrote", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({ exitCode: 127 });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(
      `${FAILED} Install OpenCode: https://opencode.ai`,
    );
  });

  it("names no custom command in a missing program's hint", async () => {
    const config = await confirmed({
      preset: "custom",
      command: "/private/CLIENT_SECRET_SYNTHETIC/agent",
      args: [],
    });
    const { runtime, deliver, sync, published, workingUntil } = setup({
      exitCode: 127,
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await reported(runtime, workingUntil);
    expect(await workingUntil.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("CLIENT_SECRET_SYNTHETIC"),
    });
    expect(published.map((event) => event.content)).toEqual([
      `${FAILED} Check the harness is installed and on your PATH.`,
    ]);
  });

  it("keeps a stored config's validation error local, secret and all", async () => {
    // As stored, outside Settings: a value pasted into an env name's slot.
    const config = {
      ...(await confirmed()),
      env: { "API_KEY=SYNTHETIC_SECRET": "" },
    };
    const { fake, runtime, deliver, sync, published, workingUntil } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await reported(runtime, workingUntil);
    expect(await workingUntil.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("SYNTHETIC_SECRET"),
    });
    expect(published.map((event) => event.content)).toEqual([FAILED]);
    expect(fake.harnesses).toEqual([]);
  });

  it("gives no hint for a harness error that imitates ours", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({
      promptError: {
        code: -32603,
        message: `Oops. ${missing(config.preset, config.command)}`,
      },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("says only that it failed when the harness refuses Buzz tools", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({
      capabilities: { mcpCapabilities: { http: false } },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("leads a new session with the core memory the host keeps", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup(
      {},
      { core: async () => "Prefers tabs." },
    );
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(fake.harnesses[0]?.turns[0]?.text).toContain("Prefers tabs.");
  });

  describe("core memory", () => {
    /** Two turns in one conversation, with core memory `before` then `after`
     * when the second arrives. */
    async function twoTurns(
      before: string | null,
      after: string | null,
      options: Parameters<typeof fakeHarness>[0] = {},
    ) {
      let memory = before;
      const config = await confirmed();
      const { fake, deliver, sync } = setup(options, {
        core: async () => memory,
      });
      sync(config);
      const root = message("1", "@Opal one");
      await deliver(root, config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      // Changed meanwhile, from any conversation.
      memory = after;
      const reply = message("2", "@Opal two");
      reply.tags.push(["e", root.id, "", "reply"]);
      await deliver(reply, config).run;
      return fake.harnesses[0] as NonNullable<(typeof fake.harnesses)[0]>;
    }

    it("reaches an open conversation at its next turn", async () => {
      const harness = await twoTurns("Prefers tabs.", "Prefers spaces.");
      await vi.waitFor(() => expect(harness.turns).toHaveLength(2));
      expect(harness.turns[1]?.sessionId).not.toBe(harness.turns[0]?.sessionId);
      expect(harness.turns[1]?.text).toContain("Prefers spaces.");
      expect(harness.turns[1]?.text).not.toContain("Prefers tabs.");
    });

    it("leaves an open conversation in place while it is unchanged", async () => {
      const harness = await twoTurns("Prefers tabs.", "Prefers tabs.");
      await vi.waitFor(() => expect(harness.turns).toHaveLength(2));
      expect(harness.turns[1]?.sessionId).toBe(harness.turns[0]?.sessionId);
    });

    it("drops cleared memory at the next turn", async () => {
      const harness = await twoTurns("Prefers tabs.", null);
      await vi.waitFor(() => expect(harness.turns).toHaveLength(2));
      expect(harness.turns[1]?.sessionId).not.toBe(harness.turns[0]?.sessionId);
      expect(harness.turns[1]?.text).not.toContain("Prefers tabs.");
    });

    it("keeps a turn queued behind running work on its session, and moves the next one", async () => {
      const config = await confirmed();
      let memory = "Prefers tabs.";
      const { fake, deliver, sync, workingUntil } = setup(
        { hold: true },
        { core: async () => memory },
      );
      sync(config);
      const root = message("1", "@Opal one");
      await deliver(root, config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const harness = fake.harnesses[0] as NonNullable<
        (typeof fake.harnesses)[0]
      >;
      memory = "Prefers spaces.";
      const queued = message("2", "@Opal two");
      queued.tags.push(["e", root.id, "", "reply"]);
      await deliver(queued, config).run;
      // An accepted limit: a message queued behind running work keeps that
      // work's session, and its memory, on a harness that can't be
      // re-prompted in place, as main's fallback for such harnesses does. The
      // next turn moves to the new memory.
      harness.turns[0]?.finish();
      await vi.waitFor(() => expect(harness.turns).toHaveLength(2));
      expect(harness.turns[1]?.sessionId).toBe(harness.turns[0]?.sessionId);
      harness.turns[1]?.finish();
      // The work has settled: the conversation is idle.
      await vi.waitFor(() => expect(workingUntil).toHaveBeenCalled());
      await Promise.all(workingUntil.mock.calls.map(([until]) => until));
      const next = message("3", "@Opal three");
      next.tags.push(["e", root.id, "", "reply"]);
      await deliver(next, config).run;
      await vi.waitFor(() => expect(harness.turns).toHaveLength(3));
      expect(harness.turns[2]?.sessionId).not.toBe(harness.turns[0]?.sessionId);
      expect(harness.turns[2]?.text).toContain("Prefers spaces.");
      harness.turns[2]?.finish();
    });

    it("never resumes a saved session opened on older memory", async () => {
      const resumable = { mcpCapabilities: { http: true }, loadSession: true };
      const config = await confirmed();
      const runs = async (memory: string, storage?: Storage) => {
        const run = setup(
          { capabilities: resumable },
          { core: async () => memory, ...(storage ? { storage } : {}) },
        );
        run.sync(config);
        const reply = message(storage ? "2" : "1", "@Opal hello");
        if (storage) reply.tags.push(["e", "1".repeat(64), "", "reply"]);
        await run.deliver(reply, config).run;
        // Settled and reported: its record is saved.
        await reported(run.runtime, run.workingUntil);
        run.runtime.dispose();
        return run;
      };
      const one = await runs("Prefers tabs.");
      const same = await runs("Prefers tabs.", one.storage);
      expect(same.fake.harnesses[0]?.sent("session/load")).toHaveLength(1);
      const changed = await runs("Prefers spaces.", one.storage);
      const harness = changed.fake.harnesses[0];
      expect(harness?.sent("session/load")).toHaveLength(0);
      expect(harness?.turns[0]?.text).toContain("Prefers spaces.");
    });
  });

  it("lists plugin-added tools, and reopens an idle session when they change", async () => {
    const tool = (name: string): AddedTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      call: async () => ({ content: [] }) as never,
    });
    let added: readonly AddedTool[] = [tool("pin")];
    const config = await confirmed();
    const { fake, deliver, sync } = setup({}, { added: () => added });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    const one = harness?.turns[0]?.sessionId ?? "";
    const listed = await harness?.mcp(one, "tools/list");
    const result = listed?.result as { tools?: { name: string }[] } | undefined;
    expect(result?.tools?.map((t) => t.name)).toContain("pin");
    await flush(50);
    added = [tool("pin"), tool("star")];
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    expect(harness?.turns[1]?.sessionId).not.toBe(one);
  });

  it("restarts the harness when its launch changes, and keeps it otherwise", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    sync({ ...config, instructions: "Be brief." });
    await flush(50);
    expect(fake.harnesses[0]?.killed).toBe(false);
    const next = await confirmed({ args: ["acp", "--port", "0"] });
    sync(next);
    await flush(50);
    expect(fake.harnesses[0]?.killed).toBe(true);
    await deliver(message("2", "@Opal again"), next).run;
    await vi.waitFor(() => expect(fake.harnesses[1]?.turns).toHaveLength(1));
    expect(fake.harnesses[1]?.options.args).toEqual([
      "opencode",
      "acp",
      "--port",
      "0",
    ]);
  });

  it("keeps a busy turn on its launch's process and opens the next message on the new one", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({ hold: true });
    sync(config);
    const first = message("1", "@Opal hello");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const next = await confirmed({ args: ["acp", "--port", "0"] });
    sync(next);
    await flush(50);
    // The running turn keeps its process.
    expect(fake.harnesses[0]?.killed).toBe(false);
    const reply = message("2", "@Opal again");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, next).run;
    await vi.waitFor(() => expect(fake.harnesses[1]?.turns).toHaveLength(1));
    expect(fake.harnesses[1]?.options.args).toContain("--port");
    expect(fake.harnesses[1]?.turns[0]?.text).toContain("@Opal again");
    expect(fake.harnesses[0]?.sent("session/prompt")).toHaveLength(1);
    // Its process stops once that turn is done.
    fake.harnesses[0]?.turns[0]?.finish();
    await vi.waitFor(() => expect(fake.harnesses[0]?.killed).toBe(true));
  });

  it("serves a message on the launch it opened with when the launch changes while it loads", async () => {
    const config = await confirmed();
    let loaded!: (events: RelayEvent[]) => void;
    const { fake, deliver, sync, published } = setup(
      {},
      { read: () => new Promise((resolve) => (loaded = resolve)) },
    );
    sync(config);
    const root = message("1", "@Opal hello");
    const reply = message("2", "@Opal again");
    reply.tags.push(["e", root.id, "", "reply"]);
    const { run } = deliver(reply, config);
    await vi.waitFor(() => expect(loaded).toBeDefined());
    sync(await confirmed({ args: ["acp", "--port", "0"] }));
    loaded([]);
    await run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(fake.harnesses[0]?.options.args).not.toContain("--port");
    expect(fake.harnesses).toHaveLength(1);
    expect(published).toHaveLength(0);
  });

  describe("resume", () => {
    const resumable = { mcpCapabilities: { http: true }, loadSession: true };
    /** One conversation's first turn, then a second turn in a new runtime
     * (as after an app restart) sharing the same storage. */
    async function twoRuns(
      first: Config,
      second: Config,
      capabilities: Record<string, unknown> = resumable,
      options: Parameters<typeof fakeHarness>[0] = {},
    ) {
      const one = setup({ capabilities, ...options });
      one.sync(first);
      const root = message("1", "@Opal hello");
      await one.deliver(root, first).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      await flush(20);
      one.runtime.dispose();
      const two = setup({ capabilities }, { storage: one.storage });
      two.sync(second);
      const reply = message("2", "@Opal again");
      reply.tags.push(["e", root.id, "", "reply"]);
      await two.deliver(reply, second).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      return two.fake.harnesses[0] as NonNullable<
        (typeof two.fake.harnesses)[0]
      >;
    }

    it("keeps a session's prompt in agent storage, through the startup move", async () => {
      const config = await confirmed({ instructions: INSTRUCTIONS });
      const local = memoryStorage();
      const saved = new Map<string, string>();
      const files = {
        load: async () => Object.fromEntries(saved),
        set: async (key: string, value: string | null) => {
          if (value === null) saved.delete(key);
          else saved.set(key, value);
        },
      };
      const one = setup(
        { capabilities: resumable },
        { storage: local, agentStore: await loadAgentStorage(local, files) },
      );
      one.sync(config);
      const root = message("1", "@Opal hello");
      await one.deliver(root, config).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      await flush(20);
      one.runtime.dispose();
      // The next start moves agent keys out of localStorage.
      const two = setup(
        {
          capabilities: resumable,
          replay: [
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "hi" },
            },
          ],
        },
        { storage: local, agentStore: await loadAgentStorage(local, files) },
      );
      two.sync(config);
      const read = await two.runtime.transcript(
        self,
        `${channel}/${root.id}`,
        new AbortController().signal,
      );
      expect(JSON.stringify(read?.turns[0])).toContain(INSTRUCTIONS);
    });

    it("keeps a new session's prompt, and never today's for a resumed one", async () => {
      const config = await confirmed({ instructions: INSTRUCTIONS });
      const one = setup({ capabilities: resumable });
      const prompts = sessionPrompts(localStore(one.storage), "acp", self);
      one.sync(config);
      const root = message("1", "@Opal hello");
      await one.deliver(root, config).run;
      await vi.waitFor(() =>
        expect(prompts.get("session-1")?.[0]?.text).toContain(INSTRUCTIONS),
      );
      await flush(20);
      one.runtime.dispose();
      // Saved before prompts were kept: its prompt stays unknown.
      await localStore(one.storage).set(`${PROMPTS_PREFIX}acp:${self}`, null);
      const two = setup({ capabilities: resumable }, { storage: one.storage });
      two.sync(config);
      const reply = message("2", "@Opal again");
      reply.tags.push(["e", root.id, "", "reply"]);
      await two.deliver(reply, config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      expect(two.fake.harnesses[0]?.sent("session/load")).toHaveLength(1);
      await flush(20);
      expect(prompts.get("session-1")).toBeUndefined();
    });

    it("loads the saved session and sends only what it hasn't seen, without instructions", async () => {
      const config = await confirmed({ instructions: INSTRUCTIONS });
      const harness = await twoRuns(config, config);
      expect(harness.sent("session/load")[0]?.params).toMatchObject({
        sessionId: "session-1",
      });
      expect(harness.sent("session/new")).toHaveLength(0);
      expect(harness.turns[0]?.text).toContain("@Opal again");
      expect(harness.turns[0]?.text).not.toContain(INSTRUCTIONS);
    });

    it("prefers session/resume when advertised", async () => {
      const config = await confirmed();
      const harness = await twoRuns(config, config, {
        ...resumable,
        sessionCapabilities: { resume: {} },
      });
      expect(harness.sent("session/resume")).toHaveLength(1);
      expect(harness.sent("session/load")).toHaveLength(0);
    });

    it("opens fresh, with instructions, when what the session opened with changed", async () => {
      const config = await confirmed({ instructions: INSTRUCTIONS });
      for (const changed of [
        { ...config, instructions: "Be brief." },
        { ...config, scope: "channel" as const },
        await confirmed({ instructions: INSTRUCTIONS, args: ["acp", "-v"] }),
      ]) {
        const harness = await twoRuns(config, changed);
        expect(harness.sent("session/load")).toHaveLength(0);
        expect(harness.sent("session/new")).toHaveLength(1);
      }
    });

    it("opens fresh when the harness can't load sessions", async () => {
      const config = await confirmed();
      const harness = await twoRuns(config, config, {
        mcpCapabilities: { http: true },
      });
      expect(harness.sent("session/load")).toHaveLength(0);
      expect(harness.sent("session/new")).toHaveLength(1);
    });

    it("keeps no pointer when the first prompt fails", async () => {
      const config = await confirmed();
      const harness = await twoRuns(config, config, resumable, {
        promptError: { code: -32603, message: "boom" },
      });
      expect(harness.sent("session/load")).toHaveLength(0);
      expect(harness.sent("session/new")).toHaveLength(1);
    });

    it("shows a replayed session's saved prompt at its top", async () => {
      const { runtime, storage, sync } = setup({
        capabilities: resumable,
        replay: [
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "hi" },
          },
        ],
      });
      sync(await confirmed());
      localSessions(storage, self).set(channel, { at: 1, id: "old" });
      await sessionPrompts(localStore(storage), "acp", self).save("old", [
        { label: "", text: "You are Opal." },
      ]);
      const read = await runtime.transcript(
        self,
        channel,
        new AbortController().signal,
      );
      expect(JSON.stringify(read?.turns[0])).toContain("You are Opal.");
    });

    it("places each replayed transcript turn in its saved conversation", async () => {
      const root = "a".repeat(64);
      const reply = "b".repeat(64);
      const said = (text: string, by = "user") => ({
        sessionUpdate: `${by}_message_chunk`,
        content: { type: "text", text },
      });
      const { runtime, storage, sync } = setup({
        capabilities: resumable,
        replay: [
          said("hi"),
          said("ok", "agent"),
          said(`then pass \`reply: "${reply}"\``),
        ],
      });
      sync(await confirmed());
      const signal = new AbortController().signal;
      const places = async (key: string) => {
        localSessions(storage, self).set(key, { at: 1, id: "old" });
        const read = await runtime.transcript(self, key, signal);
        return read?.turns.map((t) => [t.channelId, t.threadRootId]);
      };
      expect(await places(`${channel}/${root}`)).toEqual([
        [channel, root],
        [channel, root],
      ]);
      expect(await places(channel)).toEqual([
        [channel, undefined],
        [channel, reply],
      ]);
    });
    it("finds out again whether sessions replay after a launch change", async () => {
      const { runtime, storage, sync } = setup({
        capabilities: { mcpCapabilities: { http: true } },
      });
      const config = await confirmed();
      sync(config);
      localSessions(storage, self).set(channel, { at: 1, id: "old" });
      const signal = new AbortController().signal;
      await runtime.transcript(self, channel, signal);
      expect(runtime.replays(self)).toBe(false);
      sync(await confirmed({ args: ["acp", "--other"] }));
      expect(runtime.replays(self)).toBeUndefined();
      // A read begun on the old launch says nothing about the new one.
      const late = runtime.transcript(self, channel, signal);
      sync(config);
      await late;
      expect(runtime.replays(self)).toBeUndefined();
    });
  });

  describe("coverage", () => {
    const at = (event: RelayEvent, created_at: number) => ({
      ...event,
      created_at,
    });
    const inThread = (event: RelayEvent): RelayEvent => ({
      ...event,
      tags: [...event.tags, ["e", "f".repeat(64), "", "reply"]],
    });

    it("delivers a distinct message from a covered second, and a late older one", async () => {
      const config = await confirmed({ scope: "channel" });
      const { fake, deliver, sync } = setup();
      sync(config);
      await deliver(at(message("5", "@Opal first"), 105), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      await flush(20);
      await deliver(at(message("6", "@Opal same second"), 105), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
      await flush(20);
      await deliver(at(message("2", "@Opal late"), 102), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(3));
      const turns = fake.harnesses[0]?.turns ?? [];
      expect(turns[1]?.text).toContain("@Opal same second");
      expect(turns[2]?.text).toContain("@Opal late");
      // The same event again is covered.
      await flush(20);
      await deliver(at(message("6", "@Opal same second"), 105), config).run;
      await flush(50);
      expect(turns).toHaveLength(3);
    });

    it("answers a mention an earlier prompt showed only as context", async () => {
      const config = await confirmed({ scope: "channel" });
      const first = at(message("5", "@Opal first"), 105);
      const tie = at(message("6", "@Opal same second"), 105);
      const { fake, deliver, sync } = setup(
        {},
        { read: async () => [first, tie] },
      );
      sync(config);
      await deliver(first, config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      expect(fake.harnesses[0]?.turns[0]?.text).toContain("@Opal same second");
      await flush(20);
      await deliver(tie, config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    });

    it("answers a request a saved mark showed only as context once, across restarts", async () => {
      const config = await confirmed({ scope: "channel" });
      const capabilities = {
        mcpCapabilities: { http: true },
        loadSession: true,
      };
      const first = at(message("5", "@Opal first"), 105);
      const tie = at(message("6", "@Opal same second"), 105);
      const one = setup({ capabilities });
      one.sync(config);
      await one.deliver(first, config).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      await flush(20);
      one.runtime.dispose();
      // A mark saved before marks named their requests: both ids, no requests.
      const saved = localSessions(one.storage, self);
      const record = saved.get(channel);
      saved.set(channel, {
        ...record,
        covered: { at: 105, ids: [first.id, tie.id] },
      } as NonNullable<typeof record>);
      const relayed = { read: async () => [first, tie] };
      const two = setup({ capabilities }, { storage: one.storage, ...relayed });
      two.sync(config);
      await two.deliver(tie, config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      await flush(20);
      two.runtime.dispose();
      const three = setup(
        { capabilities },
        { storage: one.storage, ...relayed },
      );
      three.sync(config);
      await three.deliver(tie, config).run;
      await vi.waitFor(() => expect(three.workingUntil).toHaveBeenCalled());
      await three.workingUntil.mock.calls[0]?.[0];
      expect(three.fake.harnesses.flatMap((h) => h.turns)).toEqual([]);
    });

    it("keeps identity coverage across a resume", async () => {
      const config = await confirmed({ scope: "channel" });
      const capabilities = {
        mcpCapabilities: { http: true },
        loadSession: true,
      };
      const first = at(message("5", "@Opal first"), 105);
      const tie = at(message("6", "@Opal same second"), 105);
      const one = setup({ capabilities });
      one.sync(config);
      await one.deliver(first, config).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      await flush(20);
      one.runtime.dispose();
      // The resumed session reads both from the relay; only the tie is new.
      const two = setup(
        { capabilities },
        { storage: one.storage, read: async () => [first, tie] },
      );
      two.sync(config);
      await two.deliver(tie, config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      const [harness] = two.fake.harnesses;
      expect(harness?.sent("session/load")).toHaveLength(1);
      expect(harness?.turns[0]?.text).toContain("@Opal same second");
      expect(harness?.turns[0]?.text).not.toContain("@Opal first");
    });

    it("carries a failed late message into a later prompt, live and after a resume", async () => {
      const config = await confirmed({ scope: "channel" });
      const capabilities = {
        mcpCapabilities: { http: true },
        loadSession: true,
      };
      const a = inThread(at(message("1", "@Opal a"), 100));
      const b = inThread(at(message("2", "@Opal late b"), 90));
      const c = inThread(at(message("3", "@Opal c"), 110));
      const d = inThread(at(message("4", "@Opal d"), 120));
      // The relay has only what has arrived.
      const seen: RelayEvent[] = [];
      const read = async () => [...seen];
      const one = setup({ capabilities, hold: true }, { read });
      one.sync(config);
      const turns = () => one.fake.harnesses[0]?.turns ?? [];
      seen.push(a);
      await one.deliver(a, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      turns()[0]?.finish();
      await flush(20);
      seen.push(b);
      await one.deliver(b, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      seen.push(c);
      await one.deliver(c, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
      // Refused again: still owed across a restart.
      turns()[2]?.fail(-32603, "refused");
      await flush(20);
      one.runtime.dispose();
      const two = setup(
        { capabilities },
        { storage: one.storage, read: async () => [b, a, c] },
      );
      two.sync(config);
      await two.deliver(d, config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      const [harness] = two.fake.harnesses;
      expect(harness?.sent("session/load")).toHaveLength(1);
      expect(harness?.turns[0]?.text).toContain("@Opal late b");
      expect(harness?.turns[0]?.text).not.toContain("@Opal a");
      // Once carried by a successful prompt, it is no longer owed.
      await flush(20);
      await two.deliver(inThread(at(message("5", "@Opal e"), 130)), config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(2),
      );
      expect(harness?.turns[1]?.text).not.toContain("@Opal late b");
    });

    /** A session where A succeeded and late B was refused, so B is owed. */
    const owedB = async () => {
      const config = await confirmed({ scope: "channel" });
      const a = inThread(at(message("1", "@Opal a"), 100));
      const b = inThread(at(message("2", "@Opal late b"), 90));
      const seen: RelayEvent[] = [a];
      const one = setup(
        {
          capabilities: { mcpCapabilities: { http: true }, loadSession: true },
          hold: true,
        },
        { read: async () => [...seen] },
      );
      one.sync(config);
      const turns = () => one.fake.harnesses[0]?.turns ?? [];
      await one.deliver(a, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      turns()[0]?.finish();
      await flush(20);
      seen.push(b);
      await one.deliver(b, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      const next = (id: string, created: number) => {
        const event = inThread(at(message(id, `@Opal ${id}`), created));
        seen.push(event);
        return event;
      };
      return { ...one, config, b, turns, next };
    };

    it("still owes a message whose carrying turn was stopped", async () => {
      const { deliver, config, turns, next } = await owedB();
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
      await deliver(next("3", 110), config, undefined, { interruptible }).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
      await interruptible.mock.calls[0]?.[0]();
      turns()[2]?.finish("cancelled");
      await flush(20);
      await deliver(next("4", 120), config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(4));
      expect(turns()[3]?.text).toContain("@Opal late b");
    });

    it("carries a failed message into a successor already waiting", async () => {
      const { deliver, config, turns, next } = await owedB();
      await deliver(next("3", 110), config).run;
      await flush(20);
      turns()[1]?.fail(-32603, "refused");
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
    });

    it("still owes a message after an early final send and a refused prompt", async () => {
      const { deliver, config, turns, next, fake } = await owedB();
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      await deliver(next("3", 110), config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      await fake.harnesses[0]?.mcp(turns()[2]?.sessionId ?? "", "tools/call", {
        name: "send",
        arguments: { text: "early", audience: "everyone", final: true },
      });
      await flush(20);
      turns()[2]?.fail(-32603, "refused");
      await flush(20);
      await deliver(next("4", 120), config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(4));
      expect(turns()[3]?.text).toContain("@Opal late b");
    });

    it("fetches an owed message by id after a restart, past the recent window", async () => {
      const { runtime, storage, config, b, turns } = await owedB();
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      runtime.dispose();
      const replies = Array.from({ length: 201 }, (_, i) =>
        inThread(at(message(`r${i}`, `@Opal reply ${i}`), 200 + i)),
      );
      // The relay honours the filters: the thread window holds only the
      // newest 200 replies; B comes back only when asked for by id.
      const two = setup(
        {
          capabilities: { mcpCapabilities: { http: true }, loadSession: true },
        },
        {
          storage,
          read: async (filters) => [
            ...replies.slice(-200),
            ...(filters.some((f) => f.ids?.includes(b.id)) ? [b] : []),
          ],
        },
      );
      two.sync(config);
      await two.deliver(inThread(at(message("t", "@Opal t"), 500)), config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      expect(two.fake.harnesses[0]?.sent("session/load")).toHaveLength(1);
      expect(two.fake.harnesses[0]?.turns[0]?.text).toContain("@Opal late b");
    });

    /** `event` as a reply in the thread rooted at `root`. */
    const under = (root: string, event: RelayEvent): RelayEvent => ({
      ...event,
      tags: [...event.tags, ["e", root.repeat(64).slice(0, 64), "", "reply"]],
    });
    /** A relay that honours id, thread and channel filters over `seen`. */
    const honouring =
      (seen: RelayEvent[]) =>
      async (filters: { ids?: string[]; "#e"?: string[] }[]) =>
        seen.filter((event) =>
          filters.some((f) =>
            f.ids
              ? f.ids.includes(event.id)
              : f["#e"]
                ? event.tags.some((t) => t[0] === "e" && t[1] === f["#e"]?.[0])
                : true,
          ),
        );

    for (const elsewhere of ["another thread", "a top-level post"])
      it(`recovers a failed message from one thread in ${elsewhere}, then after a restart`, async () => {
        const config = await confirmed({ scope: "channel" });
        const capabilities = {
          mcpCapabilities: { http: true },
          loadSession: true,
        };
        const a = under("1", at(message("2", "@Opal a"), 100));
        const b = under("1", at(message("3", "@Opal late b"), 90));
        const c = at(message("4", "@Opal c"), 110);
        const place = (event: RelayEvent) =>
          elsewhere === "a top-level post" ? event : under("9", event);
        const seen: RelayEvent[] = [a];
        const one = setup(
          { capabilities, hold: true },
          { read: honouring(seen) },
        );
        one.sync(config);
        const turns = () => one.fake.harnesses[0]?.turns ?? [];
        await one.deliver(a, config).run;
        await vi.waitFor(() => expect(turns()).toHaveLength(1));
        turns()[0]?.finish();
        await flush(20);
        seen.push(b, place(c));
        await one.deliver(b, config).run;
        await vi.waitFor(() => expect(turns()).toHaveLength(2));
        turns()[1]?.fail(-32603, "refused");
        await flush(20);
        await one.deliver(place(c), config).run;
        await vi.waitFor(() => expect(turns()).toHaveLength(3));
        expect(turns()[2]?.text).toContain("@Opal late b");
        turns()[2]?.fail(-32603, "refused");
        await flush(20);
        one.runtime.dispose();
        const d = place(at(message("5", "@Opal d"), 120));
        seen.push(d);
        const two = setup(
          { capabilities },
          { storage: one.storage, read: honouring(seen) },
        );
        two.sync(config);
        await two.deliver(d, config).run;
        await vi.waitFor(() =>
          expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
        );
        expect(two.fake.harnesses[0]?.sent("session/load")).toHaveLength(1);
        expect(two.fake.harnesses[0]?.turns[0]?.text).toContain("@Opal late b");
      });

    it("keeps a thread-scoped session to its own thread's messages", async () => {
      const config = await confirmed({ scope: "thread" });
      const b = under("1", at(message("3", "@Opal late b"), 90));
      const c = under("9", at(message("4", "@Opal c"), 110));
      const d = under("1", at(message("5", "@Opal d"), 120));
      const seen = [b, c, d];
      const { fake, deliver, sync } = setup(
        { hold: true },
        { read: honouring(seen) },
      );
      sync(config);
      const turns = () => fake.harnesses[0]?.turns ?? [];
      await deliver(b, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      turns()[0]?.fail(-32603, "refused");
      await flush(20);
      await deliver(c, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      expect(turns()[1]?.text).not.toContain("@Opal late b");
      turns()[1]?.finish();
      await flush(20);
      await deliver(d, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
      expect(turns()[2]?.text).not.toContain("@Opal c");
    });

    it("posts nothing for a waiting delivery cancelled by its signal, and still owes it", async () => {
      const config = await confirmed({ scope: "channel" });
      const a = inThread(at(message("1", "@Opal a"), 100));
      const b = inThread(at(message("2", "@Opal b"), 101));
      const c = inThread(at(message("3", "@Opal c"), 102));
      const model = (value: string) => ({ value, name: value });
      const { fake, deliver, sync, published } = setup(
        {
          capabilities: { mcpCapabilities: { http: true } },
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "x",
              options: [model("x"), model("y")],
            },
          ],
          hold: true,
        },
        { read: async () => [a, b, c] },
      );
      sync(config);
      const turns = () => fake.harnesses[0]?.turns ?? [];
      const signal = new AbortController().signal;
      await deliver(a, config, signal, { model: "y" }).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      // A harness-default turn waits in line behind the running turn.
      const cancel = new AbortController();
      await deliver(b, config, cancel.signal).run;
      await flush(20);
      cancel.abort(new Error("cancelled"));
      await flush(20);
      expect(published).toEqual([]);
      turns()[0]?.finish();
      await flush(20);
      await deliver(c, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      expect(turns()[1]?.text).toContain("@Opal b");
      expect(published).toEqual([]);
    });

    it("counts only rendered context as seen", async () => {
      const config = await confirmed({ scope: "channel" });
      const earlier = Array.from({ length: 20 }, (_, i) =>
        inThread(at(message(`e${i}`, `@Opal early ${i}`), 100)),
      );
      const { fake, deliver, sync } = setup({}, { read: async () => earlier });
      sync(config);
      await deliver(inThread(at(message("t", "@Opal trigger"), 100)), config)
        .run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const turns = fake.harnesses[0]?.turns ?? [];
      expect(turns[0]?.text).toContain("@Opal early 19");
      expect(turns[0]?.text).not.toContain("@Opal early 0");
      await flush(20);
      await deliver(earlier[0] as RelayEvent, config).run;
      await vi.waitFor(() => expect(turns).toHaveLength(2));
      expect(turns[1]?.text).toContain("@Opal early 0");
    });
  });

  it("keeps a retired session's tools in its own thread when a replacement opens", async () => {
    const config = await confirmed({ scope: "channel" });
    const { fake, deliver, sync, published } = setup({ hold: true });
    sync(config);
    const t1 = message("1", "@Opal one");
    const a = message("2", "@Opal in one");
    a.tags.push(["e", t1.id, "", "root"]);
    await deliver(a, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const retired = fake.harnesses[0]?.turns[0]?.sessionId ?? "";
    const edited = { ...config, instructions: "Be brief." };
    sync(edited);
    const t2 = message("3", "@Opal two");
    const b = message("4", "@Opal in two");
    b.tags.push(["e", t2.id, "", "root"]);
    await deliver(b, edited).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    expect(fake.harnesses[0]?.turns[1]?.sessionId).not.toBe(retired);
    await fake.harnesses[0]?.mcp(retired, "tools/call", {
      name: "send",
      arguments: { text: "answer for one", audience: "everyone" },
    });
    const sent = published.find((item) => item.content === "answer for one");
    // A plain send answers in A's thread, not B's.
    expect(sent?.tags).toContainEqual(["e", a.id, "", "reply"]);
    expect(JSON.stringify(sent?.tags)).not.toContain(b.id);
  });

  it("stamps a pinned session's tool posts with its context size, in its own place", async () => {
    const config = await confirmed({ scope: "channel" });
    const { fake, deliver, sync, published } = setup({ hold: true });
    sync(config);
    const root = message("1", "@Opal one");
    const a = message("2", "@Opal in one");
    a.tags.push(["e", root.id, "", "root"]);
    await deliver(a, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const harness = fake.harnesses[0];
    const sessionId = harness?.turns[0]?.sessionId ?? "";
    harness?.update(sessionId, {
      sessionUpdate: "usage_update",
      used: 43_210,
      size: 200_000,
    });
    await flush(5);
    await harness?.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { text: "sized answer", audience: "everyone" },
    });
    const sent = published.find((item) => item.content === "sized answer");
    expect(sent?.tags).toContainEqual(["buzz:context", "43210"]);
    // The pinned session's own place: it answers in A's thread.
    expect(sent?.tags).toContainEqual(["e", a.id, "", "reply"]);
  });

  it("acts with each conversation's own delivery handle", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, agent } = setup({ hold: true });
    sync(config);
    const handle = () => ({
      ...agent,
      publish: vi.fn((...args: Parameters<typeof agent.publish>) =>
        agent.publish(...args),
      ),
    });
    const [one, two] = [handle(), handle()];
    await deliver(message("1", "@Opal one"), config, undefined, {
      agent: one,
    } as unknown as Partial<Delivery>).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await deliver(message("2", "@Opal two"), config, undefined, {
      agent: two,
    } as unknown as Partial<Delivery>).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    const [a, b] = fake.harnesses[0]?.turns ?? [];
    expect(b?.sessionId).not.toBe(a?.sessionId);
    await fake.harnesses[0]?.mcp(a?.sessionId ?? "", "tools/call", {
      name: "send",
      arguments: { text: "answer for one", audience: "everyone" },
    });
    // A's reply is A's delivery's, though B's arrived after it.
    expect(one.publish).toHaveBeenCalledTimes(1);
    expect(two.publish).not.toHaveBeenCalled();
  });

  it.each([
    ["channel", "That is this conversation."],
    ["thread", "Queued self-handoff"],
  ] as const)(
    "tells a %s-scoped session's other threads apart for self_handoff",
    async (scope, answer) => {
      const config = await confirmed({ scope });
      const { fake, deliver, sync, agent } = setup({ hold: true });
      sync(config);
      const other = message("3", "other thread");
      const handoff = vi.fn();
      const query = vi.fn(async (filters: unknown) =>
        JSON.stringify(filters).includes("39000")
          ? [
              {
                ...message("4", ""),
                kind: 39000,
                tags: [["d", channel]],
              },
            ]
          : [other],
      );
      Object.assign(agent, { query });
      const root = message("1", "start");
      const reply = message("2", "@Opal hi");
      reply.tags.push(["e", root.id, "", "root"]);
      await deliver(reply, config, undefined, {
        agent: { ...agent, handoff },
      } as unknown as Partial<Delivery>).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const result = await fake.harnesses[0]?.mcp(
        fake.harnesses[0]?.turns[0]?.sessionId ?? "",
        "tools/call",
        {
          name: "self_handoff",
          arguments: { channel, thread: other.id, text: "carry on" },
        },
      );
      expect(JSON.stringify(result)).toContain(answer);
      expect(handoff).toHaveBeenCalledTimes(scope === "thread" ? 1 : 0);
    },
  );

  it("starts a new session from the session controls, and can't compact", async () => {
    const config = await confirmed({ scope: "channel" });
    const { fake, deliver, sync, runtime, agent } = setup();
    sync(config);
    const subject = { ...agent, config } as unknown as Parameters<
      AcpRuntime["session"]
    >[0];
    const place = { channelId: channel };
    await deliver(message("1", "@Opal one"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await vi.waitFor(() =>
      expect(runtime.sessionState(subject, place)).toBe("idle"),
    );
    await expect(runtime.session(subject, place, "compact")).rejects.toThrow(
      "can't compact",
    );
    await runtime.session(subject, place, "new");
    await deliver(message("2", "@Opal two"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    const [one, two] = fake.harnesses[0]?.turns ?? [];
    expect(two?.sessionId).not.toBe(one?.sessionId);
  });

  it("shows a working session's transcript before any turn of it is saved", async () => {
    const config = await confirmed({ scope: "channel" });
    const { fake, deliver, sync, runtime, storage } = setup({
      hold: true,
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
    });
    sync(config);
    await deliver(message("1", "@Opal one"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(runtime.conversations(self)[0]).toMatchObject({
      status: "Working",
      session: "session-1",
      replayable: true,
    });
    const before = fake.harnesses.length;
    await runtime.transcript(self, channel, new AbortController().signal);
    expect(
      fake.harnesses
        .slice(before)
        .flatMap((h) => h.sent("session/load"))
        .map((m) => m.params?.sessionId),
    ).toEqual(["session-1"]);
    // Viewing it never makes it the one to resume.
    expect(localSessions(storage, self).get(channel)?.id).toBeUndefined();
    fake.harnesses[0]?.turns[0]?.finish();
  });

  it("keeps a replaced session's transcript beside the resume pointer", async () => {
    const config = await confirmed({ scope: "channel" });
    const { fake, deliver, sync, runtime, agent, storage } = setup({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
    });
    sync(config);
    const subject = { ...agent, config } as unknown as Parameters<
      AcpRuntime["session"]
    >[0];
    const place = { channelId: channel };
    await deliver(message("1", "@Opal one"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await vi.waitFor(() =>
      expect(runtime.sessionState(subject, place)).toBe("idle"),
    );
    await runtime.session(subject, place, "new");
    await deliver(message("2", "@Opal two"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    await flush(20);
    const saved = localSessions(storage, self).get(channel);
    expect(saved?.id).toBe("session-2");
    expect(saved?.sessions).toEqual(["session-2", "session-1"]);
    const before = fake.harnesses.length;
    await runtime.transcript(self, channel, new AbortController().signal);
    const loaded = fake.harnesses
      .slice(before)
      .flatMap((h) => h.sent("session/load"))
      .map((m) => m.params?.sessionId);
    expect(loaded).toEqual(["session-1", "session-2"]);
  });

  it("keeps a conversation saved before history was kept through New and replacement", async () => {
    const config = await confirmed({ scope: "channel" });
    const legacy = () => {
      const one = setup({
        capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      });
      // Saved with only its resume pointer.
      localSessions(one.storage, self).set(channel, { at: 1, id: "A" });
      one.sync(config);
      return one;
    };
    // New with no live session: A stays in the history, not resumable.
    const fresh = legacy();
    const subject = { ...fresh.agent, config } as unknown as Parameters<
      AcpRuntime["session"]
    >[0];
    await fresh.runtime.session(subject, { channelId: channel }, "new");
    const cleared = localSessions(fresh.storage, self).get(channel);
    expect(cleared?.id).toBeUndefined();
    expect(cleared?.sessions).toEqual(["A"]);
    await fresh.deliver(message("1", "@Opal one"), config).run;
    await vi.waitFor(() =>
      expect(fresh.fake.harnesses[0]?.turns).toHaveLength(1),
    );
    expect(fresh.fake.harnesses[0]?.sent("session/load")).toHaveLength(0);
    // Replaced, since what A opened with is unknown: A stays beside B.
    const replaced = legacy();
    await replaced.deliver(message("1", "@Opal one"), config).run;
    await vi.waitFor(() =>
      expect(replaced.fake.harnesses[0]?.turns).toHaveLength(1),
    );
    await flush(20);
    const saved = localSessions(replaced.storage, self).get(channel);
    expect(saved?.id).toBe("session-1");
    expect(saved?.sessions).toEqual(["session-1", "A"]);
  });

  it("lists a standalone turn's session in History, with its transcript", async () => {
    const config = await confirmed();
    const { fake, runtime, sync } = setup({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
    });
    sync(config);
    const done = await runtime.runOnce({
      delivery: {
        agent: {
          key: self,
          pubkey: self,
          name: "Opal",
          owner: alice,
          relay: "wss://acp.example",
        },
        config,
        current: () => true,
      } as unknown as Delivery,
      key: "timer",
      signal: new AbortController().signal,
      prompt: async () => "wake",
    });
    expect(done).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(runtime.conversations(self).map((row) => row.title)).toEqual([
        "Standalone turn",
      ]),
    );
    const [row] = runtime.conversations(self);
    expect(row?.replayable).toBe(true);
    const before = fake.harnesses.length;
    await runtime.transcript(
      self,
      row?.key ?? "",
      new AbortController().signal,
    );
    const loaded = fake.harnesses
      .slice(before)
      .flatMap((h) => h.sent("session/load"))
      .map((m) => m.params?.sessionId);
    expect(loaded).toEqual(["session-1"]);
  });

  it("names a replayed request's author as the community knows them", async () => {
    const prompt = [
      "<buzz-event>",
      JSON.stringify({ id: "e".repeat(64), pubkey: alice, content: "Ship it" }),
      `Request: ${JSON.stringify("Ship it")}`,
      "</buzz-event>",
    ].join("\n");
    const { runtime, storage, sync } = setup({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay: [
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: prompt },
        },
      ],
    });
    sync(await confirmed());
    localSessions(storage, self).set(channel, { at: 1, id: "old" });
    const read = await runtime.transcript(
      self,
      channel,
      new AbortController().signal,
    );
    expect(
      read?.turns
        .flatMap((turn) => turn.items)
        .find((i) => i.type === "prompt"),
    ).toMatchObject({ author: "Alice", authorPubkey: alice });
  });

  it("shows the sessions it can still load when an older one is gone", async () => {
    const said = (text: string) => ({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });
    const { runtime, storage, sync, fake } = setup({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay: [said("hi")],
      gone: ["gone-A"],
    });
    sync(await confirmed());
    localSessions(storage, self).set(channel, {
      at: 1,
      id: "B",
      sessions: ["B", "gone-A"],
    });
    const read = await runtime.transcript(
      self,
      channel,
      new AbortController().signal,
    );
    const loaded = fake.harnesses
      .flatMap((h) => h.sent("session/load"))
      .map((m) => m.params?.sessionId);
    expect(loaded).toEqual(["gone-A", "B"]);
    expect(read?.missing).toBe(1);
    expect(read?.turns).toHaveLength(1);
  });

  it("fails a read when none of its sessions load, and when stopped", async () => {
    const { runtime, storage, sync } = setup({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      gone: ["gone-A"],
    });
    sync(await confirmed());
    localSessions(storage, self).set(channel, { at: 1, id: "gone-A" });
    await expect(
      runtime.transcript(self, channel, new AbortController().signal),
    ).rejects.toThrow("Session not found");
    const stop = new AbortController();
    stop.abort();
    await expect(
      runtime.transcript(self, channel, stop.signal),
    ).rejects.toThrow();
  });

  it("retires an agent once its sessions and processes have stopped", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, runtime } = setup({
      hold: true,
      holdExit: true,
    });
    sync(config);
    await deliver(message("1", "@Opal one"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    let retired = false;
    const retiring = runtime.retire(self).then(() => (retired = true));
    // Joined, not finished early, by a second call.
    void runtime.retire(self).then(() => expect(retired).toBe(true));
    await vi.waitFor(() => expect(fake.harnesses[0]?.killed).toBe(true));
    await flush(50);
    // Its process hasn't exited yet.
    expect(retired).toBe(false);
    fake.harnesses[0]?.exit();
    await retiring;
    expect(runtime.sessions(self)).toEqual([]);
  });

  it("acts with a standalone turn's own handle after a mention arrives", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, runtime, agent } = setup({ hold: true });
    sync(config);
    const handle = () => ({
      ...agent,
      publish: vi.fn((...args: Parameters<typeof agent.publish>) =>
        agent.publish(...args),
      ),
    });
    const [wake, mention] = [handle(), handle()];
    void runtime.runOnce({
      delivery: { agent: wake, config } as unknown as Delivery,
      key: "timer",
      signal: new AbortController().signal,
      prompt: async () => "wake",
    });
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await deliver(message("2", "@Opal two"), config, undefined, {
      agent: mention,
    } as unknown as Partial<Delivery>).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    const [a] = fake.harnesses[0]?.turns ?? [];
    await fake.harnesses[0]?.mcp(a?.sessionId ?? "", "tools/call", {
      name: "send",
      arguments: { text: "from the wake", audience: "everyone", channel },
    });
    expect(wake.publish).toHaveBeenCalledTimes(1);
    expect(mention.publish).not.toHaveBeenCalled();
  });

  it("re-initializes the harness on Recheck", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, runtime } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(await runtime.recheck(self)).toBeUndefined();
    await vi.waitFor(() => expect(fake.harnesses).toHaveLength(2));
    expect(fake.harnesses[1]?.sent("initialize")).toHaveLength(1);
  });

  it("feeds the model picker from the session's options and applies the pinned model", async () => {
    const config = await confirmed({ model: "b" });
    const { fake, deliver, sync, cache } = setup({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [
            { value: "a", name: "A" },
            { value: "b", name: "B" },
          ],
        },
      ],
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(
      fake.harnesses[0]?.sent("session/set_config_option")[0]?.params,
    ).toMatchObject({
      configId: "model",
      value: "b",
    });
    expect(picks(cache, config).models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("runs a standalone wake on the saved model and effort, not the harness defaults", async () => {
    const config = await confirmed({ model: "b", effort: "high" });
    const select = (id: string, category: string, values: string[]) => ({
      id,
      name: id,
      category,
      type: "select",
      currentValue: values[0],
      options: values.map((value) => ({ value, name: value })),
    });
    const { fake, runtime, sync } = setup({
      configOptions: [
        select("model", "model", ["a", "b"]),
        select("effort", "thought_level", ["low", "high"]),
      ],
    });
    sync(config);
    const delivery = {
      agent: {
        key: self,
        pubkey: self,
        name: "Opal",
        owner: alice,
        relay: "wss://acp.example",
      },
      config,
    } as unknown as Delivery;
    const done = runtime.runOnce({
      delivery,
      key: "timer",
      signal: new AbortController().signal,
      prompt: async () => "wake",
    });
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    fake.harnesses[0]?.turns[0]?.finish();
    await done;
    const steps = (fake.harnesses[0]?.received ?? []).flatMap((m) =>
      m.method === "session/set_config_option"
        ? [m.params?.value]
        : m.method === "session/prompt"
          ? ["prompt"]
          : [],
    );
    expect(steps).toEqual(["b", "high", "prompt"]);
  });

  it("refuses a synced effort the harness doesn't offer, unless the message picks its own", async () => {
    const config = await confirmed();
    const { fake, runtime, deliver, sync, published, workingUntil } = setup({
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [{ value: "low", name: "low" }],
        },
      ],
    });
    sync(config);
    const signal = new AbortController().signal;
    const synced = { synced: { effort: "high" } };
    await deliver(message("1", "@Opal think"), config, signal, synced).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(fake.harnesses[0]?.sent("session/prompt")).toEqual([]);
    await expect(workingUntil.mock.calls[0]?.[0]).resolves.toMatchObject({
      error: expect.stringContaining('synced effort "high"'),
    });
    // A watch or timer is checked the same way.
    const wake = await runtime.runOnce({
      delivery: {
        agent: {
          key: self,
          pubkey: self,
          name: "Opal",
          owner: alice,
          relay: "wss://acp.example",
        },
        config,
        ...synced,
      } as unknown as Delivery,
      key: "timer",
      signal,
      prompt: async () => "wake",
    });
    expect(wake).toMatchObject({ ok: false });
    expect(wake.error).toContain('synced effort "high"');
    expect(fake.harnesses.flatMap((h) => h.turns)).toEqual([]);
    // The message's own pick runs on its own level.
    void deliver(message("2", "@Opal think"), config, signal, {
      ...synced,
      effort: "low",
    }).run;
    await vi.waitFor(() =>
      expect(fake.harnesses.flatMap((h) => h.turns)).toHaveLength(1),
    );
  });

  it("refuses a model in an open session once only its setting turns synced", async () => {
    const config = await confirmed({ model: "gone" });
    const { fake, deliver, sync, workingUntil } = setup({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "a" }],
        },
      ],
    });
    sync(config);
    await deliver(message("1", "@Opal hi"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    fake.harnesses[0]?.turns[0]?.finish();
    await workingUntil.mock.calls[0]?.[0];
    await deliver(message("2", "@Opal again"), config, undefined, {
      synced: { model: "gone" },
    }).run;
    await expect(workingUntil.mock.calls[1]?.[0]).resolves.toMatchObject({
      error: expect.stringContaining('synced model "gone"'),
    });
    expect(fake.harnesses.flatMap((h) => h.turns)).toHaveLength(1);
  });

  it("fails only a refused wake in a queue, and reports it in its own thread", async () => {
    const config = await confirmed({ model: "gone", scope: "channel" });
    let open!: () => void;
    const opening = new Promise<void>((resolve) => (open = resolve));
    const { fake, runtime, deliver, sync, published, workingUntil } = setup({
      hold: true,
      opening,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "a" }],
        },
      ],
    });
    sync(config);
    const inThread = (event: RelayEvent, root: string) => ({
      ...event,
      tags: [...event.tags, ["e", root, "", "reply"]],
    });
    const signal = new AbortController().signal;
    await deliver(
      inThread(message("1", "@Opal one"), "1".repeat(64)),
      config,
      signal,
      { model: "a", synced: { model: "gone" } },
    ).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.opened).toHaveLength(1));
    const wakeRoot = "d".repeat(64);
    const waking = runtime.run({
      trigger: {
        type: "attention",
        id: "e".repeat(64),
        channel,
        root: wakeRoot,
        text: "wake",
        at: 200_000,
      },
      channelId: channel,
      agent: {
        key: self,
        pubkey: self,
        name: "Opal",
        owner: alice,
        relay: "wss://acp.example",
        publish: vi.fn(async (t: { content: string; tags: string[][] }) => {
          published.push(t);
          return t;
        }),
      },
      config,
      signal,
      workingUntil,
      synced: { model: "gone" },
    } as unknown as Delivery);
    const lateRoot = "3".repeat(64);
    const later = deliver(
      inThread(message("3", "@Opal three"), lateRoot),
      config,
      signal,
      { model: "a", synced: { model: "gone" } },
    ).run;
    // All three are admitted to one session's queue before it opens.
    await Promise.all([waking, later]);
    expect(workingUntil).toHaveBeenCalledTimes(3);
    open();
    // The two valid turns prompt in turn; the refused wake never does.
    const turns = fake.harnesses[0]?.turns ?? [];
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]?.finish();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]?.finish();
    expect(fake.harnesses[0]?.opened).toHaveLength(1);
    expect(turns[1]?.sessionId).toBe(turns[0]?.sessionId);
    expect(fake.harnesses[0]?.turns.map((turn) => turn.text)).not.toContain(
      "wake",
    );
    const [first, wake, late] = await Promise.all(
      workingUntil.mock.calls.map(([done]) => done),
    );
    expect(first).toMatchObject({ ok: true });
    expect(wake).toMatchObject({
      ok: false,
      error: expect.stringContaining('synced model "gone"'),
    });
    expect(late).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.tags).toContainEqual(["e", wakeRoot, "", "reply"]);
    expect(JSON.stringify(published)).not.toContain(lateRoot);
  });

  it("refuses a synced model the harness doesn't offer, unless the message picks one", async () => {
    const config = await confirmed({ model: "gone" });
    const { fake, runtime, deliver, sync, published, workingUntil } = setup({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "a" }],
        },
      ],
    });
    sync(config);
    const signal = new AbortController().signal;
    const synced = { synced: { model: "gone" } };
    await deliver(message("1", "@Opal think"), config, signal, synced).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(fake.harnesses[0]?.sent("session/prompt")).toEqual([]);
    await expect(workingUntil.mock.calls[0]?.[0]).resolves.toMatchObject({
      error: expect.stringContaining('synced model "gone"'),
    });
    // A watch or timer is checked the same way.
    const wake = await runtime.runOnce({
      delivery: {
        agent: {
          key: self,
          pubkey: self,
          name: "Opal",
          owner: alice,
          relay: "wss://acp.example",
        },
        config,
        ...synced,
      } as unknown as Delivery,
      key: "timer",
      signal,
      prompt: async () => "wake",
    });
    expect(wake).toMatchObject({ ok: false });
    expect(wake.error).toContain('synced model "gone"');
    expect(fake.harnesses.flatMap((h) => h.turns)).toEqual([]);
    // The message's own pick runs.
    void deliver(message("2", "@Opal think"), config, signal, {
      ...synced,
      model: "a",
    }).run;
    await vi.waitFor(() =>
      expect(fake.harnesses.flatMap((h) => h.turns)).toHaveLength(1),
    );
  });

  it("runs a synced effort the harness offers in a group, already current", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            {
              group: "fast",
              name: "Fast",
              options: [{ value: "low", name: "low" }],
            },
            {
              group: "deep",
              name: "Deep",
              options: [{ value: "high", name: "high" }],
            },
          ],
        },
      ],
    });
    sync(config);
    const signal = new AbortController().signal;
    void deliver(message("1", "@Opal think"), config, signal, {
      synced: { effort: "high" },
    }).run;
    await vi.waitFor(() =>
      expect(fake.harnesses[0]?.sent("session/prompt")).toHaveLength(1),
    );
    expect(fake.harnesses[0]?.sent("session/set_config_option")).toEqual([]);
  });

  it("leaves nothing running when a delivery is cancelled while the harness starts", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({
      silent: ["initialize"],
    });
    sync(config);
    const cancel = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await deliver(message("1", "@Opal hello"), config, cancel.signal).run;
      // The approval digest resolves outside the fake clock.
      while (!fake.harnesses[0]?.sent("initialize").length)
        await new Promise((resolve) => setImmediate(resolve));
      cancel.abort(new Error("cancelled"));
      // The start is shared by the agent's messages, so the cancel gives up
      // only this one; the unanswered start is then bounded and killed.
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(fake.harnesses[0]?.killed).toBe(true));
    await flush(50);
    expect(fake.harnesses).toHaveLength(1);
    expect(fake.harnesses[0]?.sent("session/new")).toEqual([]);
    expect(fake.servers.every((server) => server.closed)).toBe(true);
  });

  it.each(["session/new", "session/set_config_option"])(
    "keeps the sign-in methods when %s needs a login",
    async (method) => {
      const config = await confirmed({ model: "b" });
      const { runtime, deliver, sync, published } = setup({
        authMethods: [{ id: "login", name: "Log in", description: "Run it" }],
        errors: { [method]: { code: -32000, message: "Sign in first" } },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "a",
            options: ["a", "b"].map((value) => ({ value, name: value })),
          },
        ],
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(published[0]?.content).toBe(
        `${FAILED} Run \`opencode auth login\`.`,
      );
      expect(runtime.signIn(self)).toEqual({
        methods: [{ name: "Log in", description: "Run it" }],
      });
    },
  );

  it("sets and clears the sign-in state from a standalone turn", async () => {
    const config = await confirmed();
    const harness: Parameters<typeof setup>[0] & {
      promptError?: { code: number; message: string };
    } = {
      authMethods: [{ id: "login", name: "Log in" }],
      promptError: { code: -32000, message: "Sign in first" },
    };
    const { runtime, sync } = setup(harness);
    sync(config);
    const once = (key: string) =>
      runtime.runOnce({
        delivery: {
          agent: {
            key: self,
            pubkey: self,
            name: "Opal",
            owner: alice,
            relay: "wss://acp.example",
          },
          config,
        } as unknown as Delivery,
        key,
        signal: new AbortController().signal,
        prompt: async () => "wake",
      });
    expect(await once("timer")).toMatchObject({ ok: false });
    expect(runtime.signIn(self)).toEqual({ methods: [{ name: "Log in" }] });
    delete harness.promptError;
    expect(await once("timer 2")).toMatchObject({ ok: true });
    expect(runtime.signIn(self)).toBeUndefined();
  });

  it("keeps the current launch's sign-in state when an older launch's turn succeeds", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, runtime } = setup({
      hold: true,
      authMethods: [{ id: "login", name: "Log in" }],
    });
    sync(config);
    await deliver(message("1", "@Opal one"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const next = await confirmed({ args: ["acp", "-v"] });
    sync(next);
    await deliver(message("2", "@Opal two"), next).run;
    await vi.waitFor(() => expect(fake.harnesses[1]?.turns).toHaveLength(1));
    fake.harnesses[1]?.turns[0]?.fail(-32000, "Sign in first");
    await vi.waitFor(() =>
      expect(runtime.signIn(self)).toEqual({ methods: [{ name: "Log in" }] }),
    );
    fake.harnesses[0]?.turns[0]?.finish();
    await flush(50);
    expect(runtime.signIn(self)).toEqual({ methods: [{ name: "Log in" }] });
  });

  it.each(["stopped", "undelivered"])(
    "keeps the sign-in state through a %s turn on the same launch",
    async (outcome) => {
      const config = await confirmed();
      const { fake, deliver, sync, runtime, workingUntil } = setup({
        hold: true,
        authMethods: [{ id: "login", name: "Log in" }],
      });
      sync(config);
      await deliver(message("1", "@Opal one"), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      fake.harnesses[0]?.turns[0]?.fail(-32000, "Sign in first");
      await vi.waitFor(() =>
        expect(runtime.signIn(self)).toEqual({ methods: [{ name: "Log in" }] }),
      );
      const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
      await deliver(message("2", "@Opal two"), config, undefined, {
        interruptible,
        // Current when it starts, superseded before it is handed over.
        ...(outcome === "undelivered"
          ? {
              current: vi
                .fn(() => true)
                .mockReturnValue(false)
                .mockReturnValueOnce(true),
            }
          : {}),
      }).run;
      if (outcome === "stopped") {
        await vi.waitFor(() =>
          expect(fake.harnesses[0]?.turns).toHaveLength(2),
        );
        await interruptible.mock.calls[0]?.[0]();
        fake.harnesses[0]?.turns[1]?.finish("cancelled");
      }
      // Subscribed before the turn's settle step runs; it ends by notifying.
      const notified = new Promise<void>((resolve) => {
        const stop = runtime.subscribe(() => {
          stop();
          resolve();
        });
      });
      expect(await workingUntil.mock.calls[1]?.[0]).toMatchObject({
        ok: true,
        [outcome]: true,
      });
      await notified;
      expect(runtime.signIn(self)).toEqual({ methods: [{ name: "Log in" }] });
    },
  );

  it("sets the sign-in state when a standalone turn's session needs a login", async () => {
    const config = await confirmed();
    const { runtime, sync } = setup({
      authMethods: [{ id: "login", name: "Log in" }],
      errors: { "session/new": { code: -32000, message: "Sign in first" } },
    });
    sync(config);
    const done = await runtime.runOnce({
      delivery: {
        agent: {
          key: self,
          pubkey: self,
          name: "Opal",
          owner: alice,
          relay: "wss://acp.example",
        },
        config,
      } as unknown as Delivery,
      key: "timer",
      signal: new AbortController().signal,
      prompt: async () => "wake",
    });
    expect(done).toMatchObject({ ok: false });
    expect(runtime.signIn(self)).toEqual({ methods: [{ name: "Log in" }] });
  });

  it("adds the preset's sign-in hint only when the first turn needs a login", async () => {
    for (const code of [-32000, -32603]) {
      const config = await confirmed();
      const { deliver, sync, published } = setup({
        promptError: { code, message: "No luck" },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(published).toHaveLength(1));
      const [report] = published;
      expect(report?.content).toBe(
        code === -32000 ? `${FAILED} Run \`opencode auth login\`.` : FAILED,
      );
    }
  });

  it("keeps a failed turn's error in its activity, out of the channel", async () => {
    const error = "Request failed: https://p.test/v1?key=SENTINEL";
    for (const code of [-32000, -32603]) {
      const config = await confirmed();
      const { runtime, deliver, sync, published, workingUntil } = setup({
        promptError: { code, message: error },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await reported(runtime, workingUntil);
      // The host records what `done` settles with in the turn's activity.
      expect(await workingUntil.mock.calls[0]?.[0]).toMatchObject({
        ok: false,
        error: expect.stringContaining("SENTINEL"),
      });
      expect(published).toHaveLength(1);
      expect(published[0]?.content).not.toContain("SENTINEL");
    }
  });

  it("hands the host a stopper that cancels the mention's running turn", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({ hold: true });
    sync(config);
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Opal hi"), config, undefined, {
      interruptible,
    }).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(interruptible).toHaveBeenCalledTimes(1);
    const harness = fake.harnesses[0];
    expect(harness?.sent("session/cancel")).toEqual([]);
    await interruptible.mock.calls[0]?.[0]();
    await vi.waitFor(() =>
      expect(harness?.sent("session/cancel")).toHaveLength(1),
    );
  });

  it("gives no sign-in hint when a refusal follows the sign-in error", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, published } = setup({ hold: true });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    // Queued behind the running prompt, so one turn answers both.
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await flush(50);
    const harness = fake.harnesses[0];
    harness?.turns[0]?.fail(-32000, "Authentication required");
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    harness?.turns[1]?.finish("refusal");
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("gives no sign-in hint to a refusal after a sign-in error while the session opened", async () => {
    const config = await confirmed();
    let open!: () => void;
    const opening = new Promise<void>((resolve) => (open = resolve));
    const { fake, deliver, sync, published } = setup({ hold: true, opening });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.opened).toHaveLength(1));
    // Both arrive before the session has seen a message, so both are first.
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    open();
    const harness = fake.harnesses[0];
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(1));
    harness?.turns[0]?.fail(-32000, "Authentication required");
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    harness?.turns[1]?.finish("refusal");
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("gives no sign-in hint for a later turn that needs a login", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, published } = setup({
      promptError: {
        code: -32000,
        message: "Authentication required",
        from: 1,
      },
    });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await flush(50);
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(fake.harnesses).toHaveLength(1);
    expect(published[0]?.content).toBe(FAILED);
  });
});
