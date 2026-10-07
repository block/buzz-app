// Agent types: a plugin contributes a factory, and each agent created from it is an
// instance with its own bot identity and saved config. The type turns that config into
// a Nostr subscription, and the app runs the type's function for each matching event
// on the stream the owner already receives. No plugin opens a socket or a REQ.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import { sameCommunityAgents } from "../agents/choices";
import type {
  AgentControl,
  AgentEventTemplate,
  AgentView,
  PublishedAgentEvent,
  WorkspaceEntry,
  WorkspaceExecOptions,
} from "../agents/control";
import type { RelayEvent } from "../relay/events";
import type { LiveBatch } from "../relay/incoming";
import { matchesEvent } from "../relay/projection";
import type { RelayData } from "../relay/service";
import { threadReference } from "../relay/thread-reference";
import {
  createLiveRuns,
  noLive,
  type AgentRunLive,
  type LiveRuns,
} from "./live";

/** One NIP-01 filter. JSON data only, so any host can evaluate it: this app today,
 * a relay for a remote workload later. What a filter cannot say belongs in `run`. */
export type AgentFilter = Readonly<{
  ids?: readonly string[];
  authors?: readonly string[];
  kinds?: readonly number[];
  since?: number;
  until?: number;
  [tag: `#${string}`]: readonly string[] | undefined;
}>;
/** The bot an agent runs as. Its key stays native; the owner's NIP-OA attestation
 * is attached to everything it signs. */
export type AgentIdentity = Readonly<{
  /** The agent record on this device. */
  id: string;
  pubkey: string;
  name: string;
  /** The person who created the agent, and whose connection read the event. */
  owner: string;
  /** Signs a message (9), edit (40003), reaction (7) or deletion (5) as the agent and posts it to
   * the agent's community. Rejects once the agent is stopped, edited or deleted. */
  publish(event: AgentEventTemplate): Promise<PublishedAgentEvent>;
  /** Reads one of the secrets the agent's type declares. Rejects for any other name,
   * when the owner has saved no value, and once the agent is stopped or deleted. */
  secret(name: string): Promise<string>;
  /** Present when the agent's type asks for a workspace and the owner chose one. */
  workspace?: AgentWorkspace;
}>;
/** Files and commands in the one directory the owner chose for an agent. File
 * paths are relative to it, or absolute inside it; native refuses any other.
 * `exec` only starts there: bash can reach whatever the owner's account can.
 * Every call rejects once the agent is stopped, edited or deleted. */
export type AgentWorkspace = Readonly<{
  /** The directory as the owner entered it. */
  path: string;
  /** A UTF-8 text file of at most 8 MiB. */
  readFile(path: string): Promise<string>;
  /** Replaces the file, creating its folders. */
  writeFile(path: string, content: string): Promise<void>;
  list(path: string): Promise<readonly WorkspaceEntry[]>;
  /** Runs `command` with bash. Resolves to its exit code, or to `null` when a
   * signal ended it. Rejects if it could not start, timed out or was aborted,
   * which also happens when the agent stops. */
  exec(command: string, options?: WorkspaceExecOptions): Promise<number | null>;
}>;
/** A value the owner types once and the app never shows again, such as an API key.
 * It is kept out of `config`, so no form, snapshot or other plugin can read it. */
