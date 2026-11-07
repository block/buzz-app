// Today's spend beside Send: the same session reads and estimates as the
// Usage page, from local midnight. One store per plugin, so every open
// composer shares one read. Reads are local files; nothing goes to a relay.
import type { Agent, Agents } from "../../features/agents/service";
import { loadPrices } from "./pricing";
import { type AgentUsage, dayStart, merge, type Stats, stats } from "./stats";

/** How long a read stands before a composer showing the total or its card
 * opening reads again. */
export const FRESH_MS = 60_000;
/** How long a read stands before the window coming back reads again: every
 * read starts the harnesses' readers, so glancing away and back costs none. */
export const AMBIENT_MS = 5 * 60_000;

export type Today = Readonly<{
  /** When the shown usage was read. */
  now: number;
  /** Agents here whose type reads usage, whether or not they ran today. */
  agents: number;
  usage: readonly AgentUsage[];
  result: Stats;
  /** Whether the price data failed to load, so costs are not estimated. */
  unpriced: boolean;
}>;
export type TodayStore = ReturnType<typeof todayStore>;

/** Each membership's own: the same agent in another community reads apart. */
const keyOf = (agent: Agent) => `${agent.key}:${agent.type}`;
/** What a read depends on, as on the Usage page: which agents, the names the
 * card shows, and the configuration their readers use. */
const readKey = (targets: readonly Agent[]) =>
  JSON.stringify(
    targets.map((agent) => [keyOf(agent), agent.name, agent.config]),
  );
/** The first moment of the day after the one `at` is in. Days run 23 to 25
 * hours, so a day and a half after its start always lands in the next. */
const nextDay = (at: number) => dayStart(dayStart(at) + 36 * 3_600_000);

export function todayStore(agents: Agents, clock: () => number = Date.now) {
  let today: Today | undefined;
  let reading: Promise<void> | undefined;
  /** A forced read asked for while another ran: it runs when that ends. */
  let again = false;
  let readAt = Number.NEGATIVE_INFINITY;
  let readFor: string | undefined;
  /** The agents `today` was read for. */
  let shownFor: string | undefined;
  let controller = new AbortController();
  let unwatch: (() => void) | undefined;
  let midnight: ReturnType<typeof setTimeout> | undefined;
  const kept = new Map<string, AgentUsage>();
  const listeners = new Set<() => void>();

  /** The agents a read covers, or undefined before the agents are known.
   * Only agents here run sessions on this computer, as on the Usage page. */
  function targetsOf() {
    const snapshot = agents.snapshot();
    if (snapshot.status !== "ready") return undefined;
    const types = agents.types();
    return snapshot.agents.filter(
      (agent) =>
        agent.place === "here" &&
        types.some((type) => type.key === agent.type && type.usage),
    );
  }

  /** Whether the last read was for other agents, such as another
   * community's, or on an earlier day. */
  const outdated = (targets: readonly Agent[]) =>
    readKey(targets) !== readFor || dayStart(clock()) !== dayStart(readAt);

  /** Reads again unless a read is running or the last one, for these agents
   * and today, is under `fresh` old; `force` reads even when fresh, after any
   * running read. */
  function refresh(force = false, fresh = FRESH_MS): Promise<void> | undefined {
    if (reading) {
      again ||= force;
      return reading;
    }
    const targets = targetsOf();
    if (!targets) return undefined;
    if (!force && !outdated(targets) && clock() - readAt < fresh)
      return undefined;
    const types = agents.types();
    const readerOf = (agent: Agent) =>
      types.find((type) => type.key === agent.type)?.usage;
    const now = clock();
    const since = dayStart(now);
    const { signal } = controller;
    const key = readKey(targets);
    readAt = now;
    readFor = key;
    const current = (async () => {
      const unpriced = await loadPrices().then(
        () => false,
        () => true,
      );
      const unread = new Set<string>();
      await Promise.all(
        targets.map(async (agent) => {
          const key = keyOf(agent);
          try {
            const sessions = await readerOf(agent)?.(agent, { since, signal });
            if (!sessions) return;
            const earlier = (kept.get(key)?.sessions ?? []).filter(
              (session) => session.lastAt >= since,
            );
            kept.set(key, {
              agent,
              harness: agent.type,
              sessions: merge(earlier, sessions),
            });
          } catch {
            // What an earlier read found stays, marked as maybe incomplete.
            unread.add(agent.type);
          }
        }),
      );
      if (signal.aborted) return;
      const wanted = new Set(targets.map(keyOf));
      for (const key of kept.keys()) if (!wanted.has(key)) kept.delete(key);
      const usage = [...kept.values()];
      today = {
        now,
        agents: targets.length,
        usage,
        result: stats(usage, now, 1, unread),
        unpriced,
      };
      shownFor = key;
      for (const listener of listeners) listener();
    })().finally(() => {
      if (reading !== current) return;
      reading = undefined;
      armMidnight();
      if (again) {
        again = false;
        void refresh(true);
      }
    });
    reading = current;
    return current;
  }

  /** "Today" turns over at local midnight even when nothing else happens. */
  function armMidnight() {
    clearTimeout(midnight);
    if (!listeners.size) return;
    midnight = setTimeout(() => void refresh(true), nextDay(clock()) - clock());
  }

  /** Agents loading, being added, removed, renamed or reconfigured, or
   * connecting again after a midnight their read missed: read for them now
   * rather than at the next composer or window change. Listeners hear at once,
   * so a total for other agents stops showing while the read runs. */
  function agentsChanged() {
    const targets = targetsOf();
    for (const listener of listeners) listener();
    if (targets && outdated(targets)) void refresh(true);
  }
  const windowBack = () => {
    if (document.visibilityState === "visible") void refresh(false, AMBIENT_MS);
  };

  /** Watches what can make the total out of date while a composer shows it. */
  function watch() {
    const stopAgents = agents.subscribe(agentsChanged);
    const hasWindow = typeof window !== "undefined";
    if (hasWindow) {
      document.addEventListener("visibilitychange", windowBack);
      window.addEventListener("focus", windowBack);
    }
    armMidnight();
    return () => {
      stopAgents();
      if (hasWindow) {
        document.removeEventListener("visibilitychange", windowBack);
        window.removeEventListener("focus", windowBack);
      }
      clearTimeout(midnight);
      midnight = undefined;
    };
  }

  /** The total, unless it is for other agents than these or an earlier day. */
  function get() {
    const targets = targetsOf();
    if (!today || !targets || readKey(targets) !== shownFor) return undefined;
    return dayStart(clock()) === dayStart(today.now) ? today : undefined;
  }

  return {
    get,
    subscribe(listener: () => void) {
      listeners.add(listener);
      unwatch ??= watch();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        unwatch?.();
        unwatch = undefined;
      };
    },
    refresh: () => refresh(),
    /** Stops a running read and what it watches; a later `refresh` reads
     * again. */
    dispose() {
      controller.abort();
      controller = new AbortController();
      reading = undefined;
      again = false;
      readAt = Number.NEGATIVE_INFINITY;
      readFor = undefined;
      today = undefined;
      shownFor = undefined;
      unwatch?.();
      unwatch = undefined;
      listeners.clear();
    },
  };
}

/** The agent's latest session today that started in a conversation, to open
 * from its row. */
export function latestSession(today: Today, agent: Agent) {
  const since = dayStart(today.now);
  const sessions =
    today.usage.find((entry) => keyOf(entry.agent) === keyOf(agent))
      ?.sessions ?? [];
  return sessions
    .filter((session) => session.channelId && session.lastAt >= since)
    .sort((a, b) => b.lastAt - a.lastAt)[0];
}
