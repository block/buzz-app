// Agents2: agents that are plugins from the start. A plugin registers an agent
// type (its card back, its view tabs and its `run`); each agent made from it has
// its own native-held key, an `agent-attention/v1` configuration and a config blob
// the type owns. The app delivers matching live events to `run` from the stream
// the owner already receives, so no plugin opens a socket or a REQ.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import { communityRequest } from "../communities/api";
import { relayOrigin } from "../communities/destination";
import type { RelayEvent } from "../relay/events";
import type { LiveBatch } from "../relay/incoming";
import { relayPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import {
  addressedTo,
  compileFilter,
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
  config: Config;
}>;
export type AgentChange<Config = unknown> = Readonly<{
  name?: string;
  config?: Config;
  /** Slug to new value; `null` deletes the object. */
  attention?: Readonly<Record<string, AttentionValue | null>>;
}>;
/** What the card back and each tab receive. */
export type AgentViewProps<Config = unknown> = {
  agent: Agent<Config>;
  save(change: AgentChange<Config>): Promise<void>;
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
export type WatchMatch = Readonly<{
  slug: string;
  watch: EventWatch;
  interest?: Interest;
}>;
export type Trigger =
  /** Directly addressed: a mention, DM, or reply to something the agent wrote. */
  | Readonly<{ type: "mention"; event: RelayEvent }>
  | Readonly<{
      type: "watch";
      event: RelayEvent;
      watches: readonly WatchMatch[];
    }>
  | Readonly<{
      type: "timer";
      slug: string;
      timer: TimerWatch;
      interest?: Interest;
    }>;
export type Delivery<Config = unknown> = Readonly<{
  trigger: Trigger;
  /** The live route's channel; absent when the wire scope was ambiguous. */
  channelId?: string;
  agent: AgentHandle;
  config: Config;
  /** Aborts on the run's deadline, or when the agent is edited or removed. Advisory:
   * the handle keeps working, so finishing up after an abort is harmless. */
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
  /** The card's back face, shown on hover in the agents grid. */
  Back?: ComponentType<AgentViewProps<Config>>;
  /** The agent's view tabs, in order. */
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
  remove(pubkey: string): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    agents2: Agents2;
  }
}

const QUEUE_LIMIT = 32;
const SEEN_LIMIT = 512;
/** Runs per agent per minute; bounds two agents that answer each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const TIMEOUT_LIMIT_MS = 30 * 60_000;
const TIMER_TICK_MS = 5_000;
/** Timer schedule state is runtime state, not config, so it is kept apart from it. */
const TIMERS_KEY = "buzz.agents2.timers.v1";
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);
const bounded = (set: Set<string>, id: string) => {
  set.add(id);
  if (set.size > SEEN_LIMIT) set.delete(set.values().next().value as string);
};

