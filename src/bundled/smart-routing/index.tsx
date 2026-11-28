// Smart routing: when the owner sends a message in a channel, Jev decides
// who answers it (if it tags no one) and where the answer goes (for a
// top-level message), in one request when the message arrives. A reply in a
// thread stays in that thread. Untagged: the message is delivered to the
// picked agent as a mention (`deliverMention`), and the placement hook places
// it from the same decision. Tagged: the hook asks Jev where only. Both flows
// share one where path (`where.ts`).
import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { BuzzClient, BuzzEvent } from "../../buzz-mcp/client";
import { communityDestination } from "../../features/communities/destination";
import { openMetadata } from "../../features/relay/discovery";
import { relayPartition, splitPartition } from "../../features/relay/partition";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { RelayEvent } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type { Agent } from "../../features/agents/service";
import type { MentionPlacer } from "../../features/agents/mention-placement";
import type {
  DecisionAnswer,
  DecisionQuestion,
} from "../../features/decisions/service";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Header } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  ArrowRightIcon,
  SendIcon,
} from "../../shared/design-system/icons/index";
import styles from "./index.module.css";
import {
  buildState,
  ELSEWHERE_NOTE,
  oneLine,
  placementOf,
  placeText,
  speakingTo,
  WHERE_KEYS,
  WHERE_THRESHOLDS,
  WHO_THRESHOLD,
  decideWhere,
  whereQuestions,
  type ContextMessage,
  type Where,
} from "./where";

export const inject = ["relay", "agents", "decisions", "conversation"];

const STORE_KEY = "buzz.smart-routing.log.v2";
/** Entries kept on this device per account and community, newest last. */
const LOG_LIMIT = 300;
const CONTEXT_LIMIT = 10;
/** Decisions take at most 32 questions. */
const QUESTION_LIMIT = 32;
/** Under the host's 1s cap for a placed mention, so a slow Jev is logged
 * here as a timeout rather than dropped there. A direct call's p99 is about
 * 224ms. */
const PLACE_TIMEOUT_MS = 800;
/** Max wait for relay history when the loaded timeline lacks enough context. */
const CONTEXT_TIMEOUT_MS = 4000;
/** The untagged who + where call, which nothing waits on. */
const WHO_TIMEOUT_MS = 15000;
/** Waits before each retry of a delivery the host refused as `unavailable`. */
const WAKE_RETRY_DELAYS_MS = [3000, 7000];

export type Entry = Readonly<{
  id: string;
  at: number;
  channelId: string;
  channelName?: string;
  snippet: string;
  flow: "who" | "who+where" | "where";
  status: "picked" | "none" | "placed" | "failed" | "skipped";
  reason?: string;
  agent?: string;
  agentPubkey?: string;
  probability?: number;
  yes?: Readonly<Record<string, number>>;
  where?: Where;
  /** Where the reply goes: the picked agent's or the tagged agents'. */
  destination?: Readonly<{ topLevel: true } | { root: string }>;
  wake?: string;
  ms?: number;
}>;

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return communityDestination(value).url;
  } catch {
    return value.trim() || undefined;
  }
}

function scopeOf(
  origin: string | undefined,
  viewer: string | undefined,
): string | undefined {
  const normalized = originOf(origin);
  return normalized && viewer ? relayPartition(normalized, viewer) : undefined;
}

function readLog(scope: string): Entry[] {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`${STORE_KEY}:${scope}`) ?? "[]",
    );
    return Array.isArray(saved) ? (saved as Entry[]) : [];
  } catch {
    return [];
  }
}