export type AgentSecret = Readonly<{
  /** Letters, digits and underscores, not starting with a digit. */
  name: string;
  label: string;
  /** An agent can be created and run without it. */
  optional?: boolean;
}>;
/** What `run` receives. A match means "delivered", not "must respond". */
export type AgentDelivery<Config> = Readonly<{
  event: RelayEvent;
  /** The live route's channel; absent when the wire scope was ambiguous or global. */
  channelId?: string;
  /** Host-resolved context boundary; DMs always use channel context. */
  conversation?: Readonly<{ channelName: string; threadRootId?: string }>;
  agent: AgentIdentity;
  config: Config;
  /** Shows this run's steps and streamed text in the owner's window while it runs.
   * Nothing sent here reaches the relay; publish what other people should see. */
  live: AgentRunLive;
  /** Discards waiting deliveries in this conversation, including the host queue. */
  cancelQueued(): void;
  /** Aborts on timeout, when the agent is stopped, edited or deleted, when its plugin
   * is disabled or replaced, and when the owner's connection is replaced. */
  signal: AbortSignal;
}>;
export type AgentConfigProps<Config> = {
  config: Config;
  onChange(config: Config): void;
  disabled: boolean;
  /** The saved agent on its own screen; absent in Create agent. */
  agent?: Pick<AgentView, "id" | "pubkey" | "name">;
};
export type AgentType<Config = unknown> = {
  id: string;
  title: string;
  description?: string;
  /** The config a new agent starts from. Config is JSON saved on the agent record. */
  defaults: Config;
  /** The type's settings form, shown in Create agent and on the agent's screen. */
  Configure: ComponentType<AgentConfigProps<Config>>;
  /** A message that blocks Create and Save, or nothing when the config is usable. */
  validate?(config: Config): string | undefined;
  /** Turns one agent's config into its subscription: a filter or a list of filters.
   * Called again after every save. */
  subscription(
    config: Config,
    agent: Pick<AgentIdentity, "pubkey" | "owner">,
  ): AgentFilter | readonly AgentFilter[];
  run(delivery: AgentDelivery<Config>): void | Promise<void>;
  /** Owner controls bypass ordinary admission (two steering requests and one stop in flight).
   * The same run callback handles them. Other authors cannot invoke this path. */
  control?(
    event: RelayEvent,
    agent: AgentIdentity,
  ): "steer" | "stop" | undefined;
  /** Per-run deadline in milliseconds; defaults to 30 seconds. */
  timeoutMs?: number;
  /** How many runs one agent may have in progress at once, from 1 to 16. Defaults
   * to 1, so each agent handles its events in order. */
  concurrency?: number;
  /** Write-only values the host asks for under `Configure`. */
  secrets?: readonly AgentSecret[];
  /** Asks the owner for a directory under `Configure`, and gives `run` files and
   * commands there as `agent.workspace`. */
  workspace?: boolean | "required";
  /** Offers the saved Conversation context setting and resolves it on deliveries. */
  conversationContext?: boolean;
};
export type RegisteredAgentType = Contribution<AgentType>;
/** One agent's runs in this window since the app opened. */
export type AgentActivity = Readonly<{
  /** The subscription in force; absent while the agent is not listening. */
  subscription?: readonly AgentFilter[];
  fired: number;
  errors: number;
  /** Matches not run: the queue was full or the per-minute cap was reached. */
  dropped: number;
  lastFiredAt?: number;
  lastError?: string;
}>;
export type AgentTypes = {
  register<Config>(type: AgentType<Config>): void;
  snapshot(): readonly RegisteredAgentType[];
  /** Keyed by agent id; replaced on every change. */
  activity(): Readonly<Record<string, AgentActivity>>;
  subscribe(listener: () => void): () => void;
  /** Runs in progress in this window. Notifies apart from `subscribe`, because
   * streamed text changes it many times a second. */
  runs: LiveRuns;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    agentTypes: AgentTypes;
  }
}

const QUEUE_LIMIT = 32;
const SEEN_LIMIT = 512;
/** Runs per agent per minute. Bounds an agent whose own effect retriggers it,
 * such as two agents that answer each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const CONCURRENCY_LIMIT = 16;
/** The names native accepts for a saved value. */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Copies a subscription into frozen plain data, or throws naming the bad field. */
export function parseSubscription(value: unknown): readonly AgentFilter[] {
  const filters = Array.isArray(value) ? value : [value];
  if (!filters.length) throw new Error("A subscription needs a filter");
  return Object.freeze(
    filters.map((filter) => {
      if (!filter || typeof filter !== "object" || Array.isArray(filter))
        throw new Error("A subscription filter must be an object");
      const copy: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(filter)) {
        if (field === undefined) continue;
        const valid =
          name === "kinds"
            ? Array.isArray(field) && field.every(Number.isInteger)
            : name === "since" || name === "until"
              ? Number.isSafeInteger(field)
              : name === "ids" || name === "authors" || /^#[a-zA-Z]$/.test(name)
                ? strings(field)
                : false;
        if (!valid)
          throw new Error(`Unsupported subscription filter field: ${name}`);
        copy[name] = Array.isArray(field) ? Object.freeze([...field]) : field;
      }
      return Object.freeze(copy) as AgentFilter;
    }),
  );
}

