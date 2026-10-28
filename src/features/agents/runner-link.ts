// What the Runner serves the Manager over the agents link. Each name here is
// part of the contract between the two owners, so add to it with care: only
// JSON crosses, and either side may be a page that reloads.
import type { AgentsRunner, RunnerStatus } from "./agents-runner";
import { link, type Json, type Link, type LinkPort, type Served } from "./link";
import type { LocalAgentSource, LocalWork } from "./local-activity";
import type { AgentKey } from "./membership";
import { blank, type Member, type RecordEdit } from "./records";
import type { AgentRecord } from "./store";
import type { Agent, SessionControlAction, SessionPlace } from "./service";

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
  /** The list was read, so it names every membership on this device. */
  loaded: boolean;
  identities: readonly Member[];
  viewer: string | null;
}>;
/** What the Runner decided from the memberships it was last sent, which
 * were `revision` of the Manager page `from`: the agents running here, the
 * keys of those with turns the app left working last time, and who holds
 * each membership. */
type RunnerState = Readonly<{
  from: string | null;
  revision: number;
  running: readonly Agent[];
  interrupted: readonly AgentKey[];
  status: RunnerStatus;
}>;
/** The records the Runner keeps, and the type of each agent it retyped that
 * the memberships it was sent do not say yet, by pubkey. One value, so a new
 * config never shows with the type it replaced. */
type RunnerRecords = Readonly<{
  records: readonly AgentRecord[];
  types: Readonly<Record<string, string>>;
}>;

/** The Runner's side: it decides what runs from the memberships the Manager
 * sends, and sends back what it decided. */