export const apply: PluginModule["apply"] = (ctx) => {
  // ---- The log: partitioned by account and community ----
  const logs = new Map<string, Entry[]>();
  const listeners = new Set<() => void>();
  const logFor = (scope: string | undefined): Entry[] => {
    if (!scope) return [];
    let entries = logs.get(scope);
    if (!entries) {
      entries = readLog(scope);
      logs.set(scope, entries);
    }
    return entries;
  };
  const record = (scope: string | undefined, entry: Entry) => {
    if (!scope) return;
    const next = [
      ...logFor(scope).filter((item) => item.id !== entry.id),
      entry,
    ].slice(-LOG_LIMIT);
    logs.set(scope, next);
    try {
      localStorage.setItem(`${STORE_KEY}:${scope}`, JSON.stringify(next));
    } catch {
      // Keep it in memory.
    }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const entryOf = (scope: string | undefined, id: string) =>
    logFor(scope).find((item) => item.id === id);

  // ---- Shared: sessions, context and one Jev request ----

  const sessionScope = (
    session: RelaySession,
    origin?: string,
  ): string | undefined => {
    const raw = (session as { scope?: string }).scope;
    if (raw && raw !== "offline:" && raw !== "undefined:undefined") {
      const split = splitPartition(raw);
      if (split?.viewer) return scopeOf(split.communityOrigin, split.viewer);
    }
    const snap = ctx.relay.snapshot();
    const viewer =
      session.viewer ?? (snap.session === session ? snap.viewer : undefined);
    const resolvedOrigin =
      origin ?? (snap.session === session ? snap.origin : undefined);
    return scopeOf(resolvedOrigin, viewer);
  };

  const sessionFrom = (
    relay: RelayData | undefined,
    fallbackOrigin?: string,
  ) => {
    const snap = relay?.snapshot();
    if (snap?.status !== "ready" || !snap.session) return undefined;
    const viewer = snap.viewer ?? snap.session.viewer;
    if (!viewer) return undefined;
    const scope =
      (snap.scope &&
        snap.scope !== "offline:" &&
        snap.scope !== "undefined:undefined" &&
        (() => {
          const split = splitPartition(snap.scope);
          return split?.viewer
            ? scopeOf(split.communityOrigin, split.viewer)
            : undefined;
        })()) ||
      sessionScope(snap.session, snap.origin ?? fallbackOrigin);
    const origin =
      originOf(snap.origin ?? fallbackOrigin) ??
      (scope ? splitPartition(scope)?.communityOrigin : undefined);
    return {
      session: snap.session,
      viewer,
      origin,
      community: snap.origin ?? fallbackOrigin ?? origin,
      scope,
    };
  };

  const sessionNow = () => sessionFrom(ctx.relay);

  /** Up to CONTEXT_LIMIT earlier messages, oldest first: the thread's root
   * and latest replies, or the channel's top level with each message's
   * thread replies. The loaded timeline first; the relay for what it lacks. */
  async function readContext(
    session: RelaySession,
    event: RelayEvent,
    channelId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    const thread = threadReference(event);
    const at = eventMs(event);
    type Item = Readonly<{
      id: string;
      pubkey: string;
      ms: number;
      text: string;
      root: string | undefined;
    }>;
    const seen = new Map<string, Item>();
    const add = (items: readonly Item[]) => {
      for (const item of items)
        if (
          item.id !== event.id &&
          (item.ms < at || (item.ms === at && item.id < event.id))
        )
          seen.set(item.id, item);
    };
    const window = safe(() => session.channels.window(channelId));
    if (window)
      add(
        window.rows.map((row) => ({
          id: row.id,
          pubkey: row.authorId,
          ms: row.createdAtMs ?? row.createdAt * 1000,
          text: row.content,
          root: row.threadRootId,
        })),
      );
    const inThread = (item: Item) =>
      thread
        ? item.id === thread.rootId || item.root === thread.rootId
        : !item.root;
    const enough = () =>
      [...seen.values()].filter(inThread).length >= CONTEXT_LIMIT;
    const done =
      !thread && window?.status === "ready" && window.hasMore === false;
    if (!enough() && !done && timeoutMs > 0 && !signal?.aborted) {
      const kinds = [9, 40002];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const readSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let onAbort: (() => void) | undefined;
      try {
        const read = session.read(
          thread
            ? [
                { ids: [thread.rootId], limit: 1 },
                {
                  kinds,
                  "#h": [channelId],
                  "#e": [thread.rootId],
                  until: event.created_at,
                  limit: 50,
                },
              ]
            : [
                {
                  kinds,
                  "#h": [channelId],
                  until: event.created_at,
                  limit: 100,
                },
              ],
          { signal: readSignal },
        );
        void read.catch(() => {});
        const events = await Promise.race([
          read,
          new Promise<undefined>((resolve) => {
            if (readSignal.aborted) return resolve(undefined);
            onAbort = () => resolve(undefined);
            readSignal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        if (events)
          add(
            events.map((item) => ({
              id: item.id,
              pubkey: item.pubkey,
              ms: eventMs(item),
              text: messageText(item),
              root: threadReference(item)?.rootId,
            })),
          );
      } catch {
        // Decide from what the timeline has.
      } finally {
        clearTimeout(timer);
        if (onAbort) readSignal.removeEventListener("abort", onAbort);
      }
    }
    const sorted = [...seen.values()].sort((a, b) => a.ms - b.ms);
    const shown = sorted.filter(inThread);
    const messages = thread
      ? (() => {
          const root = shown.find((item) => item.id === thread.rootId);
          const replies = shown.filter((item) => item.id !== thread.rootId);
          return root
            ? [root, ...replies.slice(-(CONTEXT_LIMIT - 1))]
            : replies.slice(-CONTEXT_LIMIT);
        })()
      : shown.slice(-CONTEXT_LIMIT);
    return messages.map((item) => ({
      ...item,
      replies: thread ? [] : sorted.filter((reply) => reply.root === item.id),
    }));
  }

  /** Agents known in `origin` (or all if `origin` is unknown). */
  function communityAgents(origin: string | undefined) {
    const snap = ctx.agents.snapshot();
    const seen = new Map<string, Agent>();
    for (const agent of [...snap.running, ...snap.agents]) {
      if (origin && originOf(agent.relay) !== origin) continue;
      if (!seen.has(agent.key)) seen.set(agent.key, agent);
    }
    return [...seen.values()];
  }

  /** The owner's local agents running here, in the channel and community.
   * With `eligibleOnly`, keeps only agents this app copy can currently deliver
   * mentions to (active harness runner and custody). */
  function localAgents(
    members: readonly string[],
    viewer: string,
    origin: string | undefined,
    eligibleOnly = false,
  ) {
    const canDeliver = eligibleOnly
      ? ctx.agents.canDeliverMention?.bind(ctx.agents)
      : undefined;
    return ctx.agents
      .snapshot()
      .running.filter(
        (agent) =>
          agent.place === "here" &&
          (!origin || originOf(agent.relay) === origin) &&
          !agent.deleting &&
          !agent.unfinished &&
          agent.pubkey !== viewer &&
          members.includes(agent.pubkey) &&
          (!canDeliver || canDeliver(agent.key)),
      );
  }

  /** One Jev request: the where questions for a top-level message, and the
   * who questions for the agents in `ask`. Both flows come through here. */
  async function ask(
    session: RelaySession,
    viewer: string,
    origin: string | undefined,
    community: string | undefined,
    event: RelayEvent,
    channel: Readonly<{
      id: string;
      name: string;
      description?: string | undefined;
      members: readonly string[];
    }>,
    ask: readonly Agent[],
    tagging: readonly Agent[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    if (signal?.aborted) return { failed: "cancelled", ms: 0 } as const;
    const thread = threadReference(event);
    const profiles = safe(() => session.profiles.snapshot());
    const all = communityAgents(origin);
    const isAgent = (pubkey: string) =>
      all.some((agent) => agent.pubkey === pubkey) ||
      safe(() => profiles?.get(pubkey)?.isAgent) === true;
    const nameOf = (pubkey: string) => {
      const name =
        all.find((agent) => agent.pubkey === pubkey)?.name ||
        safe(() => profiles?.get(pubkey)?.name) ||
        pubkey.slice(0, 8);
      if (pubkey === viewer) return `${name} (owner)`;
      return isAgent(pubkey) ? `${name} (agent)` : name;
    };
    const owner = safe(() => profiles?.get(viewer)?.name) || "the owner";
    // Reserve at least half the budget for Jev so a slow relay read falls back
    // to cached context instead of eating the whole placement deadline.
    const contextBudgetMs = Math.min(
      CONTEXT_TIMEOUT_MS,
      Math.floor(remaining() / 2),
    );
    const earlier: ContextMessage[] = (
      await readContext(session, event, channel.id, contextBudgetMs, signal)
    ).map((item) => ({
      id: item.id,
      from: nameOf(item.pubkey),
      ms: item.ms,
      text: item.text,
      replies: item.replies.map((reply) => ({
        from: nameOf(reply.pubkey),
        ms: reply.ms,
        text: reply.text,
      })),
    }));
    if (signal?.aborted)
      return { failed: "cancelled", ms: Date.now() - started } as const;
    const decideBudgetMs = remaining();
    if (decideBudgetMs <= 0)
      return { failed: "timeout", ms: Date.now() - started } as const;
    const humans = channel.members.filter((pubkey) => !isAgent(pubkey)).length;
    const { state, labels, recent } = buildState({
      owner,
      channelName: channel.name,
      about: channel.description,
      humans,
      agents: channel.members.length - humans,
      atMs: eventMs(event),
      earlier,
      from: nameOf(viewer),
      tagging: tagging.map((agent) => agent.name),
      ...(thread ? { inThread: true } : {}),
      text: messageText(event),
    });
    const asksWhere = !thread;
    const who = new Map<string, Agent>();
    for (const agent of ask.slice(0, QUESTION_LIMIT - WHERE_KEYS.length)) {
      let key = (agent.name || agent.pubkey.slice(0, 8)).trim().slice(0, 50);
      if (
        !key ||
        who.has(key) ||
        (WHERE_KEYS as readonly string[]).includes(key)
      )
        key = `${key || "agent"} (${agent.pubkey.slice(0, 6)})`;
      who.set(key, agent);
    }
    const questions: Record<string, DecisionQuestion> = {
      ...(asksWhere ? whereQuestions(recent) : {}),
      ...Object.fromEntries(
        [...who].map(([key, agent]) => [
          key,
          speakingTo(owner, agent.name || key),
        ]),
      ),
    };
    const billingCommunity = (tagging[0] ?? ask[0])?.relay ?? community;
    // The decisions service waits at least 1s; the placement deadline is
    // shorter, so abort the request through its signal when either the budget
    // or caller/scope signal ends.
    const decideTimeout = new AbortController();
    const decideSignal = signal
      ? AbortSignal.any([signal, decideTimeout.signal])
      : decideTimeout.signal;
    const timer = setTimeout(() => decideTimeout.abort(), decideBudgetMs);
    let onAbort: (() => void) | undefined;
    const decide = ctx.decisions.decide(
      {
        state,
        questions,
        timeoutMs: decideBudgetMs,
        ...(billingCommunity ? { community: billingCommunity } : {}),
      },
      { signal: decideSignal },
    );
    void decide.catch(() => {});
    const result = await Promise.race([
      decide,
      new Promise<{ outcome: "failed"; reason: "timeout" | "cancelled" }>(
        (resolve) => {
          const done = () =>
            resolve({
              outcome: "failed",
              reason: signal?.aborted ? "cancelled" : "timeout",
            });
          if (decideSignal.aborted) return done();
          onAbort = done;
          decideSignal.addEventListener("abort", onAbort, { once: true });
        },
      ),
    ]).finally(() => {
      clearTimeout(timer);
      if (onAbort) decideSignal.removeEventListener("abort", onAbort);
    });
    const ms = Date.now() - started;
    if (signal?.aborted) return { failed: "cancelled", ms } as const;
    if (decideTimeout.signal.aborted && result.outcome !== "answered")
      return { failed: "timeout", ms } as const;
    if (result.outcome !== "answered")
      return { failed: result.reason, ms } as const;
    const answers: Readonly<Record<string, DecisionAnswer>> = result.answers;
    return {
      ms,
      where: asksWhere ? decideWhere(answers, labels) : undefined,
      yes: Object.fromEntries(
        [...who.keys()].flatMap((key) => {
          const answer = answers[key];
          return answer?.type === "yes_no" ? [[key, answer.probability]] : [];
        }),
      ) as Record<string, number>,
      who,
    } as const;
  }

  const channelOf = (session: RelaySession, id: string) => {
    const channel = safe(() =>
      session.channels.list().channels.find((item) => item.id === id),
    );
    if (
      !channel?.members ||
      channel.huddle ||
      ["dm", "solo", "system"].includes(channel.channelType ?? "stream")
    )
      return undefined;
    return { ...channel, members: channel.members };
  };
  const base = (event: RelayEvent, channelId: string, name?: string) => ({
    id: event.id,
    at: Date.now(),
    channelId,
    ...(name ? { channelName: name } : {}),
    snippet: oneLine(messageText(event), 160),
  });

  // ---- Tagged: place the tagged agents' replies ----
  //
  // Asked by the host before a tagged agent's turn starts, once per agent;
  // agents tagged together share one decision. No composer check: the host
  // asks only about the owner's own mentions.
  // Each message's where decision, shared by the agents it reaches: tagged
  // together, or picked by Jev and then asked about by the host.
  type PendingPlace = {
    promise: Promise<Where | undefined>;
    controller?: AbortController | undefined;
    waiters?: number;
  };
  const placing = new Map<string, PendingPlace>();
  const placeKey = (scope: string | undefined, id: string) =>
    `${scope ?? ""}:${id}`;
  const remember = (key: string, entry: PendingPlace) => {
    placing.set(key, entry);
    if (placing.size > 200) {
      const oldest = placing.keys().next().value;
      if (oldest) placing.delete(oldest);
    }
  };
  const createPlacer = (scopeSignal: AbortSignal): MentionPlacer => ({
    id: "where",
    async place({ agent, channel: channelId, event }, signal) {
      const callerSignal = AbortSignal.any([signal, scopeSignal]);
      if (callerSignal.aborted || threadReference(event)) return undefined;
      const agentRecord = ctx.agents
        .snapshot()
        .running.find((item) => item.key === agent);
      const boundRelay =
        typeof ctx.agents.relay === "function"
          ? ctx.agents.relay(agent)
          : ctx.relay;
      const now = sessionFrom(boundRelay, agentRecord?.relay);
      if (!now || event.pubkey !== now.viewer) return undefined;
      const key = placeKey(now.scope, event.id);
      let pending = placing.get(key);
      if (!pending || pending.controller?.signal.aborted) {
        const controller = new AbortController();
        const entry: PendingPlace = {
          controller,
          waiters: 0,
          promise: Promise.resolve(undefined),
        };
        entry.promise = placeOnce(
          now.session,
          now.viewer,
          now.origin,
          agentRecord?.relay ?? now.community,
          now.scope,
          event,
          channelId,
          controller.signal,
        ).finally(() => {
          entry.controller = undefined;
          if (controller.signal.aborted && placing.get(key) === entry)
            placing.delete(key);
        });
        pending = entry;
        remember(key, entry);
      }
      const current = pending;
      const controller = current.controller;
      if (controller) current.waiters = (current.waiters ?? 0) + 1;
      let onAbort: (() => void) | undefined;
      const where = await Promise.race([
        current.promise,
        new Promise<undefined>((resolve) => {
          onAbort = () => {
            if (controller && current.controller === controller) {
              current.waiters = Math.max(0, (current.waiters ?? 1) - 1);
              if (current.waiters === 0) {
                if (placing.get(key) === current) placing.delete(key);
                controller.abort();
              }
            }
            resolve(undefined);
          };
          if (callerSignal.aborted) {
            onAbort();
            return;
          }
          callerSignal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => {
        if (onAbort) callerSignal.removeEventListener("abort", onAbort);
      });
      if (!where || callerSignal.aborted) return undefined;
      return {
        ...placementOf(where.destination, event.id),
        ...(where.elsewhere ? { note: ELSEWHERE_NOTE } : {}),
      };
    },
  });
  async function placeOnce(
    session: RelaySession,
    viewer: string,
    origin: string | undefined,
    community: string | undefined,
    scope: string | undefined,
    event: RelayEvent,
    channelId: string,
    signal: AbortSignal,
  ): Promise<Where | undefined> {
    const channel = channelOf(session, channelId);
    const entry = base(event, channelId, channel?.name);
    if (!channel) {
      record(scope, {
        ...entry,
        flow: "where",
        status: "skipped",
        reason: "not a channel",
      });
      return undefined;
    }
    const tagged = new Set(
      event.tags.flatMap(([name, value]) =>
        name === "p" && value ? [value] : [],
      ),
    );
    const tagging = localAgents(channel.members, viewer, origin).filter(
      (agent) => tagged.has(agent.pubkey),
    );
    const decided = await ask(
      session,
      viewer,
      origin,
      community,
      event,
      channel,
      [],
      tagging,
      PLACE_TIMEOUT_MS,
      signal,
    );
    if ("failed" in decided || !decided.where) {
      record(scope, {
        ...entry,
        flow: "where",
        status: "failed",
        reason:
          "failed" in decided
            ? decided.failed === "cancelled"
              ? "placement cancelled"
              : `Jev ${decided.failed}`
            : "no usable where answers",
        ms: decided.ms,
      });
      return undefined;
    }
    record(scope, {
      ...entry,
      flow: "where",
      status: "placed",
      where: decided.where,
      destination: placementOf(decided.where.destination, event.id),
      ms: decided.ms,
    });
    return decided.where;
  }

  // ---- Untagged: pick who answers, and deliver the message to them ----

  const handled = new Set<string>();
  const startedAt = Math.floor(Date.now() / 1000);
  /** Watches the owner's messages and wakes the agent Jev picks. */
  const watchSends = (scopeSignal: AbortSignal) => () => {
    let bound: RelaySession | undefined;
    let unbind: (() => void) | undefined;
    const bind = () => {
      const now = sessionNow();
      if (now?.session === bound) return;
      unbind?.();
      unbind = undefined;
      bound = now?.session;
      if (!now) return;
      unbind = now.session.subscribeLive((batch) => {
        if (scopeSignal.aborted) return;
        for (const event of batch.events) {
          const handledKey = placeKey(now.scope, event.id);
          if (
            event.kind === 9 &&
            event.pubkey === now.viewer &&
            !handled.has(handledKey) &&
            event.created_at >= startedAt - 60
          ) {
            handled.add(handledKey);
            if (handled.size > 2000) {
              const oldest = handled.values().next().value;
              if (oldest) handled.delete(oldest);
            }
            const channelId =
              event.tags.find(([name]) => name === "h")?.[1] ?? batch.channelId;
            if (channelId)
              void route(
                now.session,
                now.viewer,
                now.origin,
                now.community,
                now.scope,
                event,
                channelId,
                scopeSignal,
              ).catch((error: unknown) =>
                console.error("[smart-routing]", error),
              );
          }
        }
      });
    };
    const stop = ctx.relay.subscribe(bind);
    bind();
    return () => {
      stop();
      unbind?.();
    };
  };

  // ---- Routing runs only while decisions can be answered ----
  //
  // Cordis adds the hook and the watch when the decisions service says they
  // can, and removes them when it withdraws that; until then the plugin does
  // nothing and messages go where they always have. Not in the module's
  // `inject`, where a device without a provider would fail its startup.
  let answerable = false;
  const answerableListeners = new Set<() => void>();
  const setAnswerable = (next: boolean) => {
    answerable = next;
    for (const listener of answerableListeners) listener();
  };
  ctx.inject(["decisionsAnswerable"], (scope) => {
    const scopeAbort = new AbortController();
    scope.effect(() => {
      setAnswerable(true);
      return () => {
        scopeAbort.abort();
        setAnswerable(false);
      };
    });
    scope.agents.registerMentionPlacement?.(createPlacer(scopeAbort.signal));
    scope.effect(watchSends(scopeAbort.signal));
  });
  // Its card says whether it is routing, or why not.
  ctx.inject(["settingsCards"], (scope) => {
    scope.settingsCards.register({
      id: "status",
      title: "Smart routing",
      icon: SendIcon,
      group: "Plugins",
      component: () => (
        <RoutingStatus
          answerable={() => answerable}
          subscribe={(listener) => {
            answerableListeners.add(listener);
            return () => void answerableListeners.delete(listener);
          }}
        />
      ),
    });
  });

  async function route(
    session: RelaySession,
    viewer: string,
    origin: string | undefined,
    community: string | undefined,
    scope: string | undefined,
    event: RelayEvent,
    channelId: string,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return;
    // Tagged messages are the placement hook's.
    if (event.tags.some(([name]) => name === "p")) return;
    const channel = channelOf(session, channelId);
    if (!channel) return;
    const candidates = localAgents(channel.members, viewer, origin, true);
    if (!candidates.length) return;
    const thread = threadReference(event);
    const entry = {
      ...base(event, channelId, channel.name),
      flow: thread ? "who" : "who+where",
    } as const;
    // Only messages the owner typed in this app copy.
    if (!(await confirmedOwnerSend(session, event, channelId, signal))) {
      if (signal.aborted) return;
      record(scope, {
        ...entry,
        status: "skipped",
        reason: "not sent from this app's composer",
      });
      return;
    }
    if (signal.aborted) return;
    const decided = await ask(
      session,
      viewer,
      origin,
      community,
      event,
      channel,
      candidates,
      [],
      WHO_TIMEOUT_MS,
      signal,
    );
    // Jev down or routing scope ended: no one is woken, as without the plugin.
    if ("failed" in decided) {
      if (signal.aborted || decided.failed === "cancelled") return;
      record(scope, {
        ...entry,
        status: "failed",
        reason: `Jev ${decided.failed}`,
        ms: decided.ms,
      });
      return;
    }
    if (signal.aborted) return;
    const ranked = Object.entries(decided.yes).sort((a, b) => b[1] - a[1]);
    const [top, probability = 0] = ranked[0] ?? [];
    const decision = {
      ...entry,
      yes: decided.yes,
      ...(decided.where ? { where: decided.where } : {}),
      ms: decided.ms,
    };
    const tie = ranked.filter(([, p]) => p === probability).length > 1;
    const agent = top === undefined ? undefined : decided.who.get(top);
    if (!agent || !(probability > WHO_THRESHOLD) || tie) {
      record(scope, {
        ...decision,
        status: "none",
        ...(top ? { agent: top, probability } : {}),
        ...(tie ? { reason: "tie at the top" } : {}),
      });
      return;
    }
    // In a thread, that thread. At the top level, where Jev placed it, or a
    // thread on the message when it could not.
    const destination = thread
      ? { root: thread.rootId }
      : decided.where
        ? placementOf(decided.where.destination, event.id)
        : { root: event.id };
    const picked = {
      ...decision,
      status: "picked",
      agent: agent.name,
      agentPubkey: agent.pubkey,
      probability,
      destination,
    } as const;
    record(scope, { ...picked, wake: "waking" });
    // The placement hook answers this message's place from the decision
    // already made, with no second Jev call.
    if (!thread)
      remember(placeKey(scope, event.id), {
        promise: Promise.resolve(decided.where),
      });
    const deliver = ctx.agents.deliverMention;
    if (!deliver) {
      record(scope, {
        ...picked,
        wake: "failed: this app can't deliver mentions",
      });
      return;
    }
    // Delivered as if the owner had tagged it: the agent sees the owner's
    // request, placed where the decision put it.
    const note = `${safe(() => session.profiles.snapshot().get(viewer)?.name) || "The owner"} tagged no one in this message. Smart routing delivered it to you: Jev picked you (${pct(probability)}). Handle it if it is yours to do; if it is not, end the turn without posting.`;
    let wake = "";
    for (let attempt = 0; ; attempt++) {
      // Bound to the provider scope that started this decision.
      if (signal.aborted) {
        wake = "dropped: routing stopped";
        break;
      }
      try {
        const sent = await deliver.call(ctx.agents, agent.key, event, { note });
        wake =
          sent.status === "delivered" ? "delivered" : `dropped: ${sent.reason}`;
      } catch (error) {
        wake = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const delay = WAKE_RETRY_DELAYS_MS[attempt];
      if (wake !== "dropped: unavailable" || delay === undefined) break;
      record(scope, { ...picked, wake: "retrying" });
      if (!(await sleep(delay, signal))) {
        wake = "dropped: routing stopped";
        break;
      }
    }
    record(scope, { ...picked, wake });
  }

  async function confirmedOwnerSend(
    session: RelaySession,
    event: RelayEvent,
    channelId: string,
    signal: AbortSignal,
  ) {
    const mentions = session.ownerMentions;
    if (!mentions) return true;
    const thread = threadReference(event);
    const places = [
      ...new Set([
        thread?.rootId ?? null,
        thread?.parentId ?? null,
        null,
        event.id,
      ]),
    ];
    // Evidence lands after the relay acknowledges the send.
    for (const delay of [0, 300, 800, 1500, 3000]) {
      if (delay && !(await sleep(delay, signal))) return false;
      if (signal.aborted) return false;
      for (const rootId of places)
        if (
          safe(() =>
            mentions.confirmedOwnerSends({ channelId, rootId }, [event.id]),
          )?.includes(event.id)
        )
          return true;
    }
    return false;
  }

  // ---- What the owner sees ----

  const noopSubscribe = () => () => {};

  function isInspectable(entry: Entry | undefined) {
    if (!entry) return false;
    return (
      entry.status === "picked" ||
      (entry.status === "placed" && !!entry.where) ||
      entry.status === "none" ||
      entry.status === "failed"
    );
  }

  function isUndelivered(entry: Entry) {
    return Boolean(
      entry.wake &&
        !["delivered", "waking", "retrying", "dropped: watched"].includes(
          entry.wake,
        ),
    );
  }

  const useEntry = (scope: string | undefined, id: string) =>
    useSyncExternalStore(subscribe, () => entryOf(scope, id));

  function Marker({
    message,
    session,
  }: {
    message: { id: string };
    session: RelaySession;
  }) {
    const scope = sessionScope(session);
    const origin = scope ? splitPartition(scope)?.communityOrigin : undefined;
    const entry = useEntry(scope, message.id);
    const active = entry?.status === "picked";
    const agentsSub =
      active && typeof ctx.agents.subscribe === "function"
        ? ctx.agents.subscribe
        : noopSubscribe;
    const profilesSub =
      active && typeof session.profiles?.subscribe === "function"
        ? session.profiles.subscribe
        : noopSubscribe;
    const matchedAgent = useSyncExternalStore(agentsSub, () =>
      active
        ? safe(() =>
            communityAgents(origin).find((agent) =>
              entry.agentPubkey
                ? agent.pubkey === entry.agentPubkey
                : agent.name === entry.agent,
            ),
          )
        : undefined,
    );
    const pubkey = entry?.agentPubkey ?? matchedAgent?.pubkey;
    const profile = useSyncExternalStore(profilesSub, () =>
      active && pubkey
        ? safe(() => session.profiles.snapshot().get(pubkey))
        : undefined,
    );
    if (!active) return null;

    const name = profile?.name || matchedAgent?.name || entry.agent || "Agent";
    const src = avatarMedia(
      profile?.picture || matchedAgent?.picture,
      session.media,
    );
    const undelivered = isUndelivered(entry);

    return (
      <span
        className={styles.marker}
        data-undelivered={undelivered ? "true" : undefined}
        role="img"
        aria-label={
          undelivered ? `Routed to ${name}, not delivered` : `Routed to ${name}`
        }
      >
        <ArrowRightIcon size={13} className={styles.arrow} />
        <span className={styles.avatar} aria-hidden="true">
          <Avatar
            src={src}
            alt=""
            fallback={name}
            size="tiny"
            shape="squircle"
          />
          {undelivered && <span className={styles.warningDot} />}
        </span>
      </span>
    );
  }
  ctx.conversation.registerMessageAction({
    id: "smart-routing",
    title: "Smart routing",
    matches: (message, session) =>
      isInspectable(entryOf(sessionScope(session), message.id)),
    subscribe,
    component: ({ message, session, close }) => {
      const entry = useEntry(sessionScope(session), message.id);
      return (
        <Dialog
          size="compact"
          open
          onOpenChange={(open) => !open && close()}
          title="Smart routing"
        >
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {entry ? details(entry) : "No decision for this message."}
          </p>
        </Dialog>
      );
    },
    marker: Marker,
  });

  ctx.agents.addTool({
    name: "smart_routing_log",
    description:
      "Smart routing: the owner's recent routing decisions in this community for channels you can currently read, newest first: who Jev picked (each agent's yes), where the reply went (each where answer, the thresholds, the rule's reason and the destination), or why nothing happened.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 300 },
        channel_id: { type: "string" },
      },
    },
    async call(client, _context, args) {
      const { limit, channel_id } = (args ?? {}) as {
        limit?: number;
        channel_id?: string;
      };
      const caller = callerScope(ctx.agents.snapshot(), client);
      const scoped = caller ? logFor(caller) : [];
      const channelIds = [...new Set(scoped.map((entry) => entry.channelId))];
      const readable = channelIds.length
        ? await readableChannels(client, channelIds)
        : new Set<string>();
      const allowed = scoped.filter((entry) => readable.has(entry.channelId));
      const entries = allowed
        .filter((entry) => !channel_id || entry.channelId === channel_id)
        .slice(-Math.min(300, Math.max(1, Number(limit) || 20)))
        .reverse();
      return JSON.stringify(
        {
          thresholds: { who: WHO_THRESHOLD, ...WHERE_THRESHOLDS },
          timeouts: timeouts(allowed),
          entries,
        },
        null,
        2,
      );
    },
  });
};

/** The settings card: routing, or idle until decisions can be answered. */
export function RoutingStatus({
  answerable,
  subscribe,
}: {
  answerable(): boolean;
  subscribe(listener: () => void): () => void;
}) {
  const on = useSyncExternalStore(subscribe, answerable);
  return (
    <section aria-label="Smart routing settings">
      <Header title="Smart routing" />
      <SettingsGroup>
        <PreferenceRow
          title={on ? "Routing your messages" : "Needs a decisions provider"}
          subtitle={
            on
              ? "Jev picks who answers a message you tag no one in, and whether a top-level message is answered at the top level or in a thread."
              : "It does nothing until decisions can be answered. Sign in to Builderlab with decisions, or add a TypeSafe key, under Decisions API."
          }
        />
      </SettingsGroup>
    </section>
  );
}

/** How often Jev missed the placement deadline (PLACE_TIMEOUT_MS) among the
 * tagged messages it was asked about, and how often the who + where call
 * timed out, through whichever provider answers here. */
export function timeouts(entries: readonly Entry[]) {
  const count = (flow: Entry["flow"]) => {
    const asked = entries.filter(
      (entry) => entry.flow === flow && entry.status !== "skipped",
    );
    return {
      asked: asked.length,
      timedOut: asked.filter((entry) => entry.reason === "Jev timeout").length,
    };
  };
  return {
    placeMs: PLACE_TIMEOUT_MS,
    place: count("where"),
    whoAndWhere: count("who+where"),
  };
}

/** The dialog: every answer behind a decision. */
export function details(entry: Entry) {
  const lines = [
    `${entry.flow}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`,
  ];
  if (entry.yes && Object.keys(entry.yes).length)
    lines.push(
      `Who: ${Object.entries(entry.yes)
        .sort((a, b) => b[1] - a[1])
        .map(([name, p]) => `${name} ${pct(p)}`)
        .join(" · ")}`,
    );
  if (entry.where) {
    const a = entry.where.answers;
    lines.push(
      `Where: ${placeText(entry.where.destination)} (${entry.where.why})${entry.where.elsewhere ? "; the message may ask for another place" : ""}`,
      `Answers: working ${pct(a.working)} · moved on ${pct(a.moved_on)} · target ${a.target} · asks top ${pct(a.ask_top)} · asks thread ${pct(a.ask_thread)} · asks elsewhere ${pct(a.ask_elsewhere)}`,
    );
  }
  if (entry.wake) lines.push(`Wake: ${entry.wake}`);
  if (entry.ms !== undefined) lines.push(`Jev: ${entry.ms}ms`);
  return lines.join("\n");
}

function eventMs(event: Pick<RelayEvent, "tags" | "created_at">) {
  const value = event.tags.find(([name]) => name === "ms")?.[1];
  return (
    event.created_at * 1000 +
    (value && /^\d{1,3}$/.test(value) ? Number(value) : 0)
  );
}
function messageText(event: Pick<RelayEvent, "kind" | "content">) {
  if (event.kind === 40002)
    try {
      const body = JSON.parse(event.content) as { content?: unknown };
      if (typeof body.content === "string") return body.content;
    } catch {
      // The raw content.
    }
  return event.content;
}
function pct(p: number | undefined) {
  return typeof p === "number" ? `${Math.round(p * 100)}%` : "";
}
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function callerScope(
  snapshot: Readonly<{ agents: readonly Agent[]; running: readonly Agent[] }>,
  client: Pick<BuzzClient, "key" | "pubkey" | "owner">,
): string | undefined {
  if (!client.owner) return undefined;
  const agent = [...snapshot.running, ...snapshot.agents].find(
    (item) =>
      item.key === client.key &&
      item.pubkey === client.pubkey &&
      item.owner === client.owner,
  );
  return agent ? scopeOf(agent.relay, agent.owner) : undefined;
}

const CHANNEL_AUTH_BATCH = 100;

/** The channel IDs in `channelIds` that `client` is currently authorized to
 * read on its relay: either listed on the relay-signed roster (39002) or
 * explicitly open in relay-signed metadata (39000). Fails closed when the
 * relay authority is unknown. */
async function readableChannels(
  client: BuzzClient,
  channelIds: readonly string[],
): Promise<Set<string>> {
  const readable = new Set<string>();
  const authority = client.relayAuthor ?? (await client.relayAuthorLookup?.());
  if (!authority) return readable;
  const tagValue = (event: BuzzEvent, name: string) =>
    event.tags.find(([key]) => key === name)?.[1];
  const newer = (prev: BuzzEvent | undefined, next: BuzzEvent) =>
    !prev ||
    next.created_at > prev.created_at ||
    (next.created_at === prev.created_at && next.id < prev.id)
      ? next
      : prev;
  for (let i = 0; i < channelIds.length; i += CHANNEL_AUTH_BATCH) {
    client.signal?.throwIfAborted();
    const chunk = channelIds.slice(i, i + CHANNEL_AUTH_BATCH);
    const events = await client.query([
      {
        kinds: [39002],
        authors: [authority],
        "#d": chunk,
        "#p": [client.pubkey],
        consistency: "strong",
      },
      {
        kinds: [39000],
        authors: [authority],
        "#d": chunk,
        consistency: "strong",
      },
    ]);
    client.signal?.throwIfAborted();
    const rosters = new Map<string, BuzzEvent>();
    const metadata = new Map<string, BuzzEvent>();
    for (const event of events) {
      if (event.pubkey !== authority) continue;
      const id = tagValue(event, "d");
      if (!id || !chunk.includes(id)) continue;
      if (event.kind === 39002) rosters.set(id, newer(rosters.get(id), event));
      else if (event.kind === 39000)
        metadata.set(id, newer(metadata.get(id), event));
    }
    for (const id of chunk) {
      const roster = rosters.get(id);
      if (
        roster?.tags.some(
          ([name, value]) => name === "p" && value === client.pubkey,
        )
      ) {
        readable.add(id);
        continue;
      }
      const meta = metadata.get(id);
      if (meta && openMetadata(meta as unknown as RelayEvent)) readable.add(id);
    }
  }
  return readable;
}
