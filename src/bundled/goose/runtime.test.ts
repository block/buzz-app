import { describe, expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import { callTool } from "../../buzz-mcp/tools";
import { createAgentMemories } from "../../features/agents/memory";
import { TOP_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import type { Agent, Delivery, Models } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { Choice } from "./goose";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import {
  settingsClock,
  settingsOf,
} from "../../features/agents/settings-testing";
import { fakeSpawn, flush } from "./goose-testing";
import { GooseSetup } from "./setup";
import {
  DEFAULT_CONFIG,
  GooseRuntime,
  sessionTitle,
  standalonePrompt,
} from "./runtime";

describe("sessionTitle", () => {
  it("names the agent, the channel and a thread's root", () => {
    expect(sessionTitle("Ada", "#general", "0123456789abcdef")).toBe(
      "Ada · #general · 01234567",
    );
    expect(sessionTitle(undefined, "DM")).toBe("Buzz agent · DM");
  });

  it("keeps the root when a long name is cut", () => {
    const title = sessionTitle("A".repeat(100), "#general", "0123456789");
    expect(title).toHaveLength(80);
    expect(title.endsWith(" · 01234567")).toBe(true);
  });
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
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
    ...extra,
  }) as RelayEvent;

/** What a test's delivery carries: the settings it was admitted with, given
 * as their parts, at the agent's epoch now unless it names another. */
type Carried = Partial<Delivery> & {
  config?: unknown;
  team?: string;
  synced?: Record<string, string>;
  epoch?: number;
};
/** The agent's row as the host shows it after a local Save at `epoch`. */
const asRow = (
  agent: { name: string },
  config: unknown,
  epoch: number,
  extra: Record<string, unknown> = {},
) =>
  ({
    ...agent,
    config,
    settings: settingsOf(config, { name: agent.name }),
    epoch,
    ...extra,
  }) as unknown as Agent;

/** A runtime for one agent of Alice's in `channel`, with fake goose. */
function setup(
  options: Readonly<{
    /** Channels that are the owner's own Solo chats; the owner is the viewer. */
    solo?: Set<string>;
    hold?: boolean;
    reply?: string;
    thread?: readonly EventData[];
    scope?: "thread" | "channel";
    /** The agent's `core` memory as the host keeps it. */
    core?: string | null;
    /** The channel's Canvas. */
    canvas?: string;
    repositories?: (scope: string | undefined) => string;
    /** The models the composer lists for a provider and model. */
    models?: (choice: Choice) => Promise<Models>;
  }> = {},
) {
  const fake = fakeSpawn({
    hold: options.hold ?? false,
    ...(options.reply ? { reply: options.reply } : {}),
  });
  const readFile = vi.fn<NonNullable<Host["readFile"]>>();
  const host = {
    spawn: fake.spawn,
    resolveDirectory: fake.resolveDirectory,
    readFile,
    serveMcp: fake.serve,
    request: vi.fn(),
  } as unknown as Host;
  const read = vi.fn(async () => options.thread ?? []);
  const memories = {
    snapshot: () => ({ status: "ready", listing: { entries: [] } }),
    subscribe: () => () => {},
    refresh: async () => {},
    dispose: () => {},
  };
  const session = {
    read,
    agentMemories: { open: vi.fn(() => memories) },
    channels: {
      list: () => ({
        channels: [
          {
            id: channel,
            name: "general",
            channelType: options.solo?.has(channel) ? "solo" : "stream",
            members: [],
          },
        ],
      }),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => new Map(),
    },
    channelWrites: { startingCanvas: () => undefined },
    canvas: {
      available: options.canvas !== undefined,
      read: vi.fn(async () =>
        options.canvas === undefined
          ? null
          : {
              pubkey: alice,
              kind: 40100,
              created_at: 1,
              tags: [],
              content: options.canvas,
            },
      ),
    },
  };
  const relay = {
    snapshot: () => ({
      status: "ready",
      session,
      viewer: alice,
      scope: `https://goose.example:${alice}`,
    }),
  } as unknown as RelayData;
  const core = vi.fn(async () => options.core);
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const runtime = new GooseRuntime(
    host,
    () => relay,
    core,
    storage,
    undefined,
    options.repositories,
    options.models,
  );
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    pubkey: self,
    name: "Gander",
    owner: alice,
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return {
        ...message(String(published.length), template.content),
        ...template,
      };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
  };
  const clock = settingsClock();
  const attemptOf = ({ config, team, synced, epoch, ...rest }: Carried) =>
    rest.attempt ??
    clock.attempt(
      config ?? { ...DEFAULT_CONFIG, scope: options.scope ?? "thread" },
      { team: team ?? "", synced: synced ?? {}, name: agent.name },
      epoch,
    );
  const deliver = (event: RelayEvent, extra: Carried = {}) => {
    const { config: _, team: __, synced: ___, epoch: ____, ...rest } = extra;
    return runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      signal: new AbortController().signal,
      workingUntil: () => undefined,
      ...rest,
      attempt: attemptOf(extra),
    } as unknown as Delivery);
  };
  const goose = () => fake.geese.find((process) => process.turns.length);
  const runOnce = (key: string, prompt: string) =>
    runtime.runOnce({
      delivery: {
        agent,
        channelId: channel,
        attempt: attemptOf({ config: DEFAULT_CONFIG }),
      },
      key,
      signal: new AbortController().signal,
      prompt: async () => prompt,
    } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
  return {
    agent,
    clock,
    host,
    core,
    deliver,
    runOnce,
    fake,
    goose,
    published,
    read,
    readFile,
    runtime,
    memoryOpen: session.agentMemories.open,
  };
}