type Binding = { scope: string; viewer: string; session: unknown };
type Job = { trigger: Trigger; channelId?: string };
/** One running agent. Replaced, and its runs aborted, when the agent changes. */
type Runner = {
  agent: Agent;
  type: RegisteredAgentType;
  watches: readonly (WatchMatch & {
    filter?: ReturnType<typeof compileFilter>;
  })[];
  controller: AbortController;
  queue: Job[];
  running: boolean;
  windowStart: number;
  admitted: number;
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
  /** Per agent: events seen, and events it wrote (so replies to it are addressed). */
  private readonly seen = new Map<string, Set<string>>();
  private readonly wrote = new Map<string, Set<string>>();
  /** Keyed by `pubkey slug`. */
  private timers: Record<string, TimerState>;

  constructor(
    ctx: Context,
    private readonly relay: RelayData,
    private readonly native: AgentsNative | undefined = nativeAgents(),
    private readonly storage: Storage = globalThis.localStorage,
  ) {
    super(ctx, "agents2");
    this.contributions = createContributions<AgentType>(ctx);
    this.records = readRecords(storage);
    try {
      this.timers = JSON.parse(storage.getItem(TIMERS_KEY) ?? "{}") ?? {};
    } catch {
      this.timers = {};
    }
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
        this.update();
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
    const destination = relayOrigin(
      binding.scope.slice(0, -(binding.viewer.length + 1)),
    );
    const defaults = kind.defaults();
    let record: AgentRecord = {
      pubkey: "",
      type,
      name: name.trim(),
      attention: {},
      config: defaults.config,
    };
    for (const [slug, value] of Object.entries(defaults.attention ?? {}))
      record = setAttention(record, slug, value);
    const pubkey = await native.prepare(destination, binding.viewer);
    const { auth } = await communityRequest<{ auth: string[] }>(
      destination,
      "authorize-agent",
      { pubkey, owner: binding.viewer },
    );
    const identity = await native.commit(pubkey, auth);
    this.identities = [
      ...this.identities.filter((saved) => saved.pubkey !== pubkey),
      identity,
    ];
    this.write({ ...record, pubkey });
    await this.publishProfile(pubkey);
    return this.find(pubkey) as Agent;
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
    if (change.config !== undefined)
      record = { ...record, config: change.config };
    for (const [slug, value] of Object.entries(change.attention ?? {}))
      record = setAttention(record, slug, value);
    this.write(record);
    if (renamed) await this.publishProfile(pubkey);
  }

  async remove(pubkey: string) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    await this.native.remove(pubkey);
    this.identities = this.identities.filter(
      (saved) => saved.pubkey !== pubkey,
    );
    const { [pubkey]: _, ...rest } = this.records;
    this.records = rest;
    writeRecords(this.storage, rest);
    this.update();
  }

  private write(record: AgentRecord) {
    this.records = { ...this.records, [record.pubkey]: record };
    writeRecords(this.storage, this.records);
    this.update();
  }
  private async publishProfile(pubkey: string) {
    const record = this.records[pubkey];
    if (!record || !this.native) return;
    await this.native.publish(pubkey, {
      kind: 0,
      content: JSON.stringify({ name: record.name, bot: true }),
    });
  }

  private async load() {
    if (!this.native) return;
    try {
      this.identities = await this.native.list();
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
      snapshot.viewer
        ? {
            scope: snapshot.scope,
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

  // Rebuilds the visible agents and the runners from identities, records, types and
  // the connection. A runner whose agent or type changed is replaced, which aborts
  // its in-flight run; nothing else about a run's lifetime is managed.
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
      const prior = this.find(identity.pubkey);
      const next: Agent = Object.freeze({
        pubkey: identity.pubkey,
        name: record.name,
        type: record.type,
        owner: identity.owner,
        relay: identity.relay,
        attention: record.attention,
        config: record.config,
      });
      agents.push(
        prior &&
          prior.name === next.name &&
          prior.type === next.type &&
          prior.attention === next.attention &&
          prior.config === next.config
          ? prior
          : next,
      );
    }
    const types = new Map(this.types().map((type) => [type.key, type]));
    const runners = new Map<string, Runner>();
    for (const agent of agents) {
      const type = types.get(agent.type);
      if (!type?.run) continue;
      const prior = this.runners.get(agent.pubkey);
      runners.set(
        agent.pubkey,
        prior && prior.agent === agent && prior.type === type
          ? prior
          : this.runner(agent, type),
      );
    }
    for (const [pubkey, runner] of this.runners)
      if (runners.get(pubkey) !== runner) runner.controller.abort();
    this.runners = runners;
    const same =
      agents.length === this.state.agents.length &&
      agents.every((agent, index) => agent === this.state.agents[index]);
    if (same) return;
    this.state = Object.freeze({
      ...this.state,
      agents: Object.freeze(agents),
    });
    this.notify();
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }

  private runner(agent: Agent, type: RegisteredAgentType): Runner {
    const watches: Runner["watches"][number][] = [];
    for (const object of Object.values(agent.attention)) {
      const watch = object.value;
      // Classifiers are not supported yet; such a watch never matches.
      if (watch.type !== "event" || !watch.enabled || watch.classifier)
        continue;
      const interest = agent.attention[`interest/${watch.interest_id}`]?.value;
      watches.push({
        slug: object.slug,
        watch,
        ...(interest?.type === "interest" ? { interest } : {}),
        ...(watch.filter ? { filter: compileFilter(watch.filter) } : {}),
      });
    }
    return {
      agent,
      type,
      watches,
      controller: new AbortController(),
      queue: [],
      running: false,
      windowStart: 0,
      admitted: 0,
    };
  }

  private dispatch(batch: LiveBatch) {
    for (const runner of this.runners.values()) {
      const { pubkey } = runner.agent;
      const seen = this.seen.get(pubkey) ?? new Set();
      const wrote = this.wrote.get(pubkey) ?? new Set();
      this.seen.set(pubkey, seen);
      this.wrote.set(pubkey, wrote);
      for (const event of batch.events) {
        if (seen.has(event.id)) continue;
        bounded(seen, event.id);
        // An agent never hears itself; its own events make replies addressed.
        if (event.pubkey === pubkey) {
          bounded(wrote, event.id);
          continue;
        }
        const trigger: Trigger | undefined = addressedTo(event, pubkey, (id) =>
          wrote.has(id),
        )
          ? { type: "mention", event }
          : this.watching(runner, event);
        if (trigger)
          this.enqueue(runner, {
            trigger,
            ...(batch.channelId ? { channelId: batch.channelId } : {}),
          });
      }
    }
  }
  private watching(runner: Runner, event: RelayEvent): Trigger | undefined {
    const watches = runner.watches
      .filter(({ watch, filter }) => watchMatches(watch, event, filter))
      .map(({ filter: _, ...match }) => match);
    return watches.length ? { type: "watch", event, watches } : undefined;
  }

  // Spec schedule rules: first due at armed_at + interval, at most one occurrence
  // when overdue, then due again interval after it ran; a new armed_at restarts.
  private tick(now = Math.floor(Date.now() / 1000)) {
    let changed = false;
    for (const runner of this.runners.values())
      for (const object of Object.values(runner.agent.attention)) {
        const timer = object.value;
        if (timer.type !== "timer" || !timer.enabled) continue;
        const key = `${runner.agent.pubkey} ${object.slug}`;
        const state = timerState(timer, this.timers[key]);
        if (state !== this.timers[key]) {
          this.timers[key] = state;
          changed = true;
        }
        if (now < state.nextDue || timerSpent(timer, state, now)) continue;
        this.timers[key] = {
          ...state,
          used: state.used + 1,
          nextDue: now + timer.interval_secs,
        };
        changed = true;
        const interest =
          runner.agent.attention[`interest/${timer.interest_id}`]?.value;
        this.enqueue(runner, {
          trigger: {
            type: "timer",
            slug: object.slug,
            timer,
            ...(interest?.type === "interest" ? { interest } : {}),
          },
        });
      }
    if (changed) this.storage.setItem(TIMERS_KEY, JSON.stringify(this.timers));
  }

  private enqueue(runner: Runner, job: Job) {
    const now = Date.now();
    if (now - runner.windowStart >= RATE_WINDOW_MS) {
      runner.windowStart = now;
      runner.admitted = 0;
    }
    if (runner.queue.length >= QUEUE_LIMIT || runner.admitted >= RATE_LIMIT) {
      console.warn(`Agent ${runner.agent.name} dropped an event`);
      return;
    }
    runner.admitted++;
    runner.queue.push(job);
    void this.drain(runner);
  }

  // One run at a time per agent, in arrival order. A run that ignores its deadline
  // stops holding the queue when the deadline passes; it is not otherwise fenced.
  private async drain(runner: Runner) {
    if (runner.running) return;
    runner.running = true;
    const run = runner.type.run as NonNullable<AgentType["run"]>;
    const agent: AgentHandle = Object.freeze({
      pubkey: runner.agent.pubkey,
      name: runner.agent.name,
      owner: runner.agent.owner,
      publish: (event: AgentEventTemplate) =>
        this.publish(runner.agent.pubkey, event),
    });
    while (runner.queue.length && !runner.controller.signal.aborted) {
      const job = runner.queue.shift() as Job;
      const signal = AbortSignal.any([
        runner.controller.signal,
        AbortSignal.timeout(runner.type.timeoutMs ?? 60_000),
      ]);
      try {
        await Promise.race([
          Promise.resolve().then(() =>
            run(
              Object.freeze({
                trigger: job.trigger,
                ...(job.channelId ? { channelId: job.channelId } : {}),
                agent,
                config: runner.agent.config,
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
        if (!runner.controller.signal.aborted)
          console.error(`Agent run failed: ${runner.agent.name}`, error);
      }
    }
    runner.running = false;
  }

  private async publish(pubkey: string, event: AgentEventTemplate) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    const signed = await this.native.publish(pubkey, event);
    const wrote = this.wrote.get(pubkey) ?? new Set();
    this.wrote.set(pubkey, wrote);
    bounded(wrote, signed.id);
    return signed;
  }
}