export function runnerSide(
  port: LinkPort,
  runner: Pick<
    AgentsRunner,
    | "members"
    | "running"
    | "interrupted"
    | "runnerStatus"
    | "subscribe"
    | "subscribeRecords"
    | "edit"
    | "session"
    | "retype"
    | "retypes"
  > &
    Readonly<{ records: Pick<AgentsRunner["records"], "all"> }>,
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
            status: runner.runnerStatus(),
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
      "runner.records": () => ({
        get: () =>
          ({
            records: runner.records.all(),
            types: runner.retypes(),
          }) satisfies RunnerRecords as unknown as Json,
        subscribe: (listener) => runner.subscribeRecords(listener),
      }),
    },
    commands: {
      "records.edit": async (args) => {
        const { key, edit } = args as unknown as Readonly<{
          key: AgentKey;
          edit: RecordEdit;
        }>;
        await runner.edit(key, edit);
        return null;
      },
      "agents.session": async (args) => {
        const { key, type, place, action } = args as unknown as Readonly<{
          key: AgentKey;
          type: string;
          place: SessionPlace;
          action: SessionControlAction;
        }>;
        await runner.session(key, type, place, action);
        return null;
      },
      "agents.retype": async (args) => {
        const { key, type, config } = args as unknown as Readonly<{
          key: AgentKey;
          type: string;
          config: unknown;
        }>;
        await runner.retype(key, type, config);
        return null;
      },
    },
  });
  side.watch("manager.members", null, () => {
    const members = side.read("manager.members") as unknown as
      | Members
      | undefined;
    if (!members) return;
    try {
      runner.members(
        members.identities,
        members.viewer ?? undefined,
        members.loaded,
      );
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
 * shows what the Runner decided and the records it keeps. An agent or record
 * keeps its identity until the Runner sends a change to it. */
export function managerSide(
  port: LinkPort,
  host: Readonly<{
    members(): Omit<Members, "from" | "revision">;
    /** The settings a new agent of this type starts with, if its type is
     * here. */
    defaults(
      identity: Pick<Member, "pubkey" | "type">,
    ): AgentRecord | undefined;
    /** The Runner gave these agents a type, by pubkey, that the
     * memberships do not say yet. */
    retyped(types: Readonly<Record<string, string>>): void;
    /** What the Runner decided, or a record, changed. */
    changed(): void;
  }>,
) {
  const { members, changed } = host;
  const from = crypto.randomUUID();
  let revision = 0;
  let closed = false;
  let sent: string | undefined;
  const listeners = new Set<() => void>();
  const none: RunnerStatus = Object.freeze({
    runs: [],
    yielded: [],
    transitioning: [],
  });
  let state: Readonly<{
    revision: number;
    running: readonly Agent[];
    interrupted: readonly Agent[];
    status: RunnerStatus;
  }> = {
    revision: 0,
    running: Object.freeze([]),
    interrupted: Object.freeze([]),
    status: none,
  };
  let statusJson = JSON.stringify(none);
  const waits = new Set<Readonly<{ revision: number; resolve(): void }>>();
  const shown = new Map<AgentKey, string>();
  let records: Readonly<Record<AgentKey, AgentRecord>> = {};
  const recordJson = new Map<AgentKey, string>();
  // A new agent's defaults, until the Runner sends a record for it.
  const filled = new Map<string, AgentRecord>();
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
    const json = JSON.stringify(next.status);
    const status =
      json === statusJson ? state.status : Object.freeze(next.status);
    statusJson = json;
    state = {
      // What it decided for an earlier load of this page is no answer.
      revision: next.from === from ? next.revision : 0,
      running: same(running, state.running)
        ? state.running
        : Object.freeze(running),
      interrupted: same(interrupted, state.interrupted)
        ? state.interrupted
        : Object.freeze(interrupted),
      status,
    };
    for (const wait of [...waits])
      if (wait.revision <= state.revision) {
        waits.delete(wait);
        wait.resolve();
      }
    changed();
  });
  side.watch("runner.records", null, () => {
    const sent = side.read("runner.records") as unknown as
      | RunnerRecords
      | undefined;
    if (!sent) return;
    const next: Record<AgentKey, AgentRecord> = {};
    for (const record of sent.records) {
      const json = JSON.stringify(record);
      const prior = records[record.pubkey];
      next[record.pubkey] =
        prior && recordJson.get(record.pubkey) === json ? prior : record;
      recordJson.set(record.pubkey, json);
      filled.delete(record.pubkey);
    }
    for (const key of recordJson.keys()) if (!next[key]) recordJson.delete(key);
    records = next;
    if (Object.keys(sent.types).length) host.retyped(sent.types);
    changed();
  });
  /** The agent's home record, which keeps its config: as the Runner keeps it
   * or, without one, its type's defaults. */
  const settingsOf = (identity: Pick<Member, "pubkey" | "type">) => {
    const { pubkey } = identity;
    const kept = records[pubkey] ?? filled.get(pubkey);
    if (kept) return kept;
    const record = host.defaults(identity);
    if (!record) return blank(pubkey);
    filled.set(pubkey, record);
    return record;
  };
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
    /** Who holds each membership, kept while unchanged. */
    status: () => state.status,
    /** Whether this copy runs the agent. */
    runs: (key: AgentKey) => state.status.runs.includes(key),
    /** Whether another copy of the app runs an agent this one could. */
    yielded: (key: AgentKey) => state.status.yielded.includes(key),
    /** Whether a change of type holds the agent's runner now. */
    transitioning: (key: AgentKey) => state.status.transitioning.includes(key),
    /** Asks the Runner to run `action` on the session of the agent of type
     * `type` in `place`. */
    async session(
      key: AgentKey,
      type: string,
      place: SessionPlace,
      action: SessionControlAction,
    ) {
      await side.call("agents.session", {
        key,
        type,
        place,
        action,
      } as unknown as Json);
    },
    /** Asks the Runner to give the agent type `type`, starting with
     * `config`; settles once it is saved, and shown here. */
    async retype(key: AgentKey, type: string, config: unknown) {
      await side.call("agents.retype", {
        key,
        type,
        config,
      } as unknown as Json);
    },
    /** The records the Runner keeps, as it last sent them. */
    records: {
      keys: () => Object.keys(records),
      settingsOf,
      /** The membership's settings as its owner and agent see them: its own
       * attention, starting with none, and the agent's config. */
      recordOf(member: Member): AgentRecord {
        const settings = settingsOf(member);
        if (member.key === member.pubkey) return settings;
        const own = records[member.key] ?? blank(member.key);
        return { ...own, config: settings.config };
      },
      /** Asks the Runner to apply `edit`; settles once it is saved, and
       * shown here. */
      async edit(key: AgentKey, edit: RecordEdit) {
        await side.call("records.edit", {
          key,
          edit,
        } as unknown as Json);
      },
    },
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