describe("GooseRuntime", () => {
  it("reads a file a tool names from the agent's workspace through the host", async () => {
    const { deliver, goose, published, readFile } = setup({ hold: true });
    readFile.mockResolvedValueOnce(new TextEncoder().encode("From a file"));
    await deliver(message("1", "@Gander post my notes"));
    await flush(100);
    const process = goose();
    const reply = await process?.mcp(
      process.turns[0]?.sessionId ?? "",
      "tools/call",
      { name: "send", arguments: { audience: "everyone", path: "notes.md" } },
    );
    expect(reply?.result).not.toMatchObject({ isError: true });
    expect(readFile).toHaveBeenCalledWith("notes.md", {
      cwd: DEFAULT_CONFIG.workspace,
    });
    expect(published.at(-1)?.content).toBe("From a file");
  });

  it("continues an owner's Solo chat as one channel session posted at the top level", async () => {
    const earlier = message("1", "Earlier in the chat", {
      tags: [["h", channel]],
    });
    const first = message("2", "@Gander first");
    // A reply in an old thread of the chat is still the one conversation.
    const later = message("3", "@Gander more", {
      tags: [
        ["h", channel],
        ["e", earlier.id, "", "reply"],
        ["p", self],
      ],
    });
    const { agent, deliver, goose, published, read } = setup({
      solo: new Set([channel]),
      hold: true,
      thread: [earlier],
    });
    agent.query.mockImplementation(async () => [first]);
    await deliver(first);
    await flush(100);
    const process = goose();
    const turn = process?.turns[0];
    expect(turn?.text).toContain("Scope: channel");
    expect(turn?.text).toContain(`IMPORTANT: ${TOP_LEVEL_PROMPT}`);
    expect(turn?.text).toContain("Earlier in the chat");
    // A new session is shown the chat itself, not a thread.
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [9, 40002], "#h": [channel], limit: 13 }],
      expect.anything(),
    );
    const sessionId = turn?.sessionId ?? "";
    const reply = await process?.mcp(sessionId, "tools/call", {
      name: "send",
      arguments: { audience: "everyone", text: "x", reply: first.id },
    });
    expect(reply?.result).toEqual({
      content: [
        {
          type: "text",
          text: "This chat stays at the top level: send again without reply.",
        },
      ],
      isError: true,
    });
    await deliver(later);
    await flush(100);
    expect(process?.turns).toHaveLength(1);
    expect(turn?.steered).toHaveLength(1);
    process?.exit(1, "Error: Invalid API key\n");
    await flush(100);
    // The turn both mentions joined reports its failure once, at the chat's
    // top level.
    expect(published.map((event) => event.tags)).toEqual([
      [
        ["h", channel],
        ["p", alice],
      ],
    ]);
  });

  it("hands the host a stopper that cancels the mention's running turn", async () => {
    const { deliver, goose } = setup({ hold: true });
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Gander hi"), { interruptible });
    await flush(100);
    expect(interruptible).toHaveBeenCalledTimes(1);
    const process = goose();
    expect(process?.cancelled).toEqual([]);
    await interruptible.mock.calls[0]?.[0]();
    await flush(100);
    expect(process?.cancelled).toEqual([process?.turns[0]?.sessionId]);
  });

  it("tells a subscriber when a new conversation's first turn starts working", async () => {
    const { deliver, goose, runtime } = setup({ hold: true });
    // As a view does: each notification reads the snapshot again.
    runtime.subscribe(() => void runtime.sessions(self));
    expect(runtime.sessions(self)).toEqual([]);
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(goose()?.turns).toHaveLength(1);
    expect(runtime.sessions(self)).toMatchObject([{ busy: true }]);
    goose()?.turns[0]?.finish();
    await flush(100);
    expect(runtime.sessions(self)).toMatchObject([{ busy: false }]);
  });

  it("posts a channel session's burst once, in the latest message's thread", async () => {
    const reply = (id: string, root: EventData): RelayEvent =>
      message(id, "@Gander", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
          ["p", self],
        ],
      });
    const one = message("1", "First thread");
    const two = message("2", "Second thread");
    const { deliver, goose, published } = setup({
      scope: "channel",
      hold: true,
      reply: "Forgot to send",
    });
    await deliver(reply("3", one));
    await flush(100);
    await deliver(reply("4", two));
    await flush(100);
    const process = goose();
    expect(process?.turns).toHaveLength(1);
    expect(process?.turns[0]?.steered).toHaveLength(1);
    process?.turns[0]?.finish();
    await flush(100);
    expect(published).toEqual([
      {
        kind: 9,
        content: "Forgot to send",
        tags: [
          ["h", channel],
          ["e", two.id, "", "reply"],
        ],
      },
    ]);
  });

  it("starts each new session from the config its delivery carries, never the local row", async () => {
    const { agent, deliver, fake, runtime } = setup();
    const row = (instructions: string) =>
      runtime.sync([asRow(agent, { ...DEFAULT_CONFIG, instructions }, 0)]);
    const carrying = (instructions: string) => ({
      config: { ...DEFAULT_CONFIG, scope: "thread", instructions },
    });
    row("LOCAL");
    await deliver(message("1", "@Gander hi"), carrying("SYNCED A"));
    await flush(100);
    // An unchanged local row neither replaces the delivered config nor
    // closes the session started from it.
    row("LOCAL");
    await deliver(message("2", "@Gander again"), carrying("SYNCED B"));
    await flush(100);
    const prompts = fake.geese.flatMap((goose) => [...goose.prompts]);
    expect(prompts.map(([id]) => id)).toEqual(["session-1", "session-2"]);
    const [first, second] = prompts.map(([, text]) => text);
    expect(first).toContain("SYNCED A");
    expect(second).toContain("SYNCED B");
    expect(prompts.join()).not.toContain("LOCAL");
    expect(fake.geese.flatMap((goose) => goose.closed)).toEqual([]);
  });

  it("keeps each open conversation on the config it opened with until Restart to apply", async () => {
    const { agent, clock, deliver, fake, runtime } = setup();
    const pkg = (config: unknown) => settingsOf(config, { name: agent.name });
    const synced = (instructions: string, provider = "") => ({
      ...DEFAULT_CONFIG,
      scope: "thread",
      instructions,
      provider,
    });
    const reply = (id: string, text: string, root: string) =>
      message(id, text, {
        tags: [
          ["h", channel],
          ["e", root, "", "reply"],
          ["p", self],
        ],
      });
    const first = message("1", "@Gander hi");
    await deliver(first, { config: synced("SYNCED A") });
    await flush(100);
    // An edit from another device reaches the open conversation's next
    // message, which still runs on the config the session opened with.
    const b = synced("SYNCED B", "openai");
    await deliver(reply("2", "@Gander again", first.id), {
      config: b,
    });
    await flush(100);
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual([]);
    expect(goose?.configured).toEqual([]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
    expect(runtime.outdated(self, pkg(b))).toBe(true);
    // A new conversation opens on the current copy.
    await deliver(message("3", "@Gander new"), {
      config: b,
    });
    await flush(100);
    const prompts = () => fake.geese.flatMap((goose) => [...goose.prompts]);
    expect(prompts().map(([id]) => id)).toEqual(["session-1", "session-2"]);
    expect(prompts()[1]?.[1]).toContain("SYNCED B");
    // Restart to apply closes the idle sessions, and the conversation's next
    // message opens one on the current copy.
    runtime.restart(self, clock.applied(b, {}, clock.advance()));
    await flush(100);
    expect(goose?.closed).toContain("session-1");
    expect(runtime.outdated(self, pkg(b))).toBe(false);
    await deliver(reply("4", "@Gander after", first.id), {
      config: b,
    });
    await flush(100);
    expect(prompts().at(-1)?.[1]).toContain("SYNCED B");
    expect(prompts()).toHaveLength(3);
  });

  it("starts a session from the host's core memory, reading none from the relay", async () => {
    const { core, deliver, goose, memoryOpen } = setup({
      core: "I am Gander.",
    });
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    expect([...(goose()?.prompts.values() ?? [])].join()).toContain(
      "<core-memory>\nI am Gander.\n</core-memory>",
    );
    expect(core).toHaveBeenCalledWith(self);
    expect(memoryOpen).not.toHaveBeenCalled();
  });

  it("posts goose's own text in the thread, or at a Solo chat's top level", async () => {
    const plain = setup({ reply: "Plain answer" });
    await plain.deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(plain.published.map((event) => event.tags)).toEqual([
      [
        ["h", channel],
        ["e", "1".repeat(64), "", "reply"],
      ],
    ]);
    const solo = setup({ reply: "Plain answer", solo: new Set([channel]) });
    await solo.deliver(message("1", "@Gander hi"));
    await flush(100);
    expect(solo.published.map((event) => event.tags)).toEqual([
      [["h", channel]],
    ]);
  });

  it("names the agent in a timer's prompt, so its session is listed as the agent's", async () => {
    const { runOnce, goose } = setup();
    await expect(
      runOnce("timer/daily", "Post the daily summary."),
    ).resolves.toEqual({ ok: true });
    expect(goose()?.turns.map((turn) => turn.text)).toEqual([
      standalonePrompt(self, "Post the daily summary."),
    ]);
  });

  it("replaces a session on an older remote copy at a local provider save, so it needs no Restart", async () => {
    const { agent, clock, deliver, runtime } = setup();
    const pkg = (config: unknown) => settingsOf(config, { name: agent.name });
    const synced = (instructions: string, provider = "") => ({
      ...DEFAULT_CONFIG,
      scope: "thread" as const,
      instructions,
      provider,
    });
    const saved = (config: typeof DEFAULT_CONFIG) =>
      runtime.sync([asRow(agent, config, clock.advance())]);
    saved(synced("SYNCED A"));
    const first = message("1", "@Gander hi");
    await deliver(first, { config: synced("SYNCED A") });
    await flush(100);
    // A remote edit reaches the open conversation, which stays on A.
    const b = synced("SYNCED B");
    await deliver(
      message("2", "@Gander again", {
        tags: [
          ["h", channel],
          ["e", first.id, "", "reply"],
          ["p", self],
        ],
      }),
      { config: b },
    );
    await flush(100);
    expect(runtime.outdated(self, pkg(b))).toBe(true);
    // Saving only a provider over B moves the epoch past the session's A
    // pin, so its next turn reopens on the save instead of waiting for Restart.
    const c = synced("SYNCED B", "openai");
    saved(c);
    expect(runtime.outdated(self, pkg(c))).toBe(false);
  });

  it("switches a saved provider in the live session without restarting goose", async () => {
    const { agent, clock, deliver, fake, runtime } = setup();
    const saved = (config: typeof DEFAULT_CONFIG) =>
      runtime.sync([asRow(agent, config, clock.advance())]);
    saved(DEFAULT_CONFIG);
    const first = message("1", "@Gander which model?");
    await deliver(first);
    await flush(100);
    const next = { ...DEFAULT_CONFIG, provider: "openai" };
    saved(next);
    // The host delivers the config it resolved from the saved row.
    await deliver(
      message("2", "@Gander and now?", {
        tags: [
          ["h", channel],
          ["e", first.id, "", "reply"],
          ["p", self],
        ],
      }),
      { config: { ...next, scope: "thread" } },
    );
    await flush(100);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.env).toMatchObject({ GOOSE_PROVIDER: null });
    expect(goose?.closed).toEqual([]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
    expect(goose?.configured).toEqual(["session-1 provider=openai"]);
  });

  it.each(["", "openai"])(
    "refreshes inherited defaults without replacing explicit provider %s",
    async (provider) => {
      const { agent, deliver, fake, runtime } = setup();
      const config = { ...DEFAULT_CONFIG, provider };
      runtime.sync([asRow(agent, config, 0)]);
      const first = message("1", "@Gander first");
      await deliver(first, { config });
      await flush(100);
      runtime.defaultsChanged();
      await deliver(
        message("2", "@Gander next", {
          tags: [
            ["h", channel],
            ["e", first.id, "", "reply"],
            ["p", self],
          ],
        }),
        { config },
      );
      await flush(100);
      expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
        "session-1",
        provider ? "session-1" : "session-2",
      ]);
    },
  );

  it("runs a mention on the agent's thinking level", async () => {
    const { deliver, fake } = setup();
    await deliver(message("1", "@Gander think"), {
      config: { ...DEFAULT_CONFIG, effort: "max" },
    });
    await flush(100);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 thinking_effort=max",
    ]);
  });

  it("runs a mention on the model its owner picked", async () => {
    const { deliver, fake } = setup();
    await deliver(message("1", "@Gander hi"), {
      config: { ...DEFAULT_CONFIG, provider: "openai" },
      model: "o3",
    });
    await flush(100);
    expect(fake.geese[0]?.configured).toEqual(["session-1 model=o3"]);
  });

  describe("a model pick checked against goose's list", () => {
    const listed = async (): Promise<Models> => ({
      current: "gpt-4o",
      models: ["gpt-4o", "o3"].map((id) => ({ id, label: id, efforts: [] })),
    });
    const reply = (id: string, root: RelayEvent) =>
      message(id, `@Gander ${id}`, {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
          ["p", self],
        ],
      });

    it("refuses an unlisted model before goose switches or prompts, and the conversation goes on", async () => {
      const { deliver, fake, published } = setup({ models: listed });
      const root = message("1", "@Gander 1");
      await deliver(root);
      await flush(100);
      await deliver(reply("2", root), { model: "made-up-model" });
      await flush(100);
      const [goose] = fake.geese;
      expect(goose?.configured).toEqual([]);
      expect(goose?.turns).toHaveLength(1);
      expect(JSON.stringify(published)).toContain(
        'goose can\'t run the picked model \\"made-up-model\\"',
      );
      await deliver(reply("3", root));
      await flush(100);
      expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
        "session-1",
        "session-1",
      ]);
    });

    it("posts a refused pick's refusal in its own thread, and a plain message's answer in its", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const { deliver, goose, published } = setup({
        scope: "channel",
        hold: true,
        reply: "Plain answer",
        models: async () => {
          await held;
          return listed();
        },
      });
      const one = message("1", "First thread");
      const two = message("2", "Second thread");
      await deliver(reply("3", one), { model: "made-up-model" });
      await flush(100);
      // A plain message in another thread waits behind the pick's check.
      await deliver(reply("4", two));
      await flush(100);
      release();
      await flush(100);
      goose()?.turns[0]?.finish();
      await flush(100);
      expect(goose()?.turns).toHaveLength(1);
      const posts = published.map(({ content, tags }) => ({
        refusal: content.includes('picked model "made-up-model"'),
        content: content.includes("made-up-model") ? "" : content,
        root: tags.find((tag) => tag[0] === "e")?.[1],
      }));
      expect(posts).toEqual(
        expect.arrayContaining([
          { refusal: true, content: "", root: one.id },
          { refusal: false, content: "Plain answer", root: two.id },
        ]),
      );
      expect(posts).toHaveLength(2);
    });

    it("switches a listed model for its turn", async () => {
      const { deliver, fake } = setup({ models: listed });
      await deliver(message("1", "@Gander hi"), { model: "o3" });
      await flush(100);
      expect(fake.geese[0]?.configured).toEqual(["session-1 model=o3"]);
      expect(fake.geese[0]?.turns).toHaveLength(1);
    });

    it("checks a pick against the provider its conversation is pinned to", async () => {
      // Each provider lists only its own models.
      const lists: Record<string, string[]> = {
        anthropic: ["claude-only"],
        openai: ["gpt-only"],
      };
      const { deliver, fake, published } = setup({
        models: async ({ provider }) => ({
          current: "",
          models: (lists[provider] ?? []).map((id) => ({
            id,
            label: id,
            efforts: [],
          })),
        }),
      });
      const on = (provider: string) => ({
        ...DEFAULT_CONFIG,
        scope: "thread",
        provider,
      });
      const root = message("1", "@Gander 1");
      await deliver(root, { config: on("anthropic") });
      await flush(100);
      // A remote edit to openai leaves the open conversation on anthropic.
      await deliver(reply("2", root), {
        config: on("openai"),
        model: "gpt-only",
      });
      await flush(100);
      const [goose] = fake.geese;
      expect(goose?.configured).toEqual([]);
      expect(JSON.stringify(published)).toContain(
        'goose can\'t run the picked model \\"gpt-only\\"',
      );
      await deliver(reply("3", root), {
        config: on("openai"),
        model: "claude-only",
      });
      await flush(100);
      expect(goose?.configured).toEqual(["session-1 model=claude-only"]);
      expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
        "session-1",
        "session-1",
      ]);
    });

    it("refuses a pick through the real model list, which also lists the pick it is given", async () => {
      const picks = new GooseSetup(
        fakeSpawn({
          providers: [
            {
              providerId: "anthropic",
              providerName: "Anthropic",
              visibleInSetup: true,
              defaultModel: "claude-only",
              models: [{ id: "claude-only", name: "Claude only" }],
            },
          ],
        }),
      );
      const { deliver, fake, published } = setup({
        models: (choice) => picks.picks(choice),
      });
      const config = {
        ...DEFAULT_CONFIG,
        scope: "thread",
        provider: "anthropic",
      };
      const root = message("1", "@Gander 1");
      await deliver(root, { config });
      await flush(100);
      await deliver(reply("2", root), { config, model: "gpt-only" });
      await flush(100);
      const [goose] = fake.geese;
      expect(goose?.configured).toEqual([]);
      expect(goose?.turns).toHaveLength(1);
      expect(JSON.stringify(published)).toContain(
        'goose can\'t run the picked model \\"gpt-only\\"',
      );
    });

    it("sends nothing for a message given up on while the list is read, and the conversation goes on", async () => {
      let answer!: (models: Models) => void;
      const lookup = new Promise<Models>((resolve) => (answer = resolve));
      const { deliver, fake } = setup({ models: () => lookup });
      const root = message("1", "@Gander 1");
      await deliver(root);
      await flush(100);
      const controller = new AbortController();
      let given = false;
      void deliver(reply("2", root), {
        model: "o3",
        signal: controller.signal,
      }).then(() => (given = true));
      await flush(30);
      controller.abort();
      await flush(30);
      // Released before the list comes back.
      expect(given).toBe(true);
      answer(await listed());
      await flush(100);
      const [goose] = fake.geese;
      expect(goose?.configured).toEqual([]);
      expect(goose?.turns).toHaveLength(1);
      await deliver(reply("3", root));
      await flush(100);
      expect(goose?.closed).toEqual([]);
      expect(goose?.turns.map((turn) => turn.text)).toHaveLength(2);
      expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
        "session-1",
        "session-1",
      ]);
    });

    it("never steers a follow-up given up on while it waited to join the turn", async () => {
      let answer!: (models: Models) => void;
      const lookup = new Promise<Models>((resolve) => (answer = resolve));
      const { deliver, fake } = setup({ models: () => lookup, hold: true });
      const root = message("1", "@Gander 1");
      await deliver(root);
      await flush(100);
      fake.geese[0]?.turns[0]?.finish();
      await flush(100);
      void deliver(reply("2", root), { model: "o3" });
      await flush(30);
      // Waits to steer into the "2" turn, which has no run yet.
      const controller = new AbortController();
      void deliver(reply("3", root), { signal: controller.signal });
      await flush(30);
      controller.abort();
      await flush(30);
      answer(await listed());
      await flush(100);
      const [goose] = fake.geese;
      expect(goose?.configured).toEqual(["session-1 model=o3"]);
      expect(goose?.turns).toHaveLength(2);
      expect(goose?.turns[1]?.text).toContain("@Gander 2");
      expect(goose?.turns[1]?.steered).toEqual([]);
      goose?.turns[1]?.finish();
      await flush(100);
      expect(goose?.turns).toHaveLength(2);
    });

    it("still runs a message waiting on the same list read as one given up on", async () => {
      let answer!: (models: Models) => void;
      const lookup = new Promise<Models>((resolve) => (answer = resolve));
      const { deliver, fake } = setup({ models: () => lookup });
      const root = message("1", "@Gander 1");
      await deliver(root);
      await flush(100);
      const controller = new AbortController();
      void deliver(reply("2", root), {
        model: "o3",
        signal: controller.signal,
      });
      await flush(30);
      void deliver(reply("3", root), { model: "o3" });
      await flush(30);
      controller.abort();
      await flush(30);
      answer(await listed());
      await flush(100);
      const [goose] = fake.geese;
      expect(goose?.configured).toEqual(["session-1 model=o3"]);
      expect(goose?.turns).toHaveLength(2);
      expect(goose?.turns[1]?.text).toContain("@Gander 3");
      expect(goose?.turns.some((turn) => turn.text.includes("@Gander 2"))).toBe(
        false,
      );
    });

    it("sends nothing once its agent is stopped while the list is read", async () => {
      let answer!: (models: Models) => void;
      const { agent, deliver, fake, runtime } = setup({
        models: () => new Promise((resolve) => (answer = resolve)),
      });
      // Another agent keeps goose running.
      const other = { ...agent, pubkey: "d".repeat(64), name: "Drake" };
      runtime.sync(
        [agent, other].map((item) => asRow(item, DEFAULT_CONFIG, 0)),
      );
      const root = message("1", "@Gander 1");
      await deliver(root);
      await flush(100);
      await deliver(reply("2", root), { model: "o3" });
      await flush(30);
      runtime.sync([asRow(other, DEFAULT_CONFIG, 0)]);
      await flush(30);
      answer(await listed());
      await flush(30);
      const [goose] = fake.geese;
      expect(goose?.killed).toBe(false);
      expect(goose?.closed).toEqual(["session-1"]);
      expect(goose?.configured).toEqual([]);
      expect(goose?.turns).toHaveLength(1);
    });

    it("lets the pick through when the list can't be read", async () => {
      const { deliver, fake } = setup({
        models: () => Promise.reject(new Error("no providers")),
      });
      await deliver(message("1", "@Gander hi"), { model: "o3" });
      await flush(100);
      expect(fake.geese[0]?.configured).toEqual(["session-1 model=o3"]);
      expect(fake.geese[0]?.turns).toHaveLength(1);
    });
  });

  it("keeps goose while another agent runs, and stops it with the last", async () => {
    const { agent, deliver, fake, runtime } = setup();
    const other = { ...agent, pubkey: "d".repeat(64), name: "Drake" };
    const running = (...agents: (typeof agent)[]) =>
      runtime.sync(agents.map((item) => asRow(item, DEFAULT_CONFIG, 0)));
    running(agent, other);
    await deliver(message("1", "@Gander hi"));
    await flush(100);
    running(other);
    await flush(30);
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.killed).toBe(false);
    running();
    await flush(30);
    expect(goose?.killed).toBe(true);
    expect(fake.geese).toHaveLength(1);
  });
});

