// Smart routing: when the owner sends a message in a channel, Jev decides
// who answers it (if it tags no one) and where the answer goes (for a
// top-level message), in one request when the message arrives. A reply in a
// thread stays in that thread. Untagged: the picked agent is woken there.
// Tagged: the tagged agents' turns are placed there through the mention
// placement hook. Both flows share one where path (`where.ts`).
import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import type { RelayEvent } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type { Agent } from "../../features/agents/service";
import type {
  DecisionAnswer,
  DecisionQuestion,
} from "../../features/decisions/service";
import { Dialog } from "../../shared/design-system/ui/Dialog";
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
  wherePrompt,
  type ContextMessage,
  type Where,
} from "./where";

export const inject = ["relay", "agents", "decisions", "conversation"];

const STORE_KEY = "buzz.smart-routing.log.v1";
/** Entries kept on this device, newest last. */
const LOG_LIMIT = 300;
const CONTEXT_LIMIT = 10;
/** Decisions take at most 32 questions. */
const QUESTION_LIMIT = 32;
/** Under the host's 3s cap for a placed mention, so a slow Jev is logged
 * here as a timeout rather than dropped there. */
const PLACE_TIMEOUT_MS = 2500;
const WAKE_TIMEOUT_MS = 15000;
/** Waits before each retry of a wake the host refused as `unavailable`. */
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
  probability?: number;
  yes?: Readonly<Record<string, number>>;
  where?: Where;
  /** Where the reply was sent (wake) or placed (mention). */
  destination?: Readonly<{ topLevel: true } | { root: string }>;
  wake?: string;
  ms?: number;
}>;

function readLog(): Entry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(saved) ? (saved as Entry[]) : [];
  } catch {
    return [];
  }
}

