// The Runner: the part of agents that runs them. It decides which agents run,
// and owns the agent runners and the agent storage they keep, which is
// records, catch-up progress, turns in progress and synced config copies.
// What it needs from the Manager, the part the screens use, it asks through
// `RunnerManager`; those facts and requests are what will cross the agents
// link when the Runner moves to its own page.
import { bytesToHex } from "nostr-tools/utils";
import { AgentConfigStore } from "./agent-config";
import { excerpt, mentionFacts, type ClassifierContext } from "./classifier";
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
import { ownerReads } from "./reads";
import { AgentRecords, EMPTY, type Member, type RecordEdit } from "./records";
import { AgentRunners, type Connection, type RunnerHost } from "./runner";
import type { AgentsNative } from "./native";
import type {
  Agent,
  AgentWake,
  ConfigBinding,
  HandoffSource,
  RegisteredAgentType,
  SessionControlAction,
  SessionPlace,
} from "./service";
import { soloChat } from "./solo-chat";
import { nameSoloChat } from "./solo-chat-name";
import type { AgentStore } from "./state";
import type { AgentRecord, Team } from "./store";
import { teamPrompt } from "./team-prompt";
import { relayPartition } from "../relay/partition";
import type { RelayEvent } from "../relay/events";
import type { RelayData } from "../relay/service";
import { threadReference } from "../relay/thread-reference";
import type { RelaySession } from "../relay/session";
import type { Decisions } from "../decisions/service";
import type {
  ClassifierAvailability,
  ClassifierKey,
} from "./attention-objects";
import { channelTabs } from "../../bundled/channels/useChannelTabState";

/** What the Runner asks of the Manager. */
export type RunnerManager = Pick<
  RunnerHost,
  | "createAgent"
  | "updateAgent"
  | "templates"
  | "keyStatus"
  | "classifierKey"
  | "classifierKeyGeneration"
  | "setClassifierKey"
> &
  Readonly<{
    /** The community's relay, while the viewer is in it. */
    open(origin: string): RelayData | undefined;
    types(): readonly RegisteredAgentType[];
    /** The settings a new agent of this type starts with. */
    defaults(pubkey: string, type: RegisteredAgentType): AgentRecord;
    /** Which artifact types an agent has synced. */
    configBinding?: ((agent: Agent) => ConfigBinding) | undefined;
  }>;

/** On the `typesafe` backend, agents are told a classifier can run only
 * while a key is known to be saved. A key the service refused still runs,
 * and each event reports why it passed unchecked. */
