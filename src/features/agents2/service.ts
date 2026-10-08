// Agents2: agents that are plugins from the start. A plugin registers an agent
// type (its summary line, peek view, settings tabs and `run`); each agent made
// from it has its own native-held key, an `agent-attention/v1` configuration the
// app owns and edits, and a config blob the type owns. The app delivers matching live events to
// `run` from the stream the owner already receives, so no plugin opens a socket
// or a REQ.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import { removeAgentFromChannels } from "../agents/relay-removal";
import { relayOrigin } from "../communities/destination";
import type { RelayEvent } from "../relay/events";
import type { LiveBatch } from "../relay/incoming";
import { relayPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  addressedTo,
  CHAT_KINDS,
  compileFilter,
  parseSlug,
  tagsAgent,
  watchMatches,
  type AttentionObject,
  type AttentionValue,
  timerSpent,
  timerState,
  type EventWatch,
  type Interest,
  type TimerState,
  type TimerWatch,
} from "./attention";
import {
  nativeAgents,
  type AgentEventTemplate,
  type AgentIdentity,
  type AgentsNative,
} from "./native";
import {
  readRecords,
  setAttention,
  writeRecords,
  type AgentRecord,
  type SkippedObject,
} from "./store";

/** One agent in the selected community. */
export type Agent<Config = unknown> = Readonly<{
  pubkey: string;
  name: string;
  /** The agent type's key, `pluginId/typeId`. */
  type: string;
  owner: string;
  relay: string;
  attention: Readonly<Record<string, AttentionObject>>;
  /** Stored attention objects that are invalid or over a limit, by slug. */
  skipped: Readonly<Record<string, SkippedObject>>;
  /** Run state of its timers, by slug; written only by the runtime. */
  timers: Readonly<Record<string, TimerState>>;
  /** Its name has not reached the relay yet; others see it unnamed or by an
   * older name until `publishProfile` succeeds. */
  profilePending: boolean;
  config: Config;
}>;
export type AgentChange<Config = unknown> = Readonly<{
  name?: string;
  config?: Config;
  /** Slug to new value; `null` deletes the object. */
  attention?: Readonly<Record<string, AttentionValue | null>>;
}>;
/** What a type's read-only peek receives. */
export type AgentPeekProps<Config = unknown> = { agent: Agent<Config> };
/** What each of a type's settings tabs receives. A type writes only its own
 * config; the app owns the name and attention. */
export type AgentViewProps<Config = unknown> = {
  agent: Agent<Config>;
  /** Replaces the type's whole config. Spread `agent.config` to change one
   * field, or tabs that each save a part will erase each other's fields. */
  save(config: Config): Promise<void>;
};
export type AgentTab<Config = unknown> = Readonly<{
  id: string;
  title: string;
  component: ComponentType<AgentViewProps<Config>>;
}>;
/** The agent as `run` holds it. Publishing works for as long as the agent exists. */
export type AgentHandle = Readonly<{
  pubkey: string;
  name: string;
  owner: string;
  publish(event: AgentEventTemplate): Promise<RelayEvent>;
}>;
export type Trigger =
  /** Directly addressed: a chat message that mentions the agent or replies to
   * something it wrote. */
  | Readonly<{ type: "mention"; event: RelayEvent }>
  /** One matching watch; an event that matches several runs once for each. */
  | Readonly<{
      type: "watch";
      event: RelayEvent;
      slug: string;
      watch: EventWatch;
      /** Absent when the watch names an Interest that does not exist. */
      interest?: Interest;
      /** Set when the watch has a classifier this app could not run. The spec
       * passes the event rather than lose a match to an unavailable model. */
      classifier?: "not run";
    }>
  | Readonly<{
      type: "timer";
      slug: string;
      timer: TimerWatch;
      /** Absent when the timer names an Interest that does not exist. */
      interest?: Interest;
    }>;