export const apply: PluginModule["apply"] = (ctx) => {
  // ---- The log: marks read it, and agents read it through a tool ----
  let log = readLog();
  const listeners = new Set<() => void>();
  const record = (entry: Entry) => {
    log = [...log.filter((item) => item.id !== entry.id), entry].slice(
      -LOG_LIMIT,
    );
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(log));
    } catch {
      // Keep it in memory.
    }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const entryOf = (id: string) => log.find((item) => item.id === id);

  // ---- Shared: the context and one Jev request ----

  const sessionNow = () => {
    const snap = ctx.relay.snapshot();
    return snap.status === "ready" && snap.session
      ? { session: snap.session, viewer: snap.viewer ?? snap.session.viewer }
      : undefined;
  };

  /** Up to CONTEXT_LIMIT earlier messages, oldest first: the thread's root
   * and latest replies, or the channel's top level with each message's
   * thread replies. The loaded timeline first; the relay for what it lacks. */
  async function readContext(
    session: RelaySession,
    event: RelayEvent,
    channelId: string,
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
    if (!enough() && !done) {
      const kinds = [9, 40002];
      try {
        const events = await session.read(
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
          { signal: AbortSignal.timeout(4000) },
        );
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

  /** The owner's local agents running here, in the channel. */
  function localAgents(members: readonly string[], viewer: string) {
    const agents = ctx.agents.snapshot();
    const running = new Set(agents.running.map((agent) => agent.key));
    return agents.agents.filter(
      (agent) =>
        agent.place === "here" &&
        running.has(agent.key) &&
        !agent.deleting &&
        !agent.unfinished &&
        agent.pubkey !== viewer &&
        members.includes(agent.pubkey),
    );
  }

  /** One Jev request: the where questions for a top-level message, and the
   * who questions for the agents in `ask`. Both flows come through here. */
  async function ask(
    session: RelaySession,
    viewer: string,
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
  ) {
    const started = Date.now();
    const thread = threadReference(event);
    const profiles = safe(() => session.profiles.snapshot());
    const all = ctx.agents.snapshot().agents;
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
    const earlier: ContextMessage[] = (
      await readContext(session, event, channel.id)
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
    const community =
      (tagging[0] ?? ask[0])?.relay ?? ctx.relay.snapshot().origin;
    const result = await ctx.decisions.decide({
      state,
      questions,
      timeoutMs,
      ...(community ? { community } : {}),
    });
    const ms = Date.now() - started;
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
  const placing = new Map<string, Promise<Where | undefined>>();
  ctx.agents.registerMentionPlacement?.({
    id: "where",
    async place({ channel: channelId, event }) {
      const now = sessionNow();
      if (!now || event.pubkey !== now.viewer || threadReference(event))
        return undefined;
      let decided = placing.get(event.id);
      if (!decided) {
        decided = placeOnce(now.session, now.viewer, event, channelId);
        placing.set(event.id, decided);
        if (placing.size > 200) {
          const oldest = placing.keys().next().value;
          if (oldest) placing.delete(oldest);
        }
      }
      const where = await decided;
      if (!where) return undefined;
      return {
        ...placementOf(where.destination, event.id),
        ...(where.elsewhere ? { note: ELSEWHERE_NOTE } : {}),
      };
    },
  });
  async function placeOnce(
    session: RelaySession,
    viewer: string,
    event: RelayEvent,
    channelId: string,
  ): Promise<Where | undefined> {
    const channel = channelOf(session, channelId);
    const entry = base(event, channelId, channel?.name);
    if (!channel) {
      record({
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
    const tagging = localAgents(channel.members, viewer).filter((agent) =>
      tagged.has(agent.pubkey),
    );
    const decided = await ask(
      session,
      viewer,
      event,
      channel,
      [],
      tagging,
      PLACE_TIMEOUT_MS,
    );
    if ("failed" in decided || !decided.where) {
      record({
        ...entry,
        flow: "where",
        status: "failed",
        reason:
          "failed" in decided
            ? `Jev ${decided.failed}`
            : "no usable where answers",
        ms: decided.ms,
      });
      return undefined;
    }
    record({
      ...entry,
      flow: "where",
      status: "placed",
      where: decided.where,
      destination: placementOf(decided.where.destination, event.id),
      ms: decided.ms,
    });
    return decided.where;
  }

  // ---- Untagged: pick who answers, and wake them where it goes ----

  const handled = new Set<string>();
  const startedAt = Math.floor(Date.now() / 1000);
  ctx.effect(() => {
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
        for (const event of batch.events)
          if (
            event.kind === 9 &&
            event.pubkey === now.viewer &&
            !handled.has(event.id) &&
            event.created_at >= startedAt - 60
          ) {
            handled.add(event.id);
            if (handled.size > 2000) {
              const oldest = handled.values().next().value;
              if (oldest) handled.delete(oldest);
            }
            const channelId =
              event.tags.find(([name]) => name === "h")?.[1] ?? batch.channelId;
            if (channelId)
              void route(now.session, now.viewer, event, channelId).catch(
                (error: unknown) => console.error("[smart-routing]", error),
              );
          }
      });
    };
    const stop = ctx.relay.subscribe(bind);
    bind();
    return () => {
      stop();
      unbind?.();
    };
  });

  async function route(
    session: RelaySession,
    viewer: string,
    event: RelayEvent,
    channelId: string,
  ) {
    // Tagged messages are the placement hook's.
    if (event.tags.some(([name]) => name === "p")) return;
    const channel = channelOf(session, channelId);
    if (!channel) return;
    const candidates = localAgents(channel.members, viewer);
    if (!candidates.length) return;
    const thread = threadReference(event);
    const entry = {
      ...base(event, channelId, channel.name),
      flow: thread ? "who" : "who+where",
    } as const;
    // Only messages the owner typed in this app copy.
    if (!(await confirmedOwnerSend(session, event, channelId))) {
      record({
        ...entry,
        status: "skipped",
        reason: "not sent from this app's composer",
      });
      return;
    }
    const decided = await ask(
      session,
      viewer,
      event,
      channel,
      candidates,
      [],
      WAKE_TIMEOUT_MS,
    );
    // Jev down: no one is woken, as without the plugin.
    if ("failed" in decided) {
      record({
        ...entry,
        status: "failed",
        reason: `Jev ${decided.failed}`,
        ms: decided.ms,
      });
      return;
    }
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
      record({
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
      probability,
      destination,
    } as const;
    record({ ...picked, wake: "waking" });
    const text = [
      `${safe(() => session.profiles.snapshot().get(viewer)?.name) || "The owner"} sent message ${event.id} in this conversation without tagging anyone.`,
      `Smart routing sends such messages to one of their agents, and picked you (${pct(probability)}).`,
      "Treat that message as addressed to you: handle it if it is yours to do; if it is not for you, end the turn without posting.",
      ...(decided.where ? ["", wherePrompt(decided.where, event.id)] : []),
      "",
      "The message:",
      messageText(event).slice(0, 4000),
    ].join("\n");
    let wake = "";
    for (let attempt = 0; ; attempt++) {
      try {
        const sent = await ctx.agents.wake(
          agent.key,
          { channel: channelId, ...destination, text },
          { current: () => true },
        );
        wake =
          sent.status === "delivered" ? "delivered" : `dropped: ${sent.reason}`;
      } catch (error) {
        wake = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const delay = WAKE_RETRY_DELAYS_MS[attempt];
      if (wake !== "dropped: unavailable" || delay === undefined) break;
      record({ ...picked, wake: "retrying" });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    record({ ...picked, wake });
  }

  async function confirmedOwnerSend(
    session: RelaySession,
    event: RelayEvent,
    channelId: string,
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
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
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

  function label(entry: Entry | undefined) {
    if (!entry) return null;
    const where = entry.where
      ? ` · ${placeText(entry.where.destination)}${entry.where.elsewhere ? " · asks elsewhere" : ""}`
      : "";
    if (entry.status === "picked") {
      const undelivered =
        entry.wake && !["delivered", "waking", "retrying"].includes(entry.wake);
      return `→ ${entry.agent} ${pct(entry.probability)}${where}${entry.wake === "retrying" ? " · retrying…" : undelivered ? " · not delivered" : ""}`;
    }
    if (entry.status === "placed" && entry.where)
      return `where: ${where.slice(3)}`;
    if (entry.status === "none")
      return entry.agent
        ? `Jev: none (top ${entry.agent} ${pct(entry.probability)})`
        : "Jev: none";
    if (entry.status === "failed") return "Jev failed";
    return null;
  }
  const useEntry = (id: string) =>
    useSyncExternalStore(subscribe, () => entryOf(id));
  function Marker({ message }: { message: { id: string } }) {
    const entry = useEntry(message.id);
    const text = label(entry);
    if (!text || !entry) return null;
    return (
      <span
        className="text-caption"
        title={details(entry)}
        style={{
          color:
            entry.status === "failed" || / · not delivered$/.test(text)
              ? "var(--text-warning)"
              : entry.status === "picked" || entry.status === "placed"
                ? "var(--text-accent)"
                : "var(--text-metadata)",
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </span>
    );
  }
  ctx.conversation.registerMessageAction({
    id: "smart-routing",
    title: "Smart routing",
    matches: (message) => !!label(entryOf(message.id)),
    component: ({ message, close }) => {
      const entry = useEntry(message.id);
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
      "Smart routing: the owner's recent routing decisions on this device, newest first: who Jev picked (each agent's yes), where the reply went (each where answer, the thresholds, the rule's reason and the destination), or why nothing happened.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 300 },
        channel_id: { type: "string" },
      },
    },
    async call(_client, _context, args) {
      const { limit, channel_id } = (args ?? {}) as {
        limit?: number;
        channel_id?: string;
      };
      const entries = log
        .filter((entry) => !channel_id || entry.channelId === channel_id)
        .slice(-Math.min(300, Math.max(1, Number(limit) || 20)))
        .reverse();
      return JSON.stringify(
        { thresholds: { who: WHO_THRESHOLD, ...WHERE_THRESHOLDS }, entries },
        null,
        2,
      );
    },
  });
};

/** The mark's tooltip and the dialog: every answer behind a decision. */
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