export function classifierAvailability(
  decisions: Decisions | undefined,
  classifierKey: ClassifierKey,
): ClassifierAvailability {
  if (!decisions) return "unavailable";
  if (decisions.backend() !== "typesafe") return "available";
  return classifierKey === "saved" || classifierKey === "refused"
    ? "available"
    : "unavailable";
}

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
  /** Which memberships this copy runs, which another copy holds, and which
   * are changing type. */
  private held: RunnerStatus = {
    runs: EMPTY_KEYS,
    yielded: EMPTY_KEYS,
    transitioning: EMPTY_KEYS,
  };
  /** The type each retyped agent has, until the memberships the Manager
   * sends say so too. */
  private readonly retyped = new Map<string, string>();
  /** The memberships it last decided from, and their viewer. */
  private identities: readonly Member[] = [];
  private viewer: string | undefined;
  /** The last full list it forgot records by. */
  private list: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly recordListeners = new Set<() => void>();
  private readonly typeListeners = new Set<() => void>();
  /** The owner's teams, as the Manager last sent them. */
  private teams: readonly Team[] = [];

  constructor(
    storage: AgentStore,
    private readonly custody:
      | (NonNullable<RunnerHost["custody"]> & Pick<AgentsNative, "setType">)
      | undefined,
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
      changed: () => {
        for (const listener of [...this.recordListeners]) listener();
        this.update();
      },
      // Its timers waited for this change, saved or failed.
      settled: (key) => this.runners.wake(key),
    });
    void splitLegacyCheckpoints(storage);
    this.configStore = new AgentConfigStore(storage);
    this.connections = new RunnerConnections({
      open: (origin) => manager.open(origin),
      listen: (session, origin, connection) =>
        this.listen(session, origin, connection),
      changed: (origin, renewed) => {
        this.update();
        if (renewed) this.refreshCore(origin);
      },
    });
    this.coreMemory = new CoreMemoryCache((key) =>
      ownerReads(this.relay(key), pubkeyOf(key)),
    );
    /** The catch-up progress this program last read or saved. */
    let savedProgress: Checkpoints = {};
    this.runners = new AgentRunners({
      ownershipChanged: () => this.status(),
      ready: (key) => this.ready(key),
      agent: (key) => this.agent(key),
      member: (agent, event) => this.member(agent, event),
      dm: (agent, event) => this.dm(agent, event),
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
        changed: () => this.update(),
      },
      scope: (agent) => this.connections.binding(agent)?.scope,
      saved: (key) => this.records.saved(key),
      record: (key) => {
        const member = this.liveMember(key);
        if (!member) throw new Error("No such agent on this device");
        return this.records.recordOf(member);
      },
      change: async (key, apply) => {
        const record = await this.records.change(key, () => {
          const member = this.liveMember(key);
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
      team: (key) => {
        const member = this.liveMember(key);
        const origin = member && originOf(member.relay);
        // Only teammates in the same community, where it can reach them.
        return member
          ? teamPrompt(
              this.teams,
              this.identities.filter(
                (identity) =>
                  !identity.deleted && originOf(identity.relay) === origin,
              ),
              member.pubkey,
            )
          : "";
      },
      agentTypes: () =>
        manager
          .types()
          .filter((type) => !type.remote)
          .map(({ key, title }) => ({ key, title })),
      createAgent: (agent, input) => manager.createAgent(agent, input),
      updateAgent: (agent, input) => manager.updateAgent(agent, input),
      handoff: (agent, { from, ...wake }) =>
        this.wake(agent.key, wake, { from }),
      templates: (agent) => manager.templates(agent),
      tabs: (agent) => {
        const session = this.connections.binding(agent)?.session;
        return session && channelTabs(session);
      },
      classifier: () =>
        classifierAvailability(decisions, manager.classifierKey()),
      decisions: () => decisions,
      keyStatus: () => manager.keyStatus(),
      classifierKey: () => manager.classifierKey(),
      classifierKeyGeneration: () => manager.classifierKeyGeneration(),
      setClassifierKey: (key, generation) =>
        manager.setClassifierKey(key, generation),
      context: (agent, event) => this.context(agent, event),
      displayName: (agent, pubkey) => this.displayName(agent, pubkey),
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

  /** Hears each change to what runs here, which of it was interrupted, who
   * holds it, or which is changing type. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Hears each change to a record. */
  subscribeRecords(listener: () => void) {
    this.recordListeners.add(listener);
    return () => {
      this.recordListeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  /** The memberships on this device, as the Manager last sent them, and
   * whether they are all of them (`loaded`): connects each community where
   * the viewer has an agent, decides again what runs, and forgets records
   * no membership keeps. */
  members(
    identities: readonly Member[],
    viewer: string | undefined,
    loaded: boolean,
  ) {
    // Only a new list can name a record no membership keeps.
    const list = JSON.stringify(identities);
    const listed = loaded && list !== this.list;
    if (loaded) this.list = list;
    for (const identity of identities)
      if (this.retyped.get(identity.pubkey) === identity.type)
        this.retyped.delete(identity.pubkey);
    this.identities = this.overlaid(identities);
    this.viewer = viewer;
    this.connections.watch(identities, viewer);
    this.update();
    if (listed) this.forget();
  }
  /** Removes the settings whose agent is gone, or that a community it left
   * kept: they do nothing. Its home record keeps its config while it is
   * anywhere. */
  private forget() {
    const live = new Set(
      this.identities
        .filter((saved) => !saved.deleted)
        .flatMap((saved) => [saved.key, saved.pubkey]),
    );
    for (const key of this.records.keys())
      if (!live.has(key))
        void this.records
          .edit(key, { kind: "remove" })
          .catch((error) =>
            console.warn(`Agent ${key} settings were not removed`, error),
          );
  }
  /** Agent types were loaded or unloaded. */
  typesChanged() {
    this.update();
    for (const listener of [...this.typeListeners]) listener();
  }
  /** The agent types registered here. */
  types() {
    return this.manager.types();
  }
  /** Hears each change to the agent types. */
  subscribeTypes(listener: () => void) {
    this.typeListeners.add(listener);
    return () => {
      this.typeListeners.delete(listener);
    };
  }
  /** The viewer joined or left a community: connects or lets go of it. A
   * new viewer waits for the memberships the Manager sends with it. */
  communitiesChanged(viewer: string | undefined) {
    if (viewer !== this.viewer) return;
    this.connections.watch(this.identities, this.viewer);
    this.update();
  }
  /** Gives the turns the app left `keys` working on last time again. */
  resumeInterrupted(keys: readonly AgentKey[]) {
    this.runners.resumeInterrupted(keys);
    this.update();
  }
  /** The owner's teams changed. */
  setTeams(teams: readonly Team[]) {
    this.teams = teams;
  }
  /** Forgets the turns the app left `keys` working on last time. */
  dismissInterrupted(keys: readonly AgentKey[]) {
    this.runners.dismissInterrupted(keys);
    this.update();
  }
  /** Applies the Manager's edit. Its config waits for no change of type: one
   * sent once that began would write the old type's config over the new. */
  async edit(key: AgentKey, edit: RecordEdit) {
    if (
      edit.kind === "settings" &&
      edit.change.config !== undefined &&
      this.runners.transitioning(key)
    )
      throw new Error(`${edit.member.name}'s provider is already changing`);
    await this.records.edit(key, edit);
  }
  /** Runs `action` on the agent's session in `place`, while this copy holds
   * the agent with the type `type`, as the owner last saw it. */
  async session(
    key: AgentKey,
    type: string,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    const kind = this.manager.types().find((entry) => entry.key === type);
    if (!kind?.sessionControls || this.agent(key)?.type !== type)
      throw new Error(
        "Use session controls in the Buzz app that runs this agent.",
      );
    await this.runners.control(key, async () => {
      const current = this.agent(key);
      if (current?.type !== type || !this.manager.types().includes(kind))
        throw new Error("The agent's harness changed. Try again.");
      await kind.sessionControls?.run(current, place, action);
    });
  }
  /** Gives the agent the type `type`, starting with `config`, while no turn
   * of it works and this copy holds it. It shows with the new type once that
   * config is saved; when the save fails, it keeps its type. */
  async retype(key: AgentKey, type: string, config: unknown) {
    const member = this.liveMember(key);
    const custody = this.custody;
    if (!member || !custody) throw new Error("No such agent on this device");
    const { pubkey, name } = member;
    const retyping = this.runners.retype(key, name, async () => {
      await custody.setType(pubkey, type);
      try {
        await this.records.change(
          pubkey,
          (saved) => ({
            ...(saved ?? this.records.settingsOf(member)),
            config,
          }),
          () => {
            this.retyped.set(pubkey, type);
            this.identities = this.overlaid(this.identities);
          },
        );
      } catch (error) {
        try {
          await custody.setType(pubkey, member.type);
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            `Could not save or restore ${name}'s provider`,
          );
        }
        throw error;
      }
    });
    this.status();
    try {
      await retyping;
    } finally {
      this.status();
    }
  }
  /** The types of retyped agents the Manager does not show yet, by pubkey. */
  retypes(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.retyped);
  }
  private overlaid(identities: readonly Member[]) {
    if (!this.retyped.size) return identities;
    return identities.map((identity) => {
      const type = this.retyped.get(identity.pubkey);
      return type && type !== identity.type ? { ...identity, type } : identity;
    });
  }
  /** Decides which agents run: each of the viewer's agents whose community is
   * joined and not disconnected. A reconnect does not stop one. An unfinished
   * Delete or Remove stops it, and its types' plugins stop what they keep for
   * it. Then each runner goes on with what it can do now. */
  private update() {
    const { identities, viewer } = this;
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
    const prior = this.state;
    this.state = {
      running: same(running, prior.running)
        ? prior.running
        : Object.freeze(running),
      interrupted: same(interrupted, prior.interrupted)
        ? prior.interrupted
        : Object.freeze(interrupted),
    };
    if (
      !this.status() &&
      (this.state.running !== prior.running ||
        this.state.interrupted !== prior.interrupted)
    )
      this.notify();
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
  /** Which memberships this copy runs, which another copy holds, and which
   * are changing type. */
  runnerStatus() {
    return this.held;
  }
  /** Reads again who holds each membership and which is changing type, and
   * says so when that changed. */
  private status() {
    const keys = this.identities
      .filter((identity) => !identity.deleted)
      .map((identity) => identity.key);
    const next: RunnerStatus = {
      runs: keys.filter((key) => this.runners.runs(key)),
      yielded: keys.filter((key) => this.runners.yielded(key)),
      transitioning: keys.filter((key) => this.runners.transitioning(key)),
    };
    const prior = this.held;
    const changed =
      !sameKeys(next.runs, prior.runs) ||
      !sameKeys(next.yielded, prior.yielded) ||
      !sameKeys(next.transitioning, prior.transitioning);
    if (!changed) return false;
    this.held = Object.freeze(next);
    this.notify();
    return true;
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
  /** The membership of this key, unless it was deleted. */
  liveMember(key: AgentKey) {
    return this.identities.find(
      (identity) => identity.key === key && !identity.deleted,
    );
  }
  /** Queues a plugin's wake, or the agent's own handoff, in the agent's
   * mention lane. Throws when this copy does not run the agent, or the lane
   * is full. */
  wake(
    key: AgentKey,
    { channel, root, text }: AgentWake,
    source: Readonly<{ plugin: string } | { from: HandoffSource }>,
  ) {
    if (!channel || !text.trim())
      throw new Error("A wake needs a channel and text");
    // Harnesses find the thread from a well-formed id; any other would leave
    // them answering at the wake's own id.
    if (root !== undefined && !/^[0-9a-f]{64}$/i.test(root))
      throw new Error("A wake's root must be the thread's 64-hex event id");
    this.runners.wakeIn(key, {
      type: "plugin",
      ...source,
      channel,
      ...(root ? { root: root.toLowerCase() } : {}),
      text,
      id: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      at: Date.now(),
    });
  }
  /** The running agent's community, while the Runner is connected to it. */
  relay(key: AgentKey) {
    return this.connections.relay(originOf(this.agent(key)?.relay ?? ""));
  }
  /** Stops it all without reconciling, which would make new runners. */
  clear() {
    this.connections.clear();
    this.runners.clear();
    this.identities = [];
    this.viewer = undefined;
    this.list = undefined;
    this.retyped.clear();
    this.state = { running: [], interrupted: [] };
    this.held = {
      runs: EMPTY_KEYS,
      yielded: EMPTY_KEYS,
      transitioning: EMPTY_KEYS,
    };
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
  /** The event's surroundings for the classifier, from what the app knows. */
  private async context(
    agent: Agent,
    event: RelayEvent,
  ): Promise<ClassifierContext> {
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    const channels = this.connections.binding(agent)?.session.channels;
    const summary = channelId
      ? (channels?.list().channels.find((item) => item.id === channelId) ??
        channels?.get?.(channelId))
      : undefined;
    const parent = threadReference(event)?.parentId ?? null;
    let found: RelayEvent | undefined;
    const native = this.custody;
    if (parent && native)
      try {
        // Bounded: classified events release in order, so a stuck lookup
        // would hold back every later one.
        let timer: ReturnType<typeof setTimeout> | undefined;
        [found] = await Promise.race([
          native.query(agent, [{ ids: [parent], limit: 1 }]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("The parent lookup timed out")),
              PARENT_LOOKUP_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      } catch {
        // The parent stays unknown; the classifier still runs.
      }
    return {
      channel: { name: summary?.name ?? null },
      thread: {
        is_reply: !!parent,
        parent: found
          ? {
              author: {
                role:
                  found.pubkey === agent.pubkey
                    ? "self"
                    : found.pubkey === agent.owner
                      ? "owner"
                      : "other",
                name: this.displayName(agent, found.pubkey),
              },
              content: excerpt(found.content),
            }
          : null,
      },
      mentions: mentionFacts(event.tags, agent.pubkey, agent.owner),
    };
  }
  private displayName(agent: Agent, pubkey: string) {
    return (
      this.connections.binding(agent)?.session.profiles?.snapshot().get(pubkey)
        ?.name ?? null
    );
  }
  /** The event's channel as the agent's community knows it, if at all. */
  private channelOf(agent: Agent, event: Pick<RelayEvent, "tags">) {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    const channels = this.connections.binding(agent)?.session.channels;
    if (!channel || !channels) return undefined;
    return (
      channels.list().channels.find((item) => item.id === channel) ??
      channels.get?.(channel)
    );
  }
  /** Whether the agent is in the event's channel, by its relay-signed roster.
   * The stream is the owner's, so a watch, even of "all", sees only what the
   * agent itself could read; an event with no channel, or whose roster is
   * unknown, wakes no watch. A roster only loaded from disk decides nothing
   * (undefined): the agent may have been removed or added since it was saved,
   * so the event waits until the relay confirms it. */
  private member(
    agent: Agent,
    event: Pick<RelayEvent, "tags">,
  ): boolean | undefined {
    const summary = this.channelOf(agent, event);
    if (summary?.cached) return undefined;
    return !!summary?.members?.includes(agent.pubkey);
  }
  /** Whether the event's channel is a DM of exactly the agent and one other,
   * by the same roster. A group DM, or one whose roster is unknown, is not. */
  private dm(agent: Agent, event: RelayEvent) {
    const summary = this.channelOf(agent, event);
    return (
      summary?.channelType === "dm" &&
      summary.members?.length === 2 &&
      summary.members.includes(agent.pubkey)
    );
  }
}

/** How long the classifier waits for a reply's parent before it goes on. */
const PARENT_LOOKUP_MS = 5_000;
const same = (next: readonly Agent[], prior: readonly Agent[]) =>
  next.length === prior.length &&
  next.every((agent, index) => agent === prior[index]);
/** Which memberships this copy runs, which another copy holds, and which are
 * changing type. */
export type RunnerStatus = Readonly<{
  runs: readonly AgentKey[];
  yielded: readonly AgentKey[];
  transitioning: readonly AgentKey[];
}>;
const EMPTY_KEYS: readonly AgentKey[] = Object.freeze([]);
const sameKeys = (next: readonly AgentKey[], prior: readonly AgentKey[]) =>
  next.length === prior.length &&
  next.every((key, index) => key === prior[index]);
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