describe("goose memory reads", () => {
  it("does not share a read that started before a write", async () => {
    const pending: ((body: string) => void)[] = [];
    const read = vi.fn(
      () =>
        new Promise<{ entries: { slug: string; body: string }[] }>((done) =>
          pending.push((body) => done({ entries: [{ slug: "core", body }] })),
        ),
    );
    const relay = {
      snapshot: () => ({
        status: "ready",
        session: { agentMemories: { read } },
      }),
    } as unknown as RelayData;
    const runtime = new GooseRuntime(
      {} as Host,
      () => relay,
      async () => null,
    ) as unknown as {
      memories(pubkey: string, slug?: string): Promise<unknown>;
      forgetMemories(pubkey: string): void;
    };
    const before = runtime.memories(self, "core");
    runtime.forgetMemories(self);
    const after = runtime.memories(self, "core");
    expect(read).toHaveBeenCalledTimes(2);
    pending[0]?.("old");
    await expect(before).resolves.toEqual({
      entries: [{ slug: "core", body: "old" }],
    });
    // The old read finishing must not drop the newer one.
    void runtime.memories(self, "core");
    expect(read).toHaveBeenCalledTimes(2);
    pending[1]?.("new");
    await expect(after).resolves.toEqual({
      entries: [{ slug: "core", body: "new" }],
    });
  });

  it("gives a tool the partial listing a slow native read answers", async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on real time; put it on the fake clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    try {
      const relay = {
        snapshot: () => ({
          status: "ready",
          session: { agentMemories: slowMemories(alice) },
        }),
      } as unknown as RelayData;
      const runtime = new GooseRuntime(
        {} as Host,
        () => relay,
        async () => null,
      ) as unknown as {
        memories(
          pubkey: string,
          slug?: string,
        ): ReturnType<BuzzClient["memories"]>;
      };
      const client = {
        memories: (slug?: string) => runtime.memories(self, slug),
      } as unknown as BuzzClient;
      const reply = callTool(client, {}, "mem_get", {});
      await vi.advanceTimersByTimeAsync(9_500);
      await expect(reply).resolves.toMatch(
        /^mem\/a .*\nThis list is incomplete: some memory could not be read\.$/,
      );
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

/** A native read that pages until its deadline and answers partial at 9.5
 * seconds, behind the session's real serialized memory reads. */
function slowMemories(viewer: string) {
  return createAgentMemories(
    () =>
      new Promise((done) =>
        setTimeout(
          () =>
            done({
              entries: [
                {
                  slug: "mem/a",
                  body: "a",
                  eventId: "e".repeat(64),
                  createdAt: 1,
                },
              ],
              partial: true,
            }),
          9_500,
        ),
      ),
    viewer,
    () => true,
  ).capability;
}

it("hands a Solo chat's Canvas to each turn, and a shared channel's to none", async () => {
  const solo = setup({ solo: new Set([channel]), canvas: "Use tokens." });
  await solo.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(solo.goose()?.turns[0]?.text).toContain(
    "<workspace-canvas>\nThis Solo chat's Canvas",
  );
  expect(solo.goose()?.turns[0]?.text).toContain("Use tokens.");
  // A cleared Canvas replaces it with an explicit "none".
  const cleared = setup({ solo: new Set([channel]), canvas: "" });
  await cleared.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(cleared.goose()?.turns[0]?.text).toContain(
    "Disregard any earlier workspace Canvas",
  );
  const shared = setup({ canvas: "Steer me" });
  await shared.deliver(message("1", "@Gander hi"));
  await flush(100);
  expect(shared.goose()?.turns[0]?.text).not.toContain("workspace-canvas");
});

it("compacts idle Goose immediately, keeps active controls through the turn, and resets without a message", async () => {
  const f = setup({ hold: true, reply: "Compaction complete" });
  const root = message("1", "hello");
  const place = { channelId: channel, root: root.id };
  const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
  try {
    await f.deliver(root);
    await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
    const goose = f.goose();
    if (!goose) throw new Error("Expected Goose process");
    expect(f.runtime.sessionState(agent, place)).toBe("active");
    await expect(f.runtime.session(agent, place, "new")).rejects.toThrow(
      "active turn",
    );
    goose.turns[0]?.finish();
    await vi.waitFor(() =>
      expect(f.runtime.sessionState(agent, place)).toBe("idle"),
    );
    const compacted = f.runtime.session(agent, place, "compact");
    await vi.waitFor(() => expect(goose.turns[1]?.text).toBe("/compact"));
    expect(goose.turns).toHaveLength(2);
    expect(f.runtime.sessionState(agent, place)).toBe("compacting");
    expect(
      f.runtime.sessionState(agent, { ...place, root: "another-thread" }),
    ).toBe("idle");
    goose.turns[1]?.finish();
    await compacted;
    await f.runtime.session(agent, place, "new");
    await f.deliver(
      message("2", "next", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
        ],
      }),
    );
    await vi.waitFor(() => expect(goose.turns).toHaveLength(3));
    expect(goose.turns[2]?.sessionId).not.toBe(goose.turns[0]?.sessionId);
  } finally {
    f.runtime.dispose();
  }
});

it("hands Goose its own community repositories while retaining the session workspace", async () => {
  const repositories = vi.fn(
    () => "<community-repositories>/code/goose</community-repositories>",
  );
  const { runtime, deliver, goose } = setup({ repositories });
  try {
    await deliver(message("1", "@Gander work"));
    await flush(100);
    expect(repositories).toHaveBeenCalledWith(`https://goose.example:${alice}`);
    expect([...(goose()?.prompts.values() ?? [])].join()).toContain(
      "/code/goose",
    );
    expect(goose()?.opened[0]).toMatchObject({ cwd: "/home/test/.buzz" });
  } finally {
    runtime.dispose();
  }
});

it.each(["completed", "stopped"])(
  "keeps an accepted Goose handoff past its deadline and respects its lifetime (%s)",
  async (outcome) => {
    const f = setup({ hold: true, reply: "Compaction complete" });
    const root = message("1", "hello");
    const place = { channelId: channel, root: root.id };
    const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
    const handover = new AbortController();
    const held: PromiseLike<unknown>[] = [];
    try {
      await f.deliver(root);
      await vi.waitFor(() => expect(f.goose()?.turns).toHaveLength(1));
      const goose = f.goose();
      if (!goose) throw new Error("Expected Goose process");
      goose.turns[0]?.finish();
      await vi.waitFor(() =>
        expect(f.runtime.sessionState(agent, place)).toBe("idle"),
      );
      const compacted = f.runtime
        .session(agent, place, "compact")
        .catch((error) => error);
      await vi.waitFor(() => expect(goose.turns[1]?.text).toBe("/compact"));
      let returned = false;
      const reply = message("2", "queued after compact", {
        tags: [
          ["h", channel],
          ["e", root.id, "", "reply"],
        ],
      });
      const admitted = f
        .deliver(reply, {
          signal: handover.signal,
          workingUntil: (done) => held.push(done),
        })
        .then(() => {
          returned = true;
        });
      try {
        await vi.waitFor(() => expect(returned).toBe(true));
        handover.abort(new Error("Handover expired"));
      } finally {
        if (outcome === "stopped") f.runtime.sync([]);
        else goose.turns[1]?.finish();
        const result = await compacted;
        if (outcome === "stopped") expect(result).toBeInstanceOf(Error);
        else expect(result).toBeUndefined();
        await admitted;
      }
      if (outcome === "stopped") {
        await Promise.all(held);
        expect(goose.turns).toHaveLength(2);
        expect(f.fake.geese).toHaveLength(1);
        return;
      }
      await vi.waitFor(() => expect(goose.turns).toHaveLength(3));
      expect(goose.turns[2]?.text).toContain("queued after compact");
      goose.turns[2]?.finish();
      await Promise.all(held);
    } finally {
      f.runtime.dispose();
    }
  },
);
it("captures Goose choice with the launch snapshot before memory is awaited", async () => {
  const f = setup();
  let release!: (value: string | null) => void;
  const gate = new Promise<string | null>((done) => {
    release = done;
  });
  f.core.mockImplementation(() => gate as never);
  const before = {
    ...DEFAULT_CONFIG,
    instructions: "BEFORE",
    provider: "openai",
    model: "before-model",
    effort: "high",
  };
  const after = {
    ...DEFAULT_CONFIG,
    instructions: "AFTER",
    provider: "anthropic",
    model: "after-model",
    effort: "low",
  };
  try {
    await f.deliver(message("1", "first"), { config: before });
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(1));
    await f.deliver(message("2", "second"), { config: after });
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(2));
    release(null);
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(2));
    const goose = f.fake.geese[0];
    expect.soft(goose?.prompts.get("session-1")).toContain("BEFORE");
    expect.soft(goose?.opened[0]?._meta).toMatchObject({ provider: "openai" });
    expect.soft(goose?.configured).toContain("session-1 model=before-model");
    expect.soft(goose?.configured).toContain("session-1 thinking_effort=high");
  } finally {
    release(null);
    f.runtime.dispose();
  }
});