type Binding = {
  scope: string;
  viewer: string;
  session: ReturnType<RelayData["snapshot"]>["session"];
  signal: AbortSignal;
  close(): void;
};
type Job = { event: RelayEvent; channelId?: string };
/** One enabled agent of an active type, on the current connection. */
type Instance = {
  agent: AgentView;
  type: RegisteredAgentType;
  binding: Binding;
  subscription: readonly AgentFilter[];
  identity: AgentIdentity;
  controller: AbortController;
  queue: Job[];
  seen: Set<string>;
  running: number;
  controls: number;
  stopping: boolean;
  sessionPolicy: "channel" | "thread";
  windowStart: number;
  admitted: number;
};
const idle: AgentActivity = Object.freeze({ fired: 0, errors: 0, dropped: 0 });
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);

export class AgentTypesService extends Service implements AgentTypes {
  private readonly contributions;
  private instances = new Map<string, Instance>();
  private readonly listeners = new Set<() => void>();
  private counters: Readonly<Record<string, AgentActivity>> = Object.freeze({});
  private binding: Binding | undefined;
  private readonly liveRuns = createLiveRuns();
  readonly runs: LiveRuns = {
    snapshot: this.liveRuns.snapshot,
    subscribe: this.liveRuns.subscribe,
  };

  constructor(
    ctx: Context,
    relay: RelayData,
    private readonly control: AgentControl,
  ) {
    super(ctx, "agentTypes");
    this.contributions = createContributions<AgentType>(ctx);
    ctx.effect(() => {
      const stops = [
        this.contributions.subscribe(() => {
          this.load();
          this.reconcile();
          this.publish();
        }),
        control.subscribe(() => this.reconcile()),
        relay.subscribe(() => this.bind(relay)),
      ];
      this.bind(relay);
      return () => {
        for (const stop of stops) stop();
        this.binding?.close();
        this.binding = undefined;
        this.reconcile();
      };
    });
  }