export type Delivery<Config = unknown> = Readonly<{
  trigger: Trigger;
  /** The live route's channel; absent when the wire scope was ambiguous. */
  channelId?: string;
  agent: AgentHandle;
  /** The agent's config when this run started. */
  config: Config;
  /** Aborts on the run's deadline, or when the agent is removed or its type is
   * replaced. Advisory: the handle keeps working, so finishing up is harmless. */
  signal: AbortSignal;
}>;
export type AgentType<Config = unknown> = {
  id: string;
  title: string;
  description?: string;
  /** A new agent's starting config and attention objects. */
  defaults(): Readonly<{
    config: Config;
    attention?: Readonly<Record<string, AttentionValue>>;
  }>;
  /** One short line under the agent's name, e.g. its model; defaults to the title. */
  summary?(agent: Agent<Config>): string;
  /** A read-only glance shown when the agent is selected in the grid. */
  Peek?: ComponentType<AgentPeekProps<Config>>;
  /** The type's settings tabs, in order. The host adds Attention after them. */
  tabs?: readonly AgentTab<Config>[];
  run?(delivery: Delivery<Config>): void | Promise<void>;
  /** Per-run deadline in milliseconds, up to 30 minutes; defaults to 60 seconds. */
  timeoutMs?: number;
};
export type RegisteredAgentType = Contribution<AgentType>;
export type AgentsSnapshot = Readonly<{
  status: "unavailable" | "loading" | "ready" | "error";
  agents: readonly Agent[];
  error?: string;
}>;
export type Agents2 = {
  register<Config>(type: AgentType<Config>): void;
  types(): readonly RegisteredAgentType[];
  snapshot(): AgentsSnapshot;
  subscribe(listener: () => void): () => void;
  /** The agent of this pubkey in the selected community, if it is an Agents2 agent. */
  find(pubkey: string): Agent | undefined;
  create(input: Readonly<{ type: string; name: string }>): Promise<Agent>;
  save(pubkey: string, change: AgentChange): Promise<void>;
  /** Publishes the agent's name as its profile, keeping other profile fields.
   * Create and rename try this themselves; it retries one left pending. */
  publishProfile(pubkey: string): Promise<void>;
  remove(pubkey: string): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    agents2: Agents2;
  }
}

const QUEUE_LIMIT = 32;
/** The spec asks for at least the agent's 2,048 most recent events. */
const SEEN_LIMIT = 2_048;
/** Bounds Delete's relay steps, which otherwise wait on the outbox. */
const REMOVE_TIMEOUT_MS = 60_000;
/** Runs per agent per minute; bounds two agents that answer each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const TIMEOUT_LIMIT_MS = 30 * 60_000;
const TIMER_TICK_MS = 5_000;
const EMPTY = Object.freeze({});
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);
const bounded = (set: Set<string>, id: string) => {
  set.add(id);
  if (set.size > SEEN_LIMIT) set.delete(set.values().next().value as string);
};

type Binding = {
  scope: string;
  origin: string;
  viewer: string;
  session: RelaySession;
};
type Job = { trigger: Trigger; channelId?: string };
type WatchTrigger = Extract<Trigger, { type: "watch" }>;
type CompiledWatch = Omit<WatchTrigger, "type" | "event"> & {
  filter?: ReturnType<typeof compileFilter>;
};
/** One agent's runtime, for as long as its identity and record exist. Edits do not
 * replace it: each job reads the agent as it is when the job starts, and the
 * watches are recompiled only when its attention changes. */
type Runner = {
  readonly pubkey: string;
  /** The registration whose `run` it calls; a new one aborts the in-flight run. */
  type: RegisteredAgentType | undefined;
  controller: AbortController;
  queue: Job[];
  running: boolean;
  windowStart: number;
  admitted: number;
  /** Events seen, and events it wrote (so replies to it are addressed). */
  readonly seen: Set<string>;
  readonly wrote: Set<string>;
  compiled?: {
    attention: Agent["attention"];
    watches: readonly CompiledWatch[];
  };
};

export class Agents2Service extends Service implements Agents2 {
  private readonly contributions;
  private readonly listeners = new Set<() => void>();
  private identities: readonly AgentIdentity[] = [];
  private records: Record<string, AgentRecord>;
  private state: AgentsSnapshot;
  private binding: Binding | undefined;
  private stopLive: (() => void) | undefined;
  private runners = new Map<string, Runner>();
  /** One profile publication per agent at a time, so the last name wins. */
  private profiles = new Map<string, Promise<void>>();