it.each(["team", "name"] as const)(
  "Goose fences a %s change while memory is awaited",
  async (field) => {
    const f = setup();
    let release!: (value: string | null) => void;
    const gate = new Promise<string | null>((done) => {
      release = done;
    });
    f.core.mockImplementation(() => gate as never);
    const before = {
      ...DEFAULT_CONFIG,
      instructions: "BEFORE INSTRUCTIONS",
      model: "before-model",
    };
    const after = {
      ...DEFAULT_CONFIG,
      instructions: "AFTER INSTRUCTIONS",
      model: "after-model",
    };
    const row = asRow(f.agent, before, 0);
    f.runtime.sync([row]);
    try {
      await f.deliver(message("1", "first"), {
        config: before,
        team: "BEFORE TEAM",
      });
      await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(1));
      if (field === "name")
        f.runtime.sync([
          asRow({ name: "NEW NAME" }, after, 0, { pubkey: row.pubkey }),
        ]);
      await f.deliver(message("2", "second"), {
        config: after,
        team: field === "team" ? "AFTER TEAM" : "BEFORE TEAM",
      });
      await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(2));
      release(null);
      await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(2));
      const goose = f.fake.geese[0];
      if (!goose) throw new Error("Goose started");
      expect(goose.closed).toContain("session-1");
      for (const turn of goose.turns) {
        const prompt = goose.prompts.get(turn.sessionId);
        expect(prompt).toContain("AFTER INSTRUCTIONS");
        expect(prompt).not.toContain("BEFORE INSTRUCTIONS");
        expect(prompt).toContain(field === "team" ? "AFTER TEAM" : "NEW NAME");
      }
    } finally {
      release(null);
      f.runtime.dispose();
    }
  },
);

