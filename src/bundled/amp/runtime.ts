// Turns Agents deliveries into Amp turns. Each conversation an agent is in is
// one Amp thread, saved on this device; each turn runs one `amp` process in
// it, one at a time per conversation. A watch or timer wake runs as a one-off
// thread in its Interest's lane. The run returns once the turn is queued, so
// one agent works in several conversations at once.
import type { Context } from "../../buzz-mcp/client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { respond } from "../../buzz-mcp/rpc";
import { appClient } from "../../buzz-mcp/app-client";
import {
  type AddedTool,
  sessionHint,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  fromOwner,
  type Agent,
  type AgentHandle,
  type Agents,
  type Delivery,
  type StandaloneTurn,
  type TurnResult,
} from "../../features/agents/service";
import { ownerReads } from "../../features/agents/reads";
import { soloChat } from "../../features/agents/solo-chat";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  type PluginTrigger,
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import {
  CONTEXT_LIMIT,
  type Scope,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { sessionTitle, standalonePrompt } from "../goose/runtime";
import { ownerCanvas, readProject } from "../../features/agent-harness/project";
import { type AmpHost, runTurn, type ToolServer } from "./amp";

export type Config = Readonly<{
  /** An Amp agent mode; empty uses Amp's default. */
  mode: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own Amp thread, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  mode: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
});
export const config = (value: unknown): Config => ({
  ...DEFAULT_CONFIG,
  ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
});

const NAMES_TIMEOUT_MS = 2_000;
const CHAT = [9, 40002];
/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;
const STORE = "buzz.amp.conversations.v1";

/** One conversation's Amp thread: when it last ran, the newest message it was
 * shown, and a hash of the system prompt it was last given. */
export type SavedConversation = Readonly<{
  thread: string;
  at: number;
  seen: number;
  prompt: string;
}>;

/** FNV-1a, so a saved conversation holds no copy of its prompt. */
function hash(text: string) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  return (value >>> 0).toString(36);
}

type Entry = {
  config: Config;
  /** The team sections of the latest run. */
  team: string;
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
};
type Running = { controller: AbortController };

const section = (tag: string, body: string) =>
  `<${tag}>\n${body.trim()}\n</${tag}>`;

export class AmpRuntime {
  private readonly agents = new Map<string, Entry>();
  /** Turns running now, by agent and conversation. */
  private readonly running = new Map<string, Running>();
  /** Each conversation's latest queued turn, which the next waits for. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: Storage = globalThis.localStorage,
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
  ) {}

  private get amp(): AmpHost {
    const { host } = this;
    if (!host.spawn || !host.serveMcp)
      throw new Error("Amp agents run only in the desktop app");
    return {
      spawn: host.spawn.bind(host),
      serve: host.serveMcp.bind(host),
    };
  }

  /** Brings the runtime in line with this type's agents; removed agents' turns
   * stop. Settings are read as each turn starts. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    for (const pubkey of this.agents.keys())
      if (!current.has(pubkey)) {
        this.agents.delete(pubkey);
        for (const [key, turn] of this.running)
          if (key.startsWith(`${pubkey}/`)) turn.controller.abort();
      }
    for (const agent of agents) {
      const entry = this.entry(agent.pubkey, config(agent.config));
      entry.config = config(agent.config);
      entry.name = agent.name;
    }
    this.notify();
  }

  /** Conversations with a turn running now. */
  sessions(pubkey: string) {
    return [...this.running.keys()]
      .filter((key) => key.startsWith(`${pubkey}/`))
      .map((key) => ({ key: key.slice(pubkey.length + 1), busy: true }));
  }
  /** The agent's saved conversations, most recently used first. */
  conversations(pubkey: string) {
    return this.saved(pubkey).map(([key, { at }]) => ({ key, at }));
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }

  dispose() {
    for (const turn of this.running.values()) turn.controller.abort();
    this.running.clear();
    this.agents.clear();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    team,
    model,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    interruptible,
  }: Delivery) {
    // Watches and timers come as standalone turns (`runOnce`).
    if (trigger.type !== "mention" && trigger.type !== "plugin")
      return ignored?.();
    // A plugin's wake is the owner's installed code, not a message to check.
    const wake = trigger.type === "plugin" ? trigger : undefined;
    // Amp runs commands as you; mentions need owner or delegated authority.
    if (trigger.type === "mention") {
      const snapshot = this.relay(agent.pubkey)?.snapshot();
      if (
        !(await fromOwner(trigger.event, agent.owner, {
          agent: agent.pubkey,
          authority:
            snapshot?.status === "ready"
              ? snapshot.session.workflowAuthority
              : undefined,
          profiles:
            snapshot?.status === "ready"
              ? snapshot.session.profiles
              : undefined,
        }))
      ) {
        ignored?.();
        return;
      }
      signal.throwIfAborted();
    }
    const entry = this.entry(agent.pubkey, config(raw));
    entry.handle = agent;
    entry.team = team ?? "";
    const event =
      trigger.type === "plugin" ? wakeAnchor(trigger) : trigger.event;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    const topLevel = await soloChat(
      () => this.relay(agent.pubkey),
      agent.owner,
      channel,
      signal,
    );
    if (wake && !wakeLands(wake, topLevel)) return ignored?.();
    signal.throwIfAborted();
    const key = await this.key(entry, agent.pubkey, event, channel, topLevel);
    const conversation = `${agent.pubkey}/${key}`;
    const controller = new AbortController();
    const done = (this.queues.get(conversation) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (
          controller.signal.aborted ||
          this.agents.get(agent.pubkey) !== entry
        )
          return;
        this.running.set(conversation, { controller });
        this.notify();
        acknowledged?.();
        try {
          await this.converse(entry, agent, {
            key,
            event,
            channel,
            topLevel,
            signal: controller.signal,
            ...(model ? { mode: model } : {}),
            ...(wake ? { wake } : {}),
            ...(step ? { step } : {}),
          });
        } finally {
          if (this.running.get(conversation)?.controller === controller)
            this.running.delete(conversation);
          this.notify();
        }
      });
    this.queues.set(conversation, done);
    void done
      .finally(() => {
        if (this.queues.get(conversation) === done)
          this.queues.delete(conversation);
      })
      .catch((error) => console.warn("Amp turn failed", error));
    workingUntil(done);
    interruptible?.(async () => controller.abort());
  }

  /** One turn in a conversation's Amp thread, started anew when it cannot be
   * continued. */
  private async converse(
    entry: Entry,
    agent: AgentHandle,
    turn: Readonly<{
      key: string;
      event: EventData;
      channel: string;
      topLevel: boolean;
      signal: AbortSignal;
      mode?: string;
      wake?: PluginTrigger;
      step?: (tool: string, target?: string) => void;
    }>,
  ) {
    const { key, event, channel, topLevel } = turn;
    const pubkey = agent.pubkey;
    const root = threadReference(event)?.rootId ?? event.id;
    const noteRoot = key === channel ? undefined : root;
    const notes = agent.notes?.(channel, noteRoot) ?? [];
    const system = await this.systemPrompt(entry, pubkey);
    const fingerprint = hash(system);
    const context: Context = topLevel
      ? { channel, topLevel }
      : key === channel
        ? { channel }
        : { channel, root };
    const attempt = async (saved: SavedConversation | undefined) => {
      const input = await this.turn(
        entry,
        pubkey,
        event,
        channel,
        topLevel,
        saved?.seen ?? 0,
      );
      const body = [
        turnPrompt({
          ...input,
          agent: pubkey,
          label: "@mention",
          ...(turn.wake ? { wake: turn.wake } : {}),
        }),
        ...notes,
        turnNote(agent),
      ]
        .filter(Boolean)
        .join("\n\n");
      const prompt = !saved
        ? `${section("buzz-system-prompt", system)}\n\n${body}`
        : saved.prompt !== fingerprint
          ? `${section("buzz-system-prompt-updated", `These replace your earlier Buzz instructions.\n\n${system}`)}\n\n${body}`
          : body;
      const where = input.channel.name
        ? `#${input.channel.name}`
        : input.channel.dm
          ? "DM"
          : channel.slice(0, 8);
      return runTurn(this.amp, {
        cwd: entry.config.workspace,
        prompt,
        ...(saved ? { thread: saved.thread } : {}),
        keep: true,
        title: sessionTitle(entry.name, where, key.split("/")[1]),
        ...(turn.mode || entry.config.mode
          ? { mode: turn.mode || entry.config.mode }
          : {}),
        tools: this.tools(pubkey, context),
        signal: turn.signal,
        ...(turn.step ? { step: turn.step } : {}),
      });
    };
    const saved = this.saved(pubkey).find(([saved]) => saved === key)?.[1];
    let outcome = await attempt(saved);
    if (!outcome.ok && outcome.unopened && saved && !turn.signal.aborted)
      outcome = await attempt(undefined);
    if (outcome.thread)
      this.save(pubkey, key, {
        thread: outcome.thread,
        at: Date.now(),
        seen: event.created_at,
        prompt: fingerprint,
      });
    if (outcome.stopped) return;
    if (!outcome.ok) {
      if (outcome.unopened) agent.restoreNotes?.(channel, notes, noteRoot);
      return this.post(
        agent,
        channel,
        event,
        `⚠️ I couldn't finish that: ${(outcome.error ?? "Amp failed").slice(0, 500)}`,
        topLevel,
        [["p", agent.owner]],
      );
    }
    // An answer Amp wrote without `send` is posted for it, so the thread is
    // not left waiting.
    if (outcome.text)
      return this.post(agent, channel, event, outcome.text, topLevel);
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * Amp thread that joins no conversation. */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent.pubkey, config(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    const text = await prompt();
    if (text === undefined) return { ok: true };
    const system = await this.systemPrompt(entry, agent.pubkey);
    const running = `${agent.pubkey}/${key}`;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    this.running.set(running, { controller });
    this.notify();
    try {
      const outcome = await runTurn(this.amp, {
        cwd: entry.config.workspace,
        prompt: `${section("buzz-system-prompt", system)}\n\n${standalonePrompt(agent.pubkey, text)}`,
        title: sessionTitle(entry.name, key),
        ...(entry.config.mode ? { mode: entry.config.mode } : {}),
        tools: this.tools(agent.pubkey, {}),
        signal: controller.signal,
      });
      return outcome.ok
        ? { ok: true }
        : { ok: false, error: outcome.error ?? "Amp failed" };
    } finally {
      signal.removeEventListener("abort", stop);
      if (this.running.get(running)?.controller === controller)
        this.running.delete(running);
      this.notify();
    }
  }

  /** The agent's Buzz tools for one turn, acting where `context` says. */
  private tools(pubkey: string, context: Context): ToolServer {
    return async (message) => {
      const handle = this.agents.get(pubkey)?.handle;
      const session = this.relay(pubkey)?.snapshot().session;
      const workspace = this.agents.get(pubkey)?.config.workspace;
      const client =
        handle &&
        appClient(handle, {
          relayAuthor: session?.relayAuthor,
          audienceAuthorityCommunity: session?.audienceAuthorityCommunity,
          signingAuthority: session?.workflowAuthority,
          read: async (path) => {
            if (!this.host.readFile)
              throw new Error("Amp agents run only in the desktop app");
            return this.host.readFile(path, {
              ...(workspace ? { cwd: workspace } : {}),
            });
          },
          memories: (slug) => this.memories(pubkey, slug),
          remembered: () => this.forget(pubkey),
        });
      const added = this.added();
      return respond(client, context, message, added, {
        instructions: sessionHint(added),
      });
    };
  }

  private async systemPrompt(entry: Entry, pubkey: string) {
    const { workspace, instructions, scope } = entry.config;
    const memory = await this.core(pubkey);
    return systemPrompt({
      scope,
      cwd: workspace,
      repositories: this.repositories(this.relay(pubkey)?.snapshot().scope),
      ...(entry.name ? { agent: { name: entry.name, pubkey } } : {}),
      instructions,
      team: entry.team,
      ...(memory === undefined ? {} : { memory }),
    });
  }

  /** Replies as the agent in the event's thread, or at a Solo chat's top
   * level. */
  private post(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    content: string,
    topLevel: boolean,
    tags: string[][] = [],
  ) {
    return agent
      .publish({
        kind: 9,
        content,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...tags,
        ],
      })
      .then(() => undefined)
      .catch((failure) => console.warn("Amp could not post", failure));
  }

  /** The conversation the event belongs to: a Solo chat, a DM and a
   * channel-scoped agent's channel are one, otherwise each thread is. */
  private async key(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const session = this.session(self);
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const rootId = threadReference(event)?.rootId ?? event.id;
    return topLevel || dm || entry.config.scope === "channel"
      ? channelId
      : `${channelId}/${rootId}`;
  }

  private session(self: string) {
    const snapshot = this.relay(self)?.snapshot();
    return snapshot?.status === "ready" ? snapshot.session : undefined;
  }

  /** What the event's turn prompt needs, with the conversation's messages
   * newer than `seen` that the thread has not been shown. */
  private async turn(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
    seen: number,
  ) {
    const session = this.session(self);
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    const key = await this.key(entry, self, event, channelId, topLevel);
    const scope: Scope = key === channelId ? "channel" : "thread";
    const owner = entry.handle?.owner;
    const reading = topLevel
      ? readProject(
          session && owner
            ? () =>
                ownerCanvas(
                  session.canvas,
                  owner,
                  channelId,
                  session.channelWrites.startingCanvas(channelId),
                )
            : undefined,
        )
      : Promise.resolve(undefined);
    let earlier: readonly EventData[] = [];
    if (session && (thread || dm || topLevel))
      try {
        const events = await session.read(
          thread && !topLevel
            ? [
                { ids: [rootId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          { signal: AbortSignal.timeout(NAMES_TIMEOUT_MS * 2) },
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("Amp could not read the conversation", error);
      }
    // A thread already has its own replies; a new one is shown them too.
    const unseen = earlier.filter(
      (item) => item.created_at > seen && (!seen || item.pubkey !== self),
    );
    const pubkeys = [
      ...new Set([
        event.pubkey,
        ...unseen.map((item) => item.pubkey),
        ...event.tags
          .filter((tag) => tag[0] === "p")
          .map((tag) => tag[1] ?? ""),
      ]),
    ].filter(Boolean);
    if (session)
      await Promise.race([
        session.profiles.ensure(pubkeys, "foreground").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS)),
      ]);
    const members = summary?.members ?? [];
    const project = (await reading)?.section;
    return {
      event,
      scope,
      topLevel,
      channel: {
        id: channelId,
        ...(summary?.name ? { name: summary.name } : {}),
        dm,
      },
      ...(thread ? { thread } : {}),
      context: unseen,
      total: earlier.length + 1,
      name: (pubkey: string) =>
        session?.names.resolve(pubkey, undefined, members) ??
        session?.profiles.snapshot().get(pubkey)?.name ??
        undefined,
      ...(project ? { project } : {}),
    };
  }

  private entry(pubkey: string, initial: Config): Entry {
    let entry = this.agents.get(pubkey);
    if (!entry) {
      entry = { config: initial, team: "" };
      this.agents.set(pubkey, entry);
    }
    return entry;
  }

  private readAll(): Record<string, Record<string, SavedConversation>> {
    try {
      const value = JSON.parse(this.storage.getItem(STORE) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
  /** Saved conversations, most recently used first. */
  private saved(pubkey: string): [string, SavedConversation][] {
    return Object.entries(this.readAll()[pubkey] ?? {})
      .filter(
        ([, saved]) =>
          typeof saved?.thread === "string" && typeof saved.at === "number",
      )
      .sort(([, a], [, b]) => b.at - a.at);
  }
  private save(pubkey: string, key: string, saved: SavedConversation) {
    const all = this.readAll();
    all[pubkey] = Object.fromEntries(
      [
        [key, saved] as [string, SavedConversation],
        ...this.saved(pubkey).filter(([other]) => other !== key),
      ].slice(0, SAVED_LIMIT),
    );
    try {
      this.storage.setItem(STORE, JSON.stringify(all));
    } catch (error) {
      console.warn("Amp conversations were not saved", error);
    }
  }

  /** The agent's memory, or only entry `slug`, as the owner's reads of its
   * community give it: it is encrypted to the owner, so no agent key is
   * needed. */
  private memories(pubkey: string, slug?: string) {
    const reads = ownerReads(this.relay(pubkey), pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  private forget(pubkey: string) {
    const reads = ownerReads(this.relay(pubkey), pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}