  snapshot = () => this.contributions.snapshot();
  activity = () => this.counters;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  register<Config>(type: AgentType<Config>) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(type.id ?? "") ||
      !type.title ||
      typeof type.Configure !== "function" ||
      typeof type.subscription !== "function" ||
      typeof type.run !== "function"
    )
      throw new Error(
        "Agent types need an id, a title, Configure, subscription and run",
      );
    const { concurrency, secrets = [] } = type;
    if (
      concurrency !== undefined &&
      !(
        Number.isInteger(concurrency) &&
        concurrency >= 1 &&
        concurrency <= CONCURRENCY_LIMIT
      )
    )
      throw new Error(
        `Agent type concurrency must be a whole number from 1 to ${CONCURRENCY_LIMIT}`,
      );
    if (
      !Array.isArray(secrets) ||
      secrets.some(
        (secret) =>
          !SECRET_NAME.test(secret?.name ?? "") ||
          typeof secret.label !== "string" ||
          !secret.label.trim(),
      ) ||
      new Set(secrets.map((secret) => secret.name)).size !== secrets.length
    )
      throw new Error(
        "Agent type secrets need a unique name of letters, digits and underscores, and a label",
      );
    this.contributions.register(this.ctx, type as unknown as AgentType);
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
  private count(id: string, change: (now: AgentActivity) => AgentActivity) {
    this.counters = Object.freeze({
      ...this.counters,
      [id]: Object.freeze(change(this.counters[id] ?? idle)),
    });
    this.publish();
  }

  private bind(relay: RelayData) {
    const snapshot = relay.snapshot();
    const live =
      snapshot.status === "ready" && !snapshot.cached && snapshot.scope
        ? { viewer: snapshot.viewer, scope: snapshot.scope }
        : undefined;
    if (
      this.binding?.session === snapshot.session &&
      this.binding.scope === live?.scope
    )
      return;
    this.binding?.close();
    this.binding = undefined;
    if (live?.viewer) {
      const controller = new AbortController();
      const stop = snapshot.session.subscribeLive((batch) =>
        this.dispatch(batch),
      );
      this.binding = {
        scope: live.scope,
        viewer: live.viewer,
        session: snapshot.session,
        signal: controller.signal,
        close: () => {
          stop();
          controller.abort();
        },
      };
      this.load();
    }
    this.reconcile();
  }

  // Nothing else is guaranteed to have loaded the device's agents yet. With no
  // registered type there is nothing to run, so the native inventory stays unread.
  private load() {
    if (
      this.binding &&
      this.contributions.snapshot().length &&
      this.control.snapshot().status === "idle"
    )
      void this.control.refresh();
  }

  // The listening set: enabled agents in this community whose type is active. An
  // agent whose record, type revision or connection changed is rebuilt, which
  // aborts its in-flight run and recomputes its subscription from the saved config.
  private sessionPolicy(agent: AgentView, type: AgentType) {
    return type.conversationContext
      ? (agent.sessionPolicy ??
          this.control.snapshot().data?.defaultSettings?.sessionPolicy ??
          "channel")
      : "thread";
  }

  private reconcile() {
    const types = new Map(
      this.contributions.snapshot().map((type) => [type.key, type]),
    );
    const binding = this.binding;
    const next = new Map<string, Instance>();
    let counters = this.counters;
    for (const agent of binding
      ? sameCommunityAgents(
          this.control.snapshot().data?.agents ?? [],
          binding.scope,
        )
      : []) {
      const type =
        agent.plugin && agent.enabled
          ? types.get(agent.plugin.type)
          : undefined;
      if (!type) continue;
      const prior = this.instances.get(agent.id);
      if (
        prior?.type === type &&
        prior.binding === binding &&
        prior.agent.revision === agent.revision &&
        prior.agent.name === agent.name &&
        prior.sessionPolicy === this.sessionPolicy(agent, type)
      ) {
        next.set(agent.id, prior);
        continue;
      }
      const instance = this.start(agent, type, binding as Binding, prior?.seen);
      const {
        subscription: _,
        lastError: __,
        ...kept
      } = counters[agent.id] ?? idle;
      counters = {
        ...counters,
        [agent.id]: Object.freeze(
          "error" in instance
            ? { ...kept, lastError: instance.error }
            : { ...kept, subscription: instance.subscription },
        ),
      };
      if (!("error" in instance)) next.set(agent.id, instance);
    }
    for (const [id, instance] of this.instances) {
      if (next.get(id) === instance) continue;
      const replacement = next.get(id);
      instance.controller.abort(
        replacement?.binding === instance.binding &&
          replacement.type === instance.type
          ? "settings-changed"
          : undefined,
      );
      // Stopped, deleted, or its type went away: no subscription is in force.
      if (!next.has(id) && counters[id]?.subscription) {
        const { subscription: _, ...kept } = counters[id];
        counters = { ...counters, [id]: Object.freeze(kept) };
      }
    }
    this.instances = next;
    if (counters === this.counters) return;
    this.counters = Object.freeze(counters);
    this.publish();
  }

  private start(
    agent: AgentView,
    type: RegisteredAgentType,
    binding: Binding,
    seen = new Set<string>(),
  ): Instance | { error: string } {
    const controller = new AbortController();
    const listening = () => {
      if (controller.signal.aborted || binding.signal.aborted)
        throw new Error("This agent is no longer listening");
    };
    const files = this.control.workspace;
    const identity: AgentIdentity = Object.freeze({
      id: agent.id,
      pubkey: agent.pubkey,
      name: agent.name,
      owner: binding.viewer,
      publish: async (event: AgentEventTemplate) => {
        if (controller.signal.aborted || binding.signal.aborted)
          throw new Error("This agent is no longer listening");
        if (!this.control.publishAs)
          throw new Error("Agents can publish only from the desktop app");
        return this.control.publishAs(agent.id, {
          kind: event.kind,
          content: event.content,
          tags: event.tags ?? [],
        });
      },
      secret: async (name: string) => {
        if (controller.signal.aborted || binding.signal.aborted)
          throw new Error("This agent is no longer listening");
        if (!type.secrets?.some((secret) => secret.name === name))
          throw new Error(`This agent type declares no secret named ${name}`);
        if (!this.control.secret)
          throw new Error(
            "Agent secrets are available only in the desktop app",
          );
        return this.control.secret(agent.id, name);
      },
      ...(type.workspace && agent.workspace && files
        ? {
            workspace: Object.freeze({
              path: agent.workspace,
              readFile: async (path: string) => {
                listening();
                return files.read(agent.id, path);
              },
              writeFile: async (path: string, content: string) => {
                listening();
                return files.write(agent.id, path, content);
              },
              list: async (path: string) => {
                listening();
                return files.list(agent.id, path);
              },
              exec: async (command: string, options?: WorkspaceExecOptions) => {
                listening();
                return files.exec(agent.id, command, {
                  ...options,
                  signal: AbortSignal.any([
                    controller.signal,
                    binding.signal,
                    ...(options?.signal ? [options.signal] : []),
                  ]),
                });
              },
            }),
          }
        : {}),
    });
    try {
      const message = type.validate?.(agent.plugin?.config);
      if (message) throw new Error(message);
      return {
        agent,
        type,
        binding,
        subscription: parseSubscription(
          type.subscription(agent.plugin?.config, identity),
        ),
        identity,
        controller,
        queue: [],
        seen,
        running: 0,
        controls: 0,
        stopping: false,
        sessionPolicy: this.sessionPolicy(agent, type),
        windowStart: 0,
        admitted: 0,
      };
    } catch (error) {
      console.error(`Agent subscription failed: ${agent.name}`, error);
      return { error: `Not listening: ${message(error)}` };
    }
  }

  private dispatch(batch: LiveBatch) {
    for (const instance of this.instances.values()) {
      const id = instance.agent.id;
      for (const event of batch.events) {
        // An agent never hears itself. Its owner and other agents are input.
        if (event.pubkey === instance.agent.pubkey) continue;
        if (
          !instance.subscription.some((filter) =>
            matchesEvent(event, { ...filter, limit: 0 }),
          )
        )
          continue;
        if (instance.seen.has(event.id)) continue;
        instance.seen.add(event.id);
        if (instance.seen.size > SEEN_LIMIT)
          instance.seen.delete(instance.seen.values().next().value as string);
        let control: "steer" | "stop" | undefined;
        try {
          control = instance.type.control?.(event, instance.identity);
        } catch (error) {
          this.count(id, (now) => ({
            ...now,
            errors: now.errors + 1,
            lastError: message(error),
          }));
          continue;
        }
        const now = Date.now();
        if (now - instance.windowStart >= RATE_WINDOW_MS) {
          instance.windowStart = now;
          instance.admitted = 0;
        }
        if (control && event.pubkey !== instance.identity.owner) {
          // Denials share ordinary admission's rate budget, never control slots.
          if (batch.channelId && instance.admitted < RATE_LIMIT) {
            instance.admitted++;
            void instance.identity
              .publish({
                kind: 9,
                content:
                  "Only the agent owner can steer, stop, or reset this agent. Send a regular mention to queue a request.",
                tags: [
                  ["h", batch.channelId],
                  [
                    "e",
                    threadReference(event)?.rootId ?? event.id,
                    "",
                    "reply",
                  ],
                ],
              })
              .catch(() => {});
          }
          this.count(id, (now) => ({ ...now, dropped: now.dropped + 1 }));
          continue;
        }
        if (control) {
          if (control === "stop" ? instance.stopping : instance.controls >= 2) {
            this.count(id, (now) => ({ ...now, dropped: now.dropped + 1 }));
            continue;
          }
          if (control === "stop") instance.stopping = true;
          else instance.controls++;
          void this.execute(instance, {
            event,
            ...(batch.channelId ? { channelId: batch.channelId } : {}),
          }).finally(() => {
            if (control === "stop") instance.stopping = false;
            else instance.controls--;
          });
          continue;
        }
        if (
          instance.queue.length >= QUEUE_LIMIT ||
          instance.admitted >= RATE_LIMIT
        ) {
          this.count(id, (now) => ({ ...now, dropped: now.dropped + 1 }));
          continue;
        }
        instance.admitted++;
        instance.queue.push({
          event,
          ...(batch.channelId ? { channelId: batch.channelId } : {}),
        });
        this.drain(instance);
      }
    }
  }

  // Each agent runs up to its type's `concurrency` at once, in arrival order;
  // different agents never wait on each other.
  private drain(instance: Instance) {
    while (
      instance.running < (instance.type.concurrency ?? 1) &&
      instance.queue.length &&
      !instance.controller.signal.aborted
    ) {
      const job = instance.queue.shift() as Job;
      instance.running++;
      void this.execute(instance, job).finally(() => {
        instance.running--;
        this.drain(instance);
      });
    }
  }

  private async execute(instance: Instance, job: Job) {
    const id = instance.agent.id;
    const channel = instance.binding.session.channels
      .list()
      .channels.find((item) => item.id === job.channelId);
    const root =
      instance.sessionPolicy === "thread" && channel?.channelType !== "dm"
        ? (threadReference(job.event)?.rootId ?? job.event.id)
        : undefined;
    const conversation = job.channelId
      ? Object.freeze({
          channelName: channel?.name ?? job.channelId,
          ...(root ? { threadRootId: root } : {}),
        })
      : undefined;
    const signal = AbortSignal.any([
      instance.controller.signal,
      AbortSignal.timeout(instance.type.timeoutMs ?? 30_000),
    ]);
    this.count(id, (now) => ({
      ...now,
      fired: now.fired + 1,
      lastFiredAt: Date.now(),
    }));
    // The view sits where a reply to the event lands: in its thread, or the one a
    // reply would start. It lasts exactly as long as the run.
    const view = job.channelId
      ? this.liveRuns.open({
          agent: Object.freeze({
            id,
            pubkey: instance.agent.pubkey,
            name: instance.agent.name,
          }),
          channelId: job.channelId,
          eventId: job.event.id,
          threadRootId: threadReference(job.event)?.rootId ?? job.event.id,
        })
      : undefined;
    try {
      // Race the deadline so a function that ignores `signal` cannot stall its queue.
      await Promise.race([
        Promise.resolve().then(() =>
          instance.type.run(
            Object.freeze({
              event: job.event,
              ...(job.channelId ? { channelId: job.channelId } : {}),
              ...(conversation ? { conversation } : {}),
              agent: instance.identity,
              config: instance.agent.plugin?.config,
              live: view?.live ?? noLive,
              cancelQueued: () => {
                instance.queue = instance.queue.filter(
                  (queued) =>
                    queued.channelId !== job.channelId ||
                    (root !== undefined &&
                      (threadReference(queued.event)?.rootId ??
                        queued.event.id) !== root),
                );
              },
              signal,
            }),
          ),
        ),
        new Promise<never>((_, reject) => {
          const fail = () => reject(signal.reason);
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        }),
      ]);
    } catch (error) {
      // Cancellation by stop, edit, disable or session swap is not an agent fault.
      if (instance.controller.signal.aborted) {
        const replacement = this.instances.get(id);
        if (
          instance.controller.signal.reason === "settings-changed" &&
          replacement?.binding === instance.binding &&
          job.channelId
        ) {
          // The old plugin stays revoked. The current identity owns this host notice.
          await replacement.identity
            .publish({
              kind: 9,
              content:
                "This request was interrupted because the agent settings changed. Send another mention to continue with the updated settings.",
              tags: [
                ["h", job.channelId],
                [
                  "e",
                  threadReference(job.event)?.rootId ?? job.event.id,
                  "",
                  "reply",
                ],
              ],
            })
            .catch(() => {});
        }
        return;
      }
      console.error(`Agent run failed: ${instance.agent.name}`, error);
      this.count(id, (now) => ({
        ...now,
        errors: now.errors + 1,
        lastError: message(error),
      }));
    } finally {
      view?.close();
    }
  }
}