it("a Goose team change and revert during launch never admits mixed inputs", async () => {
  const f = setup();
  let firstMemory!: (value: string | null) => void;
  let otherMemory!: (value: string | null) => void;
  let openServer!: () => void;
  const firstGate = new Promise<string | null>((done) => {
    firstMemory = done;
  });
  const otherGate = new Promise<string | null>((done) => {
    otherMemory = done;
  });
  const serverGate = new Promise<void>((done) => {
    openServer = done;
  });
  f.core
    .mockImplementationOnce(() => firstGate as never)
    .mockImplementation(() => otherGate as never);
  const { serveMcp } = f.host;
  if (!serveMcp) throw new Error("The host serves MCP");
  const serve = serveMcp.bind(f.host);
  const serving = vi.fn(async (...args: Parameters<typeof serve>) => {
    await serverGate;
    return serve(...args);
  });
  f.host.serveMcp = serving;
  const before = {
    ...DEFAULT_CONFIG,
    instructions: "BEFORE INSTRUCTIONS",
    model: "before-model",
  };
  const after = {
    ...DEFAULT_CONFIG,
    instructions: "AFTER INSTRUCTIONS",
    model: "after-model",
  };
  try {
    await f.deliver(message("1", "first"), {
      config: before,
      team: "BEFORE TEAM",
    });
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(1));
    await f.deliver(message("2", "second"), {
      config: after,
      team: "AFTER TEAM",
    });
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(2));
    firstMemory(null);
    await vi.waitFor(() => expect(serving).toHaveBeenCalledTimes(1));
    await f.deliver(message("3", "third"), {
      config: before,
      team: "BEFORE TEAM",
    });
    await vi.waitFor(() => expect(f.core).toHaveBeenCalledTimes(3));
    openServer();
    await vi.waitFor(() => expect(f.fake.geese[0]?.turns).toHaveLength(1));
    const goose = f.fake.geese[0];
    if (!goose) throw new Error("Goose started");
    const prompt = goose.prompts.get(goose.turns[0]?.sessionId ?? "");
    expect.soft(prompt).toContain("BEFORE INSTRUCTIONS");
    expect.soft(prompt).toContain("BEFORE TEAM");
    expect.soft(prompt).not.toContain("AFTER TEAM");
  } finally {
    firstMemory(null);
    otherMemory(null);
    openServer();
    f.runtime.dispose();
  }
});

