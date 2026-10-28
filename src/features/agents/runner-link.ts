// What the Runner serves the Manager over the agents link. Each name here is
// part of the contract between the two owners, so add to it with care: only
// JSON crosses, and either side may be a page that reloads.
import type { AgentsRunner, RunnerStatus } from "./agents-runner";
import { link, type Json, type Link, type LinkPort, type Served } from "./link";
import type { LocalAgentSource, LocalWork } from "./local-activity";
import type { AgentKey } from "./membership";
import { blank, type Member, type RecordEdit } from "./records";
import type { AgentRecord } from "./store";
import type {
  Agent,
  AgentProviderSnapshot,
  RegisteredAgentType,
  SessionControlAction,
  SessionPlace,
  SessionState,
} from "./service";
import type { RuntimeLink } from "./exposed";

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

/** What the Manager knows of an agent type that runs here, to show it with
 * what its plugin's UI entry presents. `revision` names the registration, so
 * what the Manager reaches of an earlier one is not taken for this one's. */
export type TypeInfo = Readonly<{
  key: string;
  id: string;
  pluginId: string;
  revision: string;
  title: string;
  description?: string;
  /** What `defaults()` gave; absent when it threw. */
  defaults?: Json;
  timeoutMs?: number;
  resumes?: boolean;
  /** Which of these the type has. */
  has: Readonly<{
    run: boolean;
    runOnce: boolean;
    models: boolean;
    usage: boolean;
    sessionControls: boolean;
    provider: boolean;
  }>;
}>;
/** A type's provider status: its snapshot, and whether it handles its
 * attention state itself. */
export type ProviderStatus = Readonly<{
  snapshot: AgentProviderSnapshot;
  attend: boolean;
}>;
type TypeArgs = Readonly<{ type: string; revision: string }>;

function infoOf(type: RegisteredAgentType): TypeInfo {
  let defaults: Json | undefined;
  try {
    defaults = JSON.parse(JSON.stringify(type.defaults())) as Json;
  } catch (error) {
    console.warn(`Agent type ${type.key} has invalid defaults`, error);
  }
  return {
    key: type.key,
    id: type.id,
    pluginId: type.pluginId,
    revision: type.revision,
    title: type.title,
    ...(type.description !== undefined && { description: type.description }),
    ...(defaults !== undefined && { defaults }),
    ...(type.timeoutMs !== undefined && { timeoutMs: type.timeoutMs }),
    ...(type.resumes !== undefined && { resumes: type.resumes }),
    has: {
      run: !!type.run,
      runOnce: !!type.runOnce,
      models: !!type.models,
      usage: !!type.usage,
      sessionControls: !!type.sessionControls,
      provider: !!type.provider,
    },
  };
}
const nothing = { get: () => null, subscribe: () => () => {} };

