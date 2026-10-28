// The Runner: the part of agents that runs them. It decides which agents run,
// and owns the agent runners and the agent storage they keep, which is
// records, catch-up progress, turns in progress and synced config copies.
// What it needs from the Manager, the part the screens use, it asks through
// `RunnerManager`; those facts and requests are what will cross the agents
// link when the Runner moves to its own page.
import { AgentConfigStore } from "./agent-config";
import { isSynced, resolveStart } from "./agent-start";
import {
  readCheckpoints,
  splitLegacyCheckpoints,
  writeCheckpoints,
  type Checkpoints,
} from "./catch-up";
import { originOf, RunnerConnections } from "./connections";
import { CoreMemoryCache } from "./core-memory-cache";
import { readInterrupted, writeInterrupted } from "./interrupted";
import type { LocalAgentActivity } from "./local-activity";
import { pubkeyOf, type AgentKey } from "./membership";
import { migrateWatchFilters } from "./migrate-filter";
import { migrateAgentStorage } from "./migrate-storage";
import type { AgentIdentity } from "./native";
import { ownerReads } from "./reads";
import { AgentRecords, EMPTY, type Member } from "./records";
import { AgentRunners, type Connection, type RunnerHost } from "./runner";
import type { Agent, ConfigBinding, RegisteredAgentType } from "./service";
import { soloChat } from "./solo-chat";
import { nameSoloChat } from "./solo-chat-name";
import type { AgentStore } from "./state";
import type { AgentRecord } from "./store";
import { relayPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { Decisions } from "../decisions/service";
import { channelTabs } from "../../bundled/channels/useChannelTabState";

/** What the Runner asks of the Manager. */
export type RunnerManager = Pick<
  RunnerHost,
  | "member"
  | "dm"
  | "team"
  | "createAgent"
  | "updateAgent"
  | "handoff"
  | "templates"
  | "classifier"
  | "keyStatus"
  | "classifierKey"
  | "classifierKeyGeneration"
  | "setClassifierKey"
  | "context"
  | "displayName"
> &
  Readonly<{
    /** Who runs which agent changed. */
    ownershipChanged(): void;
    /** A record or turn in progress changed what the screens show. */
    changed(): void;
    /** The community's relay, while the viewer is in it. */
    open(origin: string): RelayData | undefined;
    /** The membership of this key, unless it was deleted. */
    liveMember(key: AgentKey): Member | undefined;
    types(): readonly RegisteredAgentType[];
    /** The settings a new agent of this type starts with. */
    defaults(pubkey: string, type: RegisteredAgentType): AgentRecord;
    /** Which artifact types an agent has synced. */
    configBinding?: ((agent: Agent) => ConfigBinding) | undefined;
  }>;

export class AgentsRunner {
  /** Each membership's settings as saved, by key, and as the owner and the
   * agent see them. Its home record also keeps the agent's config. */
  readonly records: AgentRecords;
  readonly coreMemory: CoreMemoryCache;
  readonly runners: AgentRunners;
  /** The Runner's own live session of each community it runs agents in. */
  readonly connections: RunnerConnections;
  /** Confirmed synced config copies, the only synced launch source. */
  private readonly configStore: AgentConfigStore;
  /** The agents running here, in every community, and those of them with
   * turns the app left working last time. */
  private state: Readonly<{
    running: readonly Agent[];
    interrupted: readonly Agent[];
  }> = { running: [], interrupted: [] };

  constructor(
    storage: AgentStore,
    custody: RunnerHost["custody"],
    activity: LocalAgentActivity,
    decisions: Decisions | undefined,
    private readonly manager: RunnerManager,
  ) {
    // Each changes the copy at once and logs a failed save itself.
    void migrateAgentStorage(storage);
    void migrateWatchFilters(storage);
    this.records = new AgentRecords(storage, {
      defaults: ({ pubkey, type }) => {
        const kind = manager.types().find((entry) => entry.key === type);
        if (kind)
          try {
            return manager.defaults(pubkey, kind);
          } catch (error) {
            console.warn(`Agent type ${type} has invalid defaults`, error);
          }
      },
      changed: () => manager.changed(),
      // Its timers waited for this change, saved or failed.
      settled: (key) => this.runners.wake(key),
    });
    void splitLegacyCheckpoints(storage);
    this.configStore = new AgentConfigStore(storage);
    this.connections = new RunnerConnections({
      open: (origin) => manager.open(origin),
      listen: (session, origin, connection) =>
        this.listen(session, origin, connection),
      // The Manager's own session may change first: what runs is shown and
      // reconciled again once this one has.
      changed: () => manager.changed(),
    });
    this.coreMemory = new CoreMemoryCache((key) =>
      ownerReads(this.relay(key), pubkeyOf(key)),
    );
    /** The catch-up progress this program last read or saved. */
    let savedProgress: Checkpoints = {};
    this.runners = new AgentRunners({
      ownershipChanged: () => manager.ownershipChanged(),
      ready: (key) => this.ready(key),
      agent: (key) => this.agent(key),
      member: (agent, event) => manager.member(agent, event),
      dm: (agent, event) => manager.dm(agent, event),
      starting: (agent, channelId) =>
        this.connections
          .binding(agent)
          ?.session.channelWrites.starting(channelId),
      community: (agent) => this.connections.binding(agent),
      records: () => this.records.all(),
      checkpoints: {
        read: () => (savedProgress = readCheckpoints(storage)),
        write: (checkpoints) => {
          void writeCheckpoints(storage, checkpoints, savedProgress).catch(
            (error) => {
              console.warn("Agent catch-up progress was not saved", error);
              // The copy went back to what is saved: the next save compares
              // with that.
              savedProgress = readCheckpoints(storage);
            },
          );
          savedProgress = checkpoints;
        },
      },
      interrupted: {
        read: () => readInterrupted(storage),
        write: (key, turns) => {
          void writeInterrupted(storage, key, turns).catch((error) =>
            console.warn("Agent turns in progress were not saved", error),
          );
        },
        changed: () => manager.changed(),
      },
      scope: (agent) => this.connections.binding(agent)?.scope,
      saved: (key) => this.records.saved(key),
      record: (key) => {
        const member = manager.liveMember(key);
        if (!member) throw new Error("No such agent on this device");
        return this.records.recordOf(member);
      },
      change: async (key, apply) => {
        const record = await this.records.change(key, () => {
          const member = manager.liveMember(key);
          if (!member) throw new Error("No such agent on this device");
          // In turn, so this is the newest saved record.
          return apply(this.records.recordOf(member));
        });
        if (!record) throw new Error("No such agent on this device");
        return record;
      },
      changing: (key) => this.records.isChanging(key),
      timers: (key) => this.records.timersOf(key),
      progress: (key, ran) => this.records.progress(key, ran),
      start: (agent) => {
        const { settings, instructions } = manager.configBinding?.(agent) ?? {};
        const merge = manager
          .types()
          .find((type) => type.key === agent.type)?.syncedSettings;
        if (!merge && isSynced(this.configStore, settings))
          return {
            ok: false,
            state: "invalid",
            reason: "This agent type has no synced settings",
          };
        return resolveStart({
          store: this.configStore,
          local: agent.config as object,
          agentType: agent.type,
          ...(settings && merge
            ? {
                settings: {
                  ...settings,
                  schema: merge.schema,
                  withSynced: merge.withSynced as (
                    config: object,
                    synced: Readonly<Record<string, string>>,
                  ) => object,
                },
              }
            : {}),
          ...(instructions ? { instructions } : {}),
        });
      },
      team: (key) => manager.team(key),
      agentTypes: () =>
        manager
          .types()
          .filter((type) => !type.remote)
          .map(({ key, title }) => ({ key, title })),
      createAgent: (agent, input) => manager.createAgent(agent, input),
      updateAgent: (agent, input) => manager.updateAgent(agent, input),
      handoff: (agent, handoff) => manager.handoff(agent, handoff),
      templates: (agent) => manager.templates(agent),
      tabs: (agent) => {
        const session = this.connections.binding(agent)?.session;
        return session && channelTabs(session);
      },
      classifier: () => manager.classifier(),
      decisions: () => decisions,
      keyStatus: () => manager.keyStatus(),
      classifierKey: () => manager.classifierKey(),
      classifierKeyGeneration: () => manager.classifierKeyGeneration(),
      setClassifierKey: (key, generation) =>
        manager.setClassifierKey(key, generation),
      context: (agent, event) => manager.context(agent, event),
      displayName: (agent, pubkey) => manager.displayName(agent, pubkey),
      custody,
      activity,
      soloChat: (agent, channel, signal) =>
        soloChat(() => this.relay(agent.key), agent.owner, channel, signal),
      remembered: (key, slug, body) => this.coreMemory.wrote(key, slug, body),
      woke: (key, object) =>
        this.records.history(
          key,
          object,
          undefined,
          Math.floor(Date.now() / 1000),
        ),
      finished: (key) => void this.coreMemory.refresh(key),
      named: (agent, event, title) =>
        void nameSoloChat(
          this.relay(agent.key),
          agent.owner,
          agent.pubkey,
          event,
          title,
        ).catch((error) => console.warn("Couldn't name the Solo chat", error)),
    });
  }

  /** Connects each community where the viewer has an agent. */
  watch(identities: readonly AgentIdentity[], viewer: string | undefined) {
    this.connections.watch(identities, viewer);
  }
  /** Decides which agents run: each of the viewer's agents whose community is
   * joined and not disconnected. A reconnect does not stop one. An unfinished
   * Delete or Remove stops it, and its types' plugins stop what they keep for
   * it. Then each runner goes on with what it can do now. */
  update(identities: readonly Member[], viewer: string | undefined) {
    const live = identities.filter(
      (identity) => !identity.deleted && !identity.deleting,
    );
    const running: Agent[] = [];
    for (const identity of live) {
      const status = this.connections
        .relay(originOf(identity.relay))
        ?.snapshot().status;
      if (identity.owner !== viewer || !status || status === "disconnected")
        continue;
      const record = this.records.recordOf(identity);
      // Reuse the frozen agent while nothing it shows changed, so subscribers
      // see a stable snapshot.
      const prior = this.agent(identity.key);
      running.push(
        prior &&
          prior.name === identity.name &&
          prior.picture === identity.picture &&
          prior.type === identity.type &&
          prior.attention === record.attention &&
          prior.skipped === (record.skipped ?? EMPTY) &&
          prior.timers === (record.timers ?? EMPTY) &&
          prior.sourceRuns === record.sourceRuns &&
          prior.attentionHistory === record.attentionHistory &&
          prior.attentionEnabled === (record.attentionEnabled === true) &&
          prior.config === record.config
          ? prior
          : view(identity, record),
      );
    }
    this.runners.reconcile(
      live.map(({ key, pubkey, relay, type, owner }) => ({
        key,
        pubkey,
        relay,
        type,
        scope: relayPartition(originOf(relay) ?? relay, owner),
      })),
      new Map(this.manager.types().map((type) => [type.key, type])),
    );
    const left = this.runners.interrupted();
    // Only the copy that holds an agent may resume or forget its turns.
    const interrupted = running.filter(
      (agent) => left.has(agent.key) && this.runners.runs(agent.key),
    );
    this.state = {
      running: same(running, this.state.running)
        ? this.state.running
        : Object.freeze(running),
      interrupted: same(interrupted, this.state.interrupted)
        ? this.state.interrupted
        : Object.freeze(interrupted),
    };
    this.runners.resume(
      new Set(
        running
          .filter((agent) => this.connections.binding(agent))
          .map((agent) => agent.key),
      ),
    );
    this.runners.catchUp(false);
  }
  /** The agents running here, in every community. */
  running() {
    return this.state.running;
  }
  /** The running agents with turns the app left working last time. */
  interrupted() {
    return this.state.interrupted;
  }
  /** A running agent, in any community. */
  agent(key: AgentKey) {
    return this.state.running.find((agent) => agent.key === key);
  }
  /** The agent, while its community's session is live to run it in. */
  ready(key: AgentKey) {
    const agent = this.agent(key);
    return agent && this.connections.binding(agent) ? agent : undefined;
  }
  /** The running agent's community, while the Runner is connected to it. */
  relay(key: AgentKey) {
    return this.connections.relay(originOf(this.agent(key)?.relay ?? ""));
  }
  /** Stops it all without reconciling, which would make new runners. */
  clear() {
    this.connections.clear();
    this.runners.clear();
    this.state = { running: [], interrupted: [] };
  }

  /** Delivers the session's live events, and retries what failed whenever its
   * connection recovers, which happens within the same session. A subscription
   * that comes back, after a reconnect or a failed route, first sends its
   * recent history again: what in it is new since this listener started was
   * missed while it was down, and is delivered now (`seen` drops the rest).
   * Older history is catch-up's, not replay's. */
  private listen(
    session: RelaySession,
    origin: string,
    connection: Connection,
  ) {
    let connected = session.live.snapshot().status === "connected";
    const since = connection.start;
    if (connected) Object.assign(connection, { epoch: 1, since });
    const heard = (agent: Agent) => originOf(agent.relay) === origin;
    const stopEvents = session.subscribeLive(
      (batch) => this.runners.dispatch(batch, heard, since),
      { replay: true },
    );
    const stopStatus = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (now !== connected) {
        // Catch-up reads what this connect may have missed, up to now.
        connection.epoch += now ? 1 : 0;
        connection.since = now ? Math.floor(Date.now() / 1000) : undefined;
      }
      if (now && !connected) this.refreshCore(origin);
      connected = now;
      this.runners.catchUp(false);
    });
    // A roster the relay confirms decides the events held for it.
    const stopRosters = session.channels.subscribeList?.(() =>
      this.runners.releaseHeld(heard),
    );
    return () => {
      stopEvents();
      stopStatus();
      stopRosters?.();
    };
  }
  /** Refreshes the cached `core` memory of each agent running in the
   * community, which may have changed elsewhere while it was not connected. */
  refreshCore(origin: string) {
    for (const agent of this.state.running)
      if (originOf(agent.relay) === origin)
        void this.coreMemory.refresh(agent.key);
  }
}

const same = (next: readonly Agent[], prior: readonly Agent[]) =>
  next.length === prior.length &&
  next.every((agent, index) => agent === prior[index]);
/** A membership as it runs here. */
function view(identity: Member, record: AgentRecord): Agent {
  return Object.freeze({
    key: identity.key,
    pubkey: identity.pubkey,
    name: identity.name,
    ...(identity.picture && { picture: identity.picture }),
    type: identity.type,
    owner: identity.owner,
    relay: identity.relay,
    place: "here",
    attention: record.attention,
    skipped: record.skipped ?? EMPTY,
    timers: record.timers ?? EMPTY,
    ...(record.sourceRuns ? { sourceRuns: record.sourceRuns } : {}),
    attentionHistory: record.attentionHistory,
    attentionEnabled: record.attentionEnabled === true,
    config: record.config,
  });
}