it.each([
  ["refuses", true],
  ["prompts", false],
])(
  "Goose %s a picked first prompt whose team changes by delivery during its model switch",
  async (_, change) => {
    const f = setup();
    let open!: () => void;
    const switched = new Promise<void>((resolve) => (open = resolve));
    // Hold goose's answer to each `session/set_config_option`.
    const spawn = f.fake.spawn;
    (f.host as { spawn: typeof spawn }).spawn = (async (
      ...args: Parameters<typeof spawn>
    ) => {
      const process = await spawn(...args);
      const goose = f.fake.geese.at(-1);
      const options = goose?.options as
        | { onStdout?: (chunk: string) => void }
        | undefined;
      const answer = options?.onStdout;
      if (goose && options)
        options.onStdout = (chunk: string) => {
          const { id, method } = JSON.parse(chunk) as {
            id?: number;
            method?: string;
          };
          const asked = goose.received.find((message) => message.id === id);
          if (!method && asked?.method === "session/set_config_option")
            void switched.then(() => answer?.(chunk));
          else answer?.(chunk);
        };
      return process;
    }) as typeof spawn;
    const first = f.deliver(message("1", "@Gander hi"), {
      config: DEFAULT_CONFIG,
      team: "TEAM A",
      model: "o3",
    });
    await vi.waitFor(() =>
      expect(f.fake.geese[0]?.configured ?? []).not.toEqual([]),
    );
    // A remote team change lands by delivery, at the same epoch, while the
    // first prompt waits on goose to switch its model.
    if (change)
      await f.runtime.runOnce({
        delivery: {
          agent: f.agent,
          channelId: channel,
          attempt: f.clock.attempt(
            DEFAULT_CONFIG,
            { team: "TEAM B", synced: {}, name: f.agent.name },
            undefined,
          ),
        },
        key: "timer",
        signal: new AbortController().signal,
        prompt: async () => undefined,
      } as unknown as Parameters<GooseRuntime["runOnce"]>[0]);
    open();
    await first;
    await flush(100);
    const turns = f.fake.geese.flatMap((goose) => goose.turns);
    if (change) {
      expect(JSON.stringify(f.published)).toContain("send again");
      expect(turns).toEqual([]);
    } else {
      expect(turns).toHaveLength(1);
      expect(JSON.stringify(f.published)).not.toContain("send again");
    }
    f.runtime.dispose();
  },
);