/** The Runner's side: it decides what runs from the memberships the Manager
 * sends, and sends back what it decided. It also serves the agent types that
 * run here: what they are, and what their UIs reach of them. */
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
    | "types"
    | "subscribeTypes"
  > &
    Readonly<{ records: Pick<AgentsRunner["records"], "all"> }>,
) {
  let from: string | null = null;
  let revision = 0;
  const decided = new Set<() => void>();
  // Only types that run here: a hosted one runs through its provider.
  const local = () => runner.types().filter((type) => !type.remote);
  const typeOf = (args: Json) => {
    const { type, revision } = args as TypeArgs;
    return local().find(
      (entry) => entry.key === type && entry.revision === revision,
    );
  };
  const kindOf = (args: Json) => {
    const kind = typeOf(args);
    if (!kind) throw new Error("That agent type is not available");
    return kind;
  };
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
      "runner.types": () => ({
        get: () => local().map(infoOf) as unknown as Json,
        subscribe: (listener) => runner.subscribeTypes(listener),
      }),
      "type.topic": (args) => {
        const { topic, args: inner } = args as TypeArgs &
          Readonly<{ topic: string; args: Json }>;
        return typeOf(args)?.expose?.topics?.[topic]?.(inner) ?? nothing;
      },
      "type.sessionState": (args) => {
        const { agent, place } = args as unknown as Readonly<{
          agent: Agent;
          place: SessionPlace;
        }>;
        const controls = typeOf(args)?.sessionControls;
        if (!controls) return nothing;
        return {
          get: () => controls.state(agent, place) satisfies SessionState,
          subscribe: (listener) => controls.subscribe(listener),
        };
      },
      "type.provider": (args) => {
        const provider = typeOf(args)?.provider;
        if (!provider) return nothing;
        return {
          get: () =>
            ({
              snapshot: provider.snapshot(),
              attend: !!provider.attentionAction,
            }) satisfies ProviderStatus as unknown as Json,
          subscribe: (listener) => provider.subscribe(listener),
        };
      },
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
      "type.call": async (args) => {
        const { command, args: inner } = args as TypeArgs &
          Readonly<{ command: string; args: Json }>;
        const call = kindOf(args).expose?.commands?.[command];
        if (!call) throw new Error(`The agent type has no command ${command}`);
        return (await call(inner)) ?? null;
      },
      "type.models": async (args) => {
        const { agent } = args as unknown as Readonly<{ agent: Agent }>;
        const models = kindOf(args).models;
        if (!models) throw new Error("This agent type lists no models");
        return (await models(agent)) as unknown as Json;
      },
      "type.usage": async (args) => {
        const { agent, since } = args as unknown as Readonly<{
          agent: Agent;
          since: number;
        }>;
        const usage = kindOf(args).usage;
        if (!usage) throw new Error("This agent type reports no usage");
        // The Manager stops waiting by itself; reading never changes a
        // session, so it is left to finish.
        const signal = new AbortController().signal;
        return (await usage(agent, { since, signal })) as unknown as Json;
      },
      "type.check": async (args) => {
        await kindOf(args).provider?.check();
        return null;
      },
      "type.attend": (args) => {
        kindOf(args).provider?.attentionAction?.();
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
  let types: readonly TypeInfo[] = Object.freeze([]);
  const typeJson = new Map<string, string>();
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
  side.watch("runner.types", null, () => {
    const sent = side.read("runner.types") as unknown as
      | readonly TypeInfo[]
      | undefined;
    if (!sent) return;
    const next = sent.map((info) => {
      const json = JSON.stringify(info);
      const prior = types.find((entry) => entry.key === info.key);
      if (prior && typeJson.get(info.key) === json) return prior;
      typeJson.set(info.key, json);
      return Object.freeze(info);
    });
    for (const key of typeJson.keys())
      if (!next.some((info) => info.key === key)) typeJson.delete(key);
    if (
      next.length === types.length &&
      next.every((info, index) => info === types[index])
    )
      return;
    types = Object.freeze(next);
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
    /** The agent types that run here, each kept while unchanged. */
    types: () => types,
    /** What the type's UI reaches of its runtime, until `close`. */
    runtime(info: TypeInfo): RuntimeLink & Readonly<{ close(): void }> {
      const of = { type: info.key, revision: info.revision };
      const stops = new Set<() => void>();
      return {
        read: (topic, args = null) =>
          side.read("type.topic", { ...of, topic, args }),
        watch(topic, args, listener) {
          const stop = side.watch(
            "type.topic",
            { ...of, topic, args },
            listener,
          );
          stops.add(stop);
          return () => {
            stops.delete(stop);
            stop();
          };
        },
        call: (command, args = null) =>
          side.call("type.call", { ...of, command, args }),
        close() {
          for (const stop of stops) stop();
          stops.clear();
        },
      };
    },
    /** What the type's runtime calls on the Runner for an agent. */
    async models(info: TypeInfo, agent: Agent) {
      return (await side.call("type.models", {
        type: info.key,
        revision: info.revision,
        agent: agent as unknown as Json,
      })) as unknown;
    },
    async usage(info: TypeInfo, agent: Agent, since: number) {
      return (await side.call("type.usage", {
        type: info.key,
        revision: info.revision,
        agent: agent as unknown as Json,
        since,
      })) as unknown;
    },
    /** Watches the session state of `agent` in `place` until the returned
     * stop. */
    watchSession(
      info: TypeInfo,
      agent: Agent,
      place: SessionPlace,
      listener: () => void,
    ) {
      return side.watch(
        "type.sessionState",
        sessionArgs(info, agent, place),
        listener,
      );
    },
    sessionState: (info: TypeInfo, agent: Agent, place: SessionPlace) =>
      side.read("type.sessionState", sessionArgs(info, agent, place)) as
        | SessionState
        | null
        | undefined,
    /** Watches the type's provider status until the returned stop. */
    watchProvider: (info: TypeInfo, listener: () => void) =>
      side.watch(
        "type.provider",
        { type: info.key, revision: info.revision },
        listener,
      ),
    provider: (info: TypeInfo) =>
      side.read("type.provider", {
        type: info.key,
        revision: info.revision,
      }) as ProviderStatus | null | undefined,
    check: async (info: TypeInfo) => {
      await side.call("type.check", {
        type: info.key,
        revision: info.revision,
      });
    },
    attend: async (info: TypeInfo) => {
      await side.call("type.attend", {
        type: info.key,
        revision: info.revision,
      });
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

const sessionArgs = (info: TypeInfo, agent: Agent, place: SessionPlace) =>
  ({
    type: info.key,
    revision: info.revision,
    agent,
    place,
  }) as unknown as Json;

const same = (next: readonly Agent[], prior: readonly Agent[]) =>
  next.length === prior.length &&
  next.every((agent, index) => agent === prior[index]);