  constructor(
    ctx: Context,
    private readonly relay: RelayData,
    private readonly native: AgentsNative | undefined = nativeAgents(),
    private readonly storage: Storage = globalThis.localStorage,
  ) {
    super(ctx, "agents2");
    this.contributions = createContributions<AgentType>(ctx);
    this.records = readRecords(storage);
    this.state = Object.freeze({
      status: native ? "loading" : "unavailable",
      agents: [],
    });
    ctx.effect(() => {
      const stops = [
        this.contributions.subscribe(() => {
          this.update();
          this.notify();
        }),
        relay.subscribe(() => this.bind()),
      ];
      this.bind();
      void this.load();
      const tick = setInterval(() => this.tick(), TIMER_TICK_MS);
      return () => {
        clearInterval(tick);
        for (const stop of stops) stop();
        this.stopLive?.();
        this.stopLive = undefined;
        this.binding = undefined;
        for (const runner of this.runners.values()) this.retire(runner);
        this.runners.clear();
        // Clear what is shown without reconciling, which would make new runners.
        this.state = Object.freeze({
          ...this.state,
          agents: Object.freeze([]),
        });
        this.notify();
      };
    });
  }

  register<Config>(type: AgentType<Config>) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(type.id ?? "") ||
      !type.title ||
      typeof type.defaults !== "function"
    )
      throw new Error("Agent types need an id, a title and defaults");
    if (
      type.timeoutMs !== undefined &&
      !(
        Number.isInteger(type.timeoutMs) &&
        type.timeoutMs >= 1 &&
        type.timeoutMs <= TIMEOUT_LIMIT_MS
      )
    )
      throw new Error(
        `Agent type timeoutMs must be a whole number from 1 to ${TIMEOUT_LIMIT_MS}`,
      );
    this.contributions.register(this.ctx, type as unknown as AgentType);
  }
  types = () => this.contributions.snapshot();
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  find = (pubkey: string) =>
    this.state.agents.find((agent) => agent.pubkey === pubkey);

  async create({ type, name }: Readonly<{ type: string; name: string }>) {
    const native = this.native;
    const binding = this.binding;
    const kind = this.types().find((entry) => entry.key === type);
    if (!native) throw new Error("Agents run only in the desktop app");
    if (!binding) throw new Error("Connect to a community first");
    if (!kind) throw new Error("That agent type is not available");
    if (!name.trim()) throw new Error("Name the agent");
    const defaults = kind.defaults();
    let record: AgentRecord = {
      pubkey: "",
      type,
      name: name.trim(),
      attention: {},
      config: defaults.config,
      profilePending: true,
    };
    for (const [slug, value] of Object.entries(defaults.attention ?? {}))
      record = setAttention(record, slug, value);
    const pubkey = await native.prepare(
      relayOrigin(binding.origin),
      binding.viewer,
    );
    // The record is saved before native commits, so every committed identity has
    // one to manage it by. If authorizing or committing fails, the record stays:
    // without an identity it is never shown, and the next load prunes it.
    this.write({ ...record, pubkey });
    const identity = await native.commit(
      pubkey,
      await native.authorize(pubkey),
    );
    this.identities = [
      ...this.identities.filter((saved) => saved.pubkey !== pubkey),
      identity,
    ];
    this.update();
    // The agent exists from here on; a failed profile stays pending to retry.
    // A new key has no profile to keep fields of, so this needs no read.
    await this.queueProfile(pubkey, true).catch((error) =>
      console.warn(`Agent ${record.name} profile was not published`, error),
    );
    // Not only `find`: the community shown may have changed meanwhile, and the
    // agent belongs to the one it was made for.
    return (
      this.find(pubkey) ??
      this.view(identity, this.records[pubkey] ?? { ...record, pubkey })
    );
  }

  async save(pubkey: string, change: AgentChange) {
    let record = this.records[pubkey];
    if (!record) throw new Error("No such agent on this device");
    const renamed =
      change.name !== undefined && change.name.trim() !== record.name;
    if (change.name !== undefined) {
      if (!change.name.trim()) throw new Error("Name the agent");
      record = { ...record, name: change.name.trim() };
    }
    if (renamed) record = { ...record, profilePending: true };
    if (change.config !== undefined)
      record = { ...record, config: change.config };
    for (const [slug, value] of Object.entries(change.attention ?? {}))
      record = setAttention(record, slug, value);
    // As the spec's writer: an Interest stays while anything still uses it.
    for (const [slug, value] of Object.entries(change.attention ?? {})) {
      const id = parseSlug(slug)?.id;
      if (value !== null || !slug.startsWith("interest/") || !id) continue;
      if (
        Object.values(record.attention).some(
          (object) =>
            object.value.type !== "interest" && object.value.interest_id === id,
        )
      )
        throw new Error(
          "Remove or move the watches and timers that use this Interest first",
        );
    }
    this.write(record);
    // The rename is saved either way; a failed profile stays pending to retry.
    if (renamed)
      await this.publishProfile(pubkey).catch((error) =>
        console.warn(`Agent ${record.name} profile was not published`, error),
      );
  }

  publishProfile = (pubkey: string) => this.queueProfile(pubkey, false);
  private queueProfile(pubkey: string, fresh: boolean) {
    const next = (this.profiles.get(pubkey) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.sendProfile(pubkey, fresh));
    this.profiles.set(pubkey, next);
    const settle = () => {
      if (this.profiles.get(pubkey) === next) this.profiles.delete(pubkey);
    };
    next.then(settle, settle);
    return next;
  }

  /** As harness Delete does: leave every channel, then archive the identity so
   * it drops out of member lists and mention suggestions, then delete the key.
   * Each relay step is confirmed first; the key is the only irreversible step,
   * so any earlier failure leaves Delete retryable. */
  async remove(pubkey: string) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    const session = this.binding?.session;
    if (!this.find(pubkey) || !session)
      throw new Error("Open this agent's community to delete it");
    const signal = AbortSignal.timeout(REMOVE_TIMEOUT_MS);
    await removeAgentFromChannels(session, pubkey, signal);
    // The archive cache is not live; Delete needs a read started now.
    const { archives } = session;
    await archives.ensure();
    await archives.refresh();
    signal.throwIfAborted();
    if (archives.state(pubkey) !== "archived") {
      // Without an owner-attested profile the agent is not in the directory, so
      // there is nothing to hide (and no consent path to archive it with).
      const consent = archives.writable
        ? await archives.consent(pubkey, signal)
        : null;
      if (consent) await archives.request("archive", pubkey, signal);
    }
    await this.native.remove(pubkey);
    this.identities = this.identities.filter(
      (saved) => saved.pubkey !== pubkey,
    );
    const { [pubkey]: _, ...rest } = this.records;
    this.records = rest;
    writeRecords(this.storage, rest);
    this.update();
  }

  /** Saves one record; memory changes only once storage has taken it. */
  private write(record: AgentRecord) {
    const records = { ...this.records, [record.pubkey]: record };
    writeRecords(this.storage, records);
    this.records = records;
    this.update();
  }
  private view(identity: AgentIdentity, record: AgentRecord): Agent {
    return Object.freeze({
      pubkey: identity.pubkey,
      name: record.name,
      type: record.type,
      owner: identity.owner,
      relay: identity.relay,
      attention: record.attention,
      skipped: record.skipped ?? EMPTY,
      timers: record.timers ?? EMPTY,
      profilePending: record.profilePending === true,
      config: record.config,
    });
  }
  /** As harness profile edits do: read the agent's current kind 0 and change
   * only what the app owns, so fields set elsewhere (a picture, an about) stay. */
  private async sendProfile(pubkey: string, fresh: boolean) {
    const record = this.records[pubkey];
    if (!this.native) throw new Error("Agents run only in the desktop app");
    if (!record?.profilePending) return;
    let current: RelayEvent | undefined;
    if (!fresh) {
      const session = this.binding?.session;
      if (!this.find(pubkey) || !session)
        throw new Error("Open this agent's community to publish its profile");
      await session.profiles.ensure([pubkey]);
      current = session.profiles.event?.(pubkey);
    }
    let fields: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(current?.content ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        fields = parsed as Record<string, unknown>;
    } catch {
      // Nothing readable to keep.
    }
    const { name } = record;
    await this.native.publish(pubkey, {
      kind: 0,
      content: JSON.stringify({
        ...fields,
        name,
        // Shown in place of `name` where present, so it follows the rename.
        ...(typeof fields.display_name === "string"
          ? { display_name: name }
          : {}),
        bot: true,
      }),
      // Native replaces the owner `auth` tag with its own.
      tags: current?.tags ?? [],
    });
    // A rename made meanwhile is still pending; its own publication follows.
    const latest = this.records[pubkey];
    if (latest?.profilePending && latest.name === name) {
      const { profilePending: _, ...published } = latest;
      this.write(published);
    }
  }

  private async load() {
    if (!this.native) return;
    // Only what existed before the list was asked for may be pruned; an agent
    // created while it is in flight is missing from it but very much alive.
    const before = new Set(Object.keys(this.records));
    try {
      const listed = await this.native.list();
      const created = this.identities.filter(
        (identity) => !listed.some((saved) => saved.pubkey === identity.pubkey),
      );
      this.identities = [...listed, ...created];
      // A record whose key is gone can never run again.
      const kept = new Set(this.identities.map((identity) => identity.pubkey));
      const orphan = (key: string) => before.has(key) && !kept.has(key);
      if (Object.keys(this.records).some(orphan)) {
        this.records = Object.fromEntries(
          Object.entries(this.records).filter(([key]) => !orphan(key)),
        );
        writeRecords(this.storage, this.records);
      }
      this.state = { ...this.state, status: "ready" };
    } catch (error) {
      this.state = { ...this.state, status: "error", error: message(error) };
    }
    this.update();
    this.notify();
  }

  private bind() {
    const snapshot = this.relay.snapshot();
    const live =
      snapshot.status === "ready" &&
      !snapshot.cached &&
      snapshot.scope &&
      snapshot.origin &&
      snapshot.viewer
        ? {
            scope: snapshot.scope,
            origin: snapshot.origin,
            viewer: snapshot.viewer,
            session: snapshot.session,
          }
        : undefined;
    if (
      this.binding?.session === live?.session &&
      this.binding?.scope === live?.scope
    )
      return;
    this.stopLive?.();
    this.stopLive = live?.session.subscribeLive((batch) =>
      this.dispatch(batch),
    );
    this.binding = live;
    this.update();
  }

  // Joins identities, records and the connection into the visible agents, and
  // keeps one runner per saved agent. Runners outlive edits and reconnects; one is
  // retired only when its agent is removed, and its run is aborted when the
  // agent's type is replaced.
  private update() {
    const binding = this.binding;
    const agents: Agent[] = [];
    for (const identity of this.identities) {
      const record = this.records[identity.pubkey];
      if (!record || !binding || identity.owner !== binding.viewer) continue;
      try {
        if (
          relayPartition(relayOrigin(identity.relay), binding.viewer) !==
          binding.scope
        )
          continue;
      } catch {
        continue;
      }
      // Reuse the frozen agent while nothing visible changed, so subscribers see
      // a stable snapshot.
      const prior = this.find(identity.pubkey);
      agents.push(
        prior &&
          prior.name === record.name &&
          prior.type === record.type &&
          prior.attention === record.attention &&
          prior.skipped === record.skipped &&
          prior.timers === record.timers &&
          prior.profilePending === (record.profilePending === true) &&
          prior.config === record.config
          ? prior
          : this.view(identity, record),
      );
    }
    const types = new Map(this.types().map((type) => [type.key, type]));
    for (const [pubkey, runner] of this.runners)
      if (
        !this.records[pubkey] ||
        !this.identities.some((identity) => identity.pubkey === pubkey)
      ) {
        this.retire(runner);
        this.runners.delete(pubkey);
      }
    for (const identity of this.identities) {
      const record = this.records[identity.pubkey];
      if (!record) continue;
      const type = types.get(record.type);
      const runner = this.runners.get(identity.pubkey);
      if (!runner)
        this.runners.set(identity.pubkey, this.runner(identity, type));
      else if (runner.type !== type) {
        runner.controller.abort();
        runner.controller = new AbortController();
        runner.type = type;
        void this.drain(runner);
      }
    }
    const same =
      agents.length === this.state.agents.length &&
      agents.every((agent, index) => agent === this.state.agents[index]);
    if (!same) {
      this.state = Object.freeze({
        ...this.state,
        agents: Object.freeze(agents),
      });
      this.notify();
    }
    // Resume runners whose queue paused while their agent was out of view.
    for (const runner of this.runners.values())
      if (runner.queue.length) void this.drain(runner);
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }

  private runner(
    identity: AgentIdentity,
    type: RegisteredAgentType | undefined,
  ): Runner {
    return {
      pubkey: identity.pubkey,
      type,
      controller: new AbortController(),
      queue: [],
      running: false,
      windowStart: 0,
      admitted: 0,
      seen: new Set(),
      wrote: new Set(),
    };
  }
  private retire(runner: Runner) {
    runner.queue.length = 0;
    runner.controller.abort();
  }
  /** The runner's event watches for the agent's current attention. */
  private watches(runner: Runner, agent: Agent) {
    if (runner.compiled?.attention === agent.attention)
      return runner.compiled.watches;
    const watches: CompiledWatch[] = [];
    for (const object of Object.values(agent.attention)) {
      const watch = object.value;
      if (watch.type !== "event" || !watch.enabled) continue;
      const interest = agent.attention[`interest/${watch.interest_id}`]?.value;
      watches.push({
        slug: object.slug,
        watch,
        ...(interest?.type === "interest" ? { interest } : {}),
        // No classifier model runs here yet, so the event passes unclassified.
        ...(watch.classifier ? { classifier: "not run" as const } : {}),
        ...(watch.filter ? { filter: compileFilter(watch.filter) } : {}),
      });
    }
    runner.compiled = { attention: agent.attention, watches };
    return watches;
  }

  private dispatch(batch: LiveBatch) {
    for (const runner of this.runners.values()) {
      const agent = this.find(runner.pubkey);
      if (!agent || !runner.type?.run) continue;
      for (const event of batch.events) {
        if (runner.seen.has(event.id)) continue;
        bounded(runner.seen, event.id);
        // An agent never hears itself; its own events make replies addressed.
        if (event.pubkey === agent.pubkey) {
          bounded(runner.wrote, event.id);
          continue;
        }
        for (const trigger of this.heard(runner, agent, event))
          this.enqueue(runner, {
            trigger,
            ...(batch.channelId ? { channelId: batch.channelId } : {}),
          });
      }
    }
  }
  private heard(runner: Runner, agent: Agent, event: RelayEvent): Trigger[] {
    const wrote = (id: string) => runner.wrote.has(id);
    // Two of one owner's agents would otherwise answer each other forever: one
    // hears another only when it is named in something that does not reply to it.
    if (
      this.identities.some(
        (identity) =>
          identity.pubkey === event.pubkey && identity.owner === agent.owner,
      )
    )
      return CHAT_KINDS.includes(event.kind) &&
        tagsAgent(event, agent.pubkey) &&
        !event.tags.some((tag) => tag[0] === "e" && !!tag[1] && wrote(tag[1]))
        ? [{ type: "mention", event }]
        : [];
    // Addressed events never reach a watch. Only conversation starts a run: not a
    // DM it cannot read yet, nor a reaction to its message.
    if (addressedTo(event, agent.pubkey, wrote))
      return CHAT_KINDS.includes(event.kind)
        ? [{ type: "mention", event }]
        : [];
    return this.watches(runner, agent)
      .filter(({ watch, filter }) => watchMatches(watch, event, filter))
      .map(({ filter: _, ...match }) => ({ type: "watch", event, ...match }));
  }

  // Spec schedule rules: occurrence k is due at armed_at + k × interval, at most one
  // runs when overdue, then the next is due interval after it ran. A timer with no
  // saved state counts what was already due as used (see timerState).
  private tick(now = Math.floor(Date.now() / 1000)) {
    let changed = false;
    for (const runner of this.runners.values()) {
      const agent = this.find(runner.pubkey);
      const record = this.records[runner.pubkey];
      if (!agent || !record || !runner.type?.run) continue;
      const prior = record.timers ?? {};
      let timers = prior;
      for (const object of Object.values(agent.attention)) {
        const timer = object.value;
        if (timer.type !== "timer" || !timer.enabled) continue;
        const state = timerState(timer, timers[object.slug], now);
        if (state !== timers[object.slug])
          timers = { ...timers, [object.slug]: state };
        if (now < state.nextDue || timerSpent(timer, state, now)) continue;
        timers = {
          ...timers,
          [object.slug]: {
            ...state,
            used: state.used + 1,
            nextDue: now + timer.interval_secs,
          },
        };
        const interest =
          agent.attention[`interest/${timer.interest_id}`]?.value;
        this.enqueue(runner, {
          trigger: {
            type: "timer",
            slug: object.slug,
            timer,
            ...(interest?.type === "interest" ? { interest } : {}),
          },
        });
      }
      if (timers !== prior) {
        this.records = {
          ...this.records,
          [record.pubkey]: { ...record, timers },
        };
        changed = true;
      }
    }
    if (changed) {
      writeRecords(this.storage, this.records);
      // Shows the new run counts; the runners and their queues carry on.
      this.update();
    }
  }

  private enqueue(runner: Runner, job: Job) {
    const now = Date.now();
    if (now - runner.windowStart >= RATE_WINDOW_MS) {
      runner.windowStart = now;
      runner.admitted = 0;
    }
    if (runner.queue.length >= QUEUE_LIMIT || runner.admitted >= RATE_LIMIT) {
      console.warn(`Agent ${this.find(runner.pubkey)?.name} dropped an event`);
      return;
    }
    runner.admitted++;
    runner.queue.push(job);
    void this.drain(runner);
  }

  // One run at a time per agent, in arrival order. Each job runs the agent as it
  // is when the job starts. While the agent is out of view (disconnected, another
  // community) the queue pauses and update() resumes it; a type that cannot run
  // drops what is queued. A run that ignores its deadline stops holding
  // the queue when the deadline passes; it is not otherwise fenced.
  private async drain(runner: Runner) {
    if (runner.running) return;
    runner.running = true;
    while (runner.queue.length && this.runners.get(runner.pubkey) === runner) {
      const agent = this.find(runner.pubkey);
      if (!agent) break;
      const type = runner.type;
      const run = type?.run;
      if (!type || !run) {
        runner.queue.length = 0;
        break;
      }
      const job = runner.queue.shift() as Job;
      const lifetime = runner.controller.signal;
      const signal = AbortSignal.any([
        lifetime,
        AbortSignal.timeout(type.timeoutMs ?? 60_000),
      ]);
      const handle: AgentHandle = Object.freeze({
        pubkey: agent.pubkey,
        name: agent.name,
        owner: agent.owner,
        publish: (event: AgentEventTemplate) => this.publish(runner, event),
      });
      try {
        await Promise.race([
          Promise.resolve().then(() =>
            run(
              Object.freeze({
                trigger: job.trigger,
                ...(job.channelId ? { channelId: job.channelId } : {}),
                agent: handle,
                config: agent.config,
                signal,
              }),
            ),
          ),
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      } catch (error) {
        if (!lifetime.aborted)
          console.error(`Agent run failed: ${agent.name}`, error);
      }
    }
    runner.running = false;
  }

  private async publish(runner: Runner, event: AgentEventTemplate) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    const signed = await this.native.publish(runner.pubkey, event);
    bounded(runner.wrote, signed.id);
    return signed;
  }
}