describe("Goose pins a prompted session's team text and name", () => {
  const thread = (id: string, root: RelayEvent) =>
    message(id, "@Gander again", {
      tags: [
        ["h", channel],
        ["e", root.id, "", "reply"],
        ["p", self],
      ],
    });
  const row = (
    agent: { name: string },
    epoch: number,
    team: string,
    name = agent.name,
  ) =>
    asRow({ name }, DEFAULT_CONFIG, epoch, {
      pubkey: self,
      settings: settingsOf(DEFAULT_CONFIG, { name, team }),
    });

  it("keeps the session on a remote team edit after its first prompt", async () => {
    const { agent, deliver, fake, runtime } = setup();
    runtime.sync([row(agent, 0, "TEAM A")]);
    const first = message("1", "@Gander hi");
    await deliver(first, { config: DEFAULT_CONFIG, team: "TEAM A" });
    await flush(100);
    await deliver(thread("2", first), {
      config: DEFAULT_CONFIG,
      team: "TEAM B",
    });
    await flush(100);
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual([]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
    expect(goose?.prompts.get("session-1")).toContain("TEAM A");
  });

  it("keeps the session when a blocked resolution falls back to local team text", async () => {
    const { agent, clock, deliver, fake, runtime } = setup();
    runtime.sync([row(agent, 0, "TEAM A")]);
    const first = message("1", "@Gander hi");
    await deliver(first, { config: DEFAULT_CONFIG, team: "TEAM A" });
    await flush(100);
    await deliver(thread("2", first), {
      attempt: clock.attempt(DEFAULT_CONFIG, {
        team: "LOCAL TEAM",
        name: agent.name,
        blocked: "The synced settings were deleted",
      }),
    });
    await flush(100);
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual([]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
  });

  it.each([
    ["team", "TEAM B", "Gander"],
    ["name", "TEAM A", "Gosling"],
  ] as const)(
    "reopens an idle prompted session on a local %s-only Save",
    async (_, team, name) => {
      const { agent, clock, deliver, fake, runtime } = setup();
      runtime.sync([row(agent, 0, "TEAM A")]);
      const first = message("1", "@Gander hi");
      await deliver(first, { config: DEFAULT_CONFIG, team: "TEAM A" });
      await flush(100);
      runtime.sync([row(agent, clock.advance(), team, name)]);
      await deliver(thread("2", first), { config: DEFAULT_CONFIG, team });
      await flush(100);
      const goose = fake.geese.at(-1);
      expect(fake.geese.flatMap((g) => g.closed)).toContain("session-1");
      const last = goose?.turns.at(-1)?.sessionId ?? "";
      expect(last).not.toBe("session-1");
      expect(goose?.prompts.get(last)).toContain(
        team === "TEAM B" ? "TEAM B" : "Gosling",
      );
    },
  );
});

describe("Goose keeps a pinned conversation's key across a remote scope change", () => {
  const inThread = (id: string, root: RelayEvent) =>
    message(id, `@Gander ${id}`, {
      tags: [
        ["h", channel],
        ["e", root.id, "", "reply"],
        ["p", self],
      ],
    });
  const scoped = (scope: "thread" | "channel") => ({
    ...DEFAULT_CONFIG,
    scope,
  });
  const sessions = (fake: { geese: { turns: { sessionId: string }[] }[] }) =>
    fake.geese.flatMap((goose) => goose.turns.map((turn) => turn.sessionId));

  it("continues a channel conversation after a remote change to thread scope, until a local Save", async () => {
    const { clock, deliver, fake } = setup();
    const root = message("1", "@Gander 1");
    await deliver(root, { config: scoped("channel") });
    await flush(100);
    await deliver(message("2", "@Gander 2"), { config: scoped("thread") });
    await flush(100);
    await deliver(inThread("3", root), { config: scoped("thread") });
    await flush(100);
    expect(sessions(fake)).toEqual(["session-1", "session-1", "session-1"]);
    clock.advance();
    await deliver(message("4", "@Gander 4"), { config: scoped("thread") });
    await flush(100);
    expect(sessions(fake).at(-1)).not.toBe("session-1");
  });

  it("continues a channel conversation when a remote delete falls back to thread-scoped local settings", async () => {
    const { agent, clock, deliver, fake } = setup();
    const root = message("1", "@Gander 1");
    await deliver(root, { config: scoped("channel") });
    await flush(100);
    await deliver(inThread("2", root), {
      attempt: clock.attempt(scoped("thread"), {
        name: agent.name,
        blocked: "The synced settings were deleted",
      }),
    });
    await flush(100);
    expect(sessions(fake)).toEqual(["session-1", "session-1"]);
  });

  it("rebuilds the prompt of a pinned conversation whose session closed while it was built, for the same conversation", async () => {
    const { deliver, fake, read, runtime } = setup();
    const root = message("1", "@Gander 1");
    await deliver(root, { config: scoped("channel") });
    await flush(100);
    let built!: () => void;
    read.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        built = resolve;
      });
      return [];
    });
    const sent = deliver(inThread("2", root), { config: scoped("thread") });
    await vi.waitFor(() => expect(built).toBeTypeOf("function"));
    // goose exits once the turn's key is chosen, before its prompt is sent.
    fake.geese[0]?.exit(1);
    await flush(100);
    built();
    await sent;
    await flush(100);
    const turns = fake.geese.flatMap((goose) => goose.turns);
    expect(turns).toHaveLength(2);
    expect(fake.geese[1]?.turns).toEqual([turns[1]]);
    expect(turns[1]?.text).toContain("Session scope: channel");
    expect(runtime.conversations(self).map(({ key }) => key)).toEqual([
      channel,
    ]);
  });

  it("refuses a turn whose prompt was still being built when a Save landed", async () => {
    const { clock, deliver, fake, read, published } = setup();
    const root = message("1", "@Gander 1");
    await deliver(root);
    await flush(100);
    let built!: () => void;
    read.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        built = resolve;
      });
      return [];
    });
    const sent = deliver(inThread("2", root));
    await vi.waitFor(() => expect(built).toBeTypeOf("function"));
    clock.advance();
    built();
    await sent;
    await flush(100);
    expect(fake.geese.flatMap((goose) => goose.turns)).toHaveLength(1);
    expect(JSON.stringify(published)).toContain("send again");
  });

  it("keeps a thread's conversation after a remote change to channel scope; the thread wins over the channel's", async () => {
    const { clock, deliver, fake } = setup();
    const root = message("1", "@Gander 1");
    await deliver(root, { config: scoped("thread") });
    await flush(100);
    await deliver(message("2", "@Gander 2"), { config: scoped("channel") });
    await flush(100);
    await deliver(inThread("3", root), { config: scoped("channel") });
    await flush(100);
    await deliver(message("4", "@Gander 4"), { config: scoped("channel") });
    await flush(100);
    expect(sessions(fake)).toEqual([
      "session-1",
      "session-2",
      "session-1",
      "session-2",
    ]);
    clock.advance();
    await deliver(inThread("5", root), { config: scoped("channel") });
    await flush(100);
    expect(sessions(fake).at(-1)).not.toBe("session-1");
  });
});
