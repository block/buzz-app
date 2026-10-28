// What the Runner serves the Manager over the agents link. Each name here is
// part of the contract between the two owners, so add to it with care: only
// JSON crosses, and either side may be a page that reloads.
import type { AgentsRunner } from "./agents-runner";
import { link, type Json, type Link, type LinkPort, type Served } from "./link";
import type { LocalAgentSource, LocalWork } from "./local-activity";
import type { AgentKey } from "./membership";
import type { Member } from "./records";
import type { Agent } from "./service";

type WorkKey = Pick<LocalWork, "scope" | "agent" | "messageId">;

const workKey = (args: Json): WorkKey => {
  const { scope, agent, messageId } = args as WorkKey;
  return { scope, agent, messageId };
};

/** The Runner's side: the local work its agents report. */
export function serveActivity(source: LocalAgentSource): Served {
  return {
    topics: {
      "activity.work": () => ({
        get: () => source.work() as unknown as Json,
        subscribe: (listener) => source.subscribeWork(listener),
      }),
    },
    commands: {
      "activity.interrupt": async (args) => {
        await source.interrupt?.(workKey(args));
        return null;
      },
      "activity.dismissError": (args) => {
        source.dismissError?.(workKey(args));
        return null;
      },
    },
  };
}

/** The Manager's side: the Runner's local work, as the screens read it. Rows
 * keep their identity until the Runner sends a change. */
export function linkedActivity(runner: Link) {
  let work: readonly LocalWork[] = Object.freeze([]);
  const listeners = new Set<() => void>();
  const stop = runner.watch("activity.work", null, () => {
    const rows = (runner.read("activity.work") ?? []) as unknown as LocalWork[];
    work = Object.freeze(rows.map((row) => Object.freeze(row)));
    for (const listener of [...listeners]) listener();
  });
  const source: LocalAgentSource = {
    work: () => work,
    subscribeWork(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dismissError: (row) =>
      void runner
        .call("activity.dismissError", workKey(row))
        .catch((error: unknown) =>
          console.warn("Could not hide this error", error),
        ),
    interrupt: async (row) => {
      await runner.call("activity.interrupt", workKey(row));
    },
  };
  return { source, stop };
}

/** What the Runner decides from: the viewer's memberships, and the viewer,
 * as of revision `revision` of the Manager page `from`. A page that reloads
 * counts from 0 again, so a revision means nothing without its page. */
type Members = Readonly<{
  from: string;
  revision: number;
  identities: readonly Member[];
  viewer: string | null;
}>;
/** What the Runner decided from the memberships it was last sent, which
 * were `revision` of the Manager page `from`: the agents running here, and
 * the keys of those with turns the app left working last time. */
type RunnerState = Readonly<{
  from: string | null;
  revision: number;
  running: readonly Agent[];
  interrupted: readonly AgentKey[];
}>;

/** The Runner's side: it decides what runs from the memberships the Manager
 * sends, and sends back what it decided. */
export function runnerSide(
  port: LinkPort,
  runner: Pick<
    AgentsRunner,
    "members" | "running" | "interrupted" | "subscribe"
  >,
) {
  let from: string | null = null;
  let revision = 0;
  const decided = new Set<() => void>();
  const side = link(port, {
    topics: {
      "runner.state": () => ({
        get: () =>
          ({
            from,
            revision,
            running: runner.running(),
            interrupted: runner.interrupted().map((agent) => agent.key),
          }) satisfies RunnerState as unknown as Json,
        subscribe: (listener) => {
          const stop = runner.subscribe(listener);
          decided.add(listener);
          return () => {
            stop();
            decided.delete(listener);
          };
        },
      }),
    },
  });
  side.watch("manager.members", null, () => {
    const members = side.read("manager.members") as unknown as
      | Members
      | undefined;
    if (!members) return;
    try {
      runner.members(members.identities, members.viewer ?? undefined);
    } catch (error) {
      console.error("The Runner could not decide what runs", error);
    }
    // Sent even when nothing that runs changed, or deciding failed, so the
    // Manager does not wait on it.
    from = members.from;
    revision = members.revision;
    for (const listener of [...decided]) listener();
  });
  return side;
}

/** The Manager's side: it sends the Runner the viewer's memberships, and
 * shows what the Runner decided. An agent keeps its identity until the Runner
 * sends a change to it. */
export function managerSide(
  port: LinkPort,
  members: () => Omit<Members, "from" | "revision">,
  changed: () => void,
) {
  const from = crypto.randomUUID();
  let revision = 0;
  let closed = false;
  let sent: string | undefined;
  const listeners = new Set<() => void>();
  let state: Readonly<{
    revision: number;
    running: readonly Agent[];
    interrupted: readonly Agent[];
  }> = {
    revision: 0,
    running: Object.freeze([]),
    interrupted: Object.freeze([]),
  };
  const waits = new Set<Readonly<{ revision: number; resolve(): void }>>();
  const shown = new Map<AgentKey, string>();
  const side = link(port, {
    topics: {
      "manager.members": () => ({
        get: () =>
          ({
            ...members(),
            from,
            revision,
          }) satisfies Members as unknown as Json,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      }),
    },
  });
  side.watch("runner.state", null, () => {
    const next = side.read("runner.state") as unknown as
      | RunnerState
      | undefined;
    if (!next) return;
    const running = next.running.map((agent) => {
      const json = JSON.stringify(agent);
      const prior = state.running.find((item) => item.key === agent.key);
      if (prior && shown.get(agent.key) === json) return prior;
      shown.set(agent.key, json);
      return Object.freeze(agent);
    });
    for (const key of shown.keys())
      if (!running.some((agent) => agent.key === key)) shown.delete(key);
    const left = new Set(next.interrupted);
    const interrupted = running.filter((agent) => left.has(agent.key));
    state = {
      // What it decided for an earlier load of this page is no answer.
      revision: next.from === from ? next.revision : 0,
      running: same(running, state.running)
        ? state.running
        : Object.freeze(running),
      interrupted: same(interrupted, state.interrupted)
        ? state.interrupted
        : Object.freeze(interrupted),
    };
    for (const wait of [...waits])
      if (wait.revision <= state.revision) {
        waits.delete(wait);
        wait.resolve();
      }
    changed();
  });
  return {
    /** The memberships may have changed: sends them if they did. */
    changed() {
      const json = JSON.stringify(members());
      if (json === sent) return;
      sent = json;
      revision++;
      for (const listener of [...listeners]) listener();
    },
    /** Settles once the Runner decided from the memberships sent so far. */
    decided() {
      if (closed || state.revision >= revision) return Promise.resolve();
      return new Promise<void>((resolve) => waits.add({ revision, resolve }));
    },
    /** The agents running here, in every community. */
    running: () => state.running,
    /** The running agents with turns the app left working last time. */
    interrupted: () => state.interrupted,
    /** A running agent, in any community. */
    agent: (key: AgentKey) => state.running.find((agent) => agent.key === key),
    close() {
      closed = true;
      side.close();
      // Nothing decides now.
      for (const wait of waits) wait.resolve();
      waits.clear();
    },
  };
}

const same = (next: readonly Agent[], prior: readonly Agent[]) =>
  next.length === prior.length &&
  next.every((agent, index) => agent === prior[index]);
