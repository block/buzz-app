// Turns Agents deliveries into Claude turns. Each agent of this type has its
// own sessions; a delivery becomes a prompt in the harness format, sent to the
// session for its conversation; a standalone turn, such as a watch's or a
// timer's, runs as a one-off process. The run returns once the turn is handed over,
// so one agent works in several conversations at once. Claude acts in Buzz with
// the in-process Buzz tools, signed by the agent's native-held key; the runtime
// only reports a turn that fails.
import type { Context } from "../../buzz-mcp/client";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { type Listing, respond } from "../../buzz-mcp/rpc";
import {
  type AddedTool,
  addedKey,
  sessionHint,
  turnNote,
} from "../../buzz-mcp/session-tools";
import { fromOwner, workflowOf } from "../../features/agents/owner-attestation";
import type { AgentReads } from "../../features/agents/reads";
import { localStore, type AgentStore } from "../../features/agents/store";
import type {
  Agent,
  AgentHandle,
  Agents,
  Delivery,
  Effort,
  Models,
  StandaloneTurn,
  TurnResult,
} from "../../features/agents/service";
import { localKey } from "../../features/agents/service";
import {
  inputsOf,
  unsupportedSetting,
  type AgentSettings,
  type Applied,
} from "../../features/agents/settings";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type {
  ClaudeModel,
  ClaudeProcess,
  Settled,
  Spawn,
  ToolServer,
  TurnPick,
} from "./claude";
import { appClient, readFile } from "../../buzz-mcp/app-client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import {
  type Project,
  readProject,
} from "../../features/agent-harness/project";
import { SessionControls } from "../../features/agent-harness/session-control";
import type {
  SessionPlace,
  SessionControlAction,
  SessionState,
} from "../../features/agents/service";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "./prompt";
import { AgentSessions, localSessions, Refused, Spare } from "./sessions";
import {
  readSessionTitle,
  readTranscript,
  type Conversation,
} from "./transcript";

/** The effort levels Claude lists, which a session can switch to between
 * turns. Claude runs `max` as `xhigh` in a stream-json session, so it is not
 * offered. */
export const effortChoices = (levels: readonly string[]): Effort[] =>
  [...new Set(levels)]
    .filter((id) => id !== "max")
    .map((id) => ({ id, label: effortLabel(id) }));
export const effortLabel = (id: string) =>
  id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

/** The effort levels a listed model takes. */
export const effortLevels = (model: ClaudeModel) =>
  model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []);

/** Why `process` can't run an explicit pick: a model it doesn't list, or an
 * effort that model lacks. Waits for the list the process reports when it
 * starts; an empty list can't confirm a refusal, so the pick goes to Claude
 * as asked. */
export const refusedPick = async (
  process: Pick<ClaudeProcess, "models" | "readModel">,
  { model, effort }: TurnPick,
): Promise<Refused | undefined> => {
  const listed = (await process.models()).filter(
    (row) => row.value !== "default",
  );
  if (!listed.length) return undefined;
  const runs = model ?? (await process.readModel());
  const row = listed.find(
    (item) => item.value === runs || item.resolvedModel === runs,
  );
  if (model && !row)
    return unsupportedSetting(
      "model",
      model,
      `Claude can't run the picked model "${model}" here. Pick an available model.`,
    );
  // An own model Claude doesn't list runs at any effort a listed one has.
  const levels = row ? effortLevels(row) : listed.flatMap(effortLevels);
  if (effort && !effortChoices(levels).some((level) => level.id === effort))
    return unsupportedSetting(
      "effort",
      effort,
      `The picked effort "${effort}" isn't available for ${runs ? modelName(runs) : "this model"}. Pick a supported effort.`,
    );
  return undefined;
};

export type Config = Readonly<{
  /** A Claude model or alias; empty uses Claude's own default. */
  model: string;
  /** An effort level the model lists; empty uses Claude's own default. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
});
export const config = (value: unknown): Config => ({
  ...DEFAULT_CONFIG,
  ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
});

/** A saved session, for the owner's transcript list. */
export type SavedConversation = Conversation & {
  key: string;
  sessionId: string;
  /** The channel's name, when this community lists it. */
  name?: string;
  at: number;
};

const NAMES_TIMEOUT_MS = 2_000;
const CHAT = [9, 40002];

type Entry = {
  sessions: AgentSessions;
  /** What a conversation started from here on runs with, its config
   * resolved: from the latest delivery or local change, never an older one.
   * A running process keeps its own until its epoch moves. */
  applied: Applied<Config>;
  /** The agent's name as last synced; a rename restarts idle sessions. */
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** The local row's key as last synced; only its change replaces
   * `applied` here. */
  local?: string;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
  /** The project folders each Solo chat's latest process started in, kept
   * by a turn whose Canvas couldn't be read. */
  directories: Map<string, readonly string[]>;
  /** Each conversation's latest posting policy: when its turns were handed
   * over, and when all of them settled. */
  policies: Map<
    string,
    {
      topLevel: boolean;
      handed: Promise<unknown>;
      settled: Promise<unknown>;
      cancel(): void;
    }
  >;
};

/** Where an agent's processes run, and with which model and effort. */
const where = ({ workspace, model, effort }: Config) => ({
  cwd: workspace,
  ...(model.trim() ? { model: model.trim() } : {}),
  ...(effort ? { effort } : {}),
});

/** How Claude lists the session tools: in full up front only those marked
 * `alwaysLoad`, and the rest by name until its tool search loads them, with
 * the server's instructions saying what they are. */
const listing = (added: readonly AddedTool[]): Listing => ({
  instructions: sessionHint(added),
  tool: ({ load, ...tool }) =>
    load === "always"
      ? { ...tool, _meta: { "anthropic/alwaysLoad": true } }
      : tool,
});

export class ClaudeRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  /** Each agent's last session list, kept until something changes so a view
   * reading it gets the same array back. */
  private readonly views = new Map<
    string,
    ReturnType<AgentSessions["snapshot"]>
  >();
  /** Solo chats whose title was already offered to the host this app run. */
  private readonly titled = new Set<string>();
  /** One process started ahead of need, for any agent's next new conversation. */
  private readonly spare = new Spare(
    (id, options) => this.spawn(id, options),
    (_conversation, message) =>
      respond(undefined, {}, message, this.added(), listing(this.added())),
    undefined,
    () => addedKey(this.added()),
  );

  constructor(
    private readonly host: Pick<Host, "spawn">,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (pubkey: string) => AgentReads | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: AgentStore = localStore(),
    private readonly resolveConfig: (raw: unknown) => Config = config,
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
  ) {}

  private get spawn(): Spawn {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn) throw new Error("Claude agents run only in the desktop app");
    return spawn;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * restart idle sessions, removed agents stop, and a spare waits while any
   * agent is here. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    // Deleted, signed out or its community disconnected: either way its
    // processes stop. Saved sessions stay so it resumes when it is back.
    for (const [pubkey, entry] of this.agents)
      if (!current.has(pubkey)) {
        entry.sessions.dispose();
        this.agents.delete(pubkey);
      }
    for (const agent of agents) {
      const local = localKey(agent, this.resolveConfig({}));
      const current = { settings: agent.settings, epoch: agent.epoch };
      const entry = this.agents.get(agent.pubkey);
      if (!entry) {
        Object.assign(this.entry(agent.pubkey, current), {
          name: agent.name,
          local,
        });
        continue;
      }
      if (entry.local === local && entry.name === agent.name) continue;
      // Only a change of the local row replaces delivered settings, and its
      // epoch restarts the agent; a remote edit waits for a delivery.
      if (entry.local !== undefined && entry.local !== local)
        this.install(entry, current);
      else if (entry.name !== agent.name)
        entry.applied = {
          ...entry.applied,
          settings: { ...entry.applied.settings, name: agent.name },
        };
      entry.local = local;
      entry.name = agent.name;
      entry.sessions.reconfigure();
    }
    this.spare.warm(
      ...agents.map((agent) => where(this.resolveConfig(agent.config))),
    );
    this.notify();
  }

  /** The models the agent's next turn can run on, with their effort levels.
   * Without a pick it uses its own: the configured one, or else the one its
   * sessions report. `default` duplicates a listed model, so it is not offered.
   * It describes the settings the host has for `agent` now, which a running
   * conversation may not have applied yet, and applies nothing. */
  async models(agent: Pick<Agent, "pubkey" | "config">): Promise<Models> {
    const entry = this.agents.get(agent.pubkey);
    const settings = this.resolveConfig(agent.config);
    const configured = settings.model.trim();
    const {
      models: listed,
      model: reported,
      effort,
    } = (await entry?.sessions.metadata(undefined, {
      snapshot: snapshot(settings),
      where: where(settings),
    })) ?? { models: [] };
    // A turn without a pick keeps the session's effort on any model.
    const resting = (efforts: readonly Effort[]) =>
      effort && efforts.some((level) => level.id === effort) ? { effort } : {};
    const own = configured || reported || "";
    const offered = listed.filter((model) => model.value !== "default");
    const models = offered.map((model) => {
      const offeredEfforts = effortChoices(effortLevels(model));
      return {
        id: model.value,
        label: modelName(model.resolvedModel ?? model.value),
        efforts: offeredEfforts,
        ...resting(offeredEfforts),
      };
    });
    const current =
      offered.find(
        (model) => own === model.value || own === model.resolvedModel,
      )?.value ?? own;
    if (models.some((model) => model.id === current))
      return { current, models };
    // An own model Claude does not list is still the one it runs, at any
    // effort a listed model has.
    const ownEfforts = effortChoices(offered.flatMap(effortLevels));
    return {
      current,
      models: [
        {
          id: current,
          label: current ? modelName(current) : "Claude",
          efforts: ownEfforts,
          ...resting(ownEfforts),
        },
        ...models,
      ],
    };
  }

  /** Why a synced effort refuses a turn that runs on current config: the
   * model doesn't offer it, which Claude would otherwise run at another
   * level, or Claude's model list can't confirm it (NIP-AP "Settings"). */
  private async refusedEffort(
    entry: Entry,
    settings: Config,
    synced: AgentSettings["synced"],
    key?: string,
  ): Promise<Refused | undefined> {
    const effort = synced.effort;
    if (!effort) return undefined;
    // Claude's defaults for these settings, not whatever the agent has now.
    const { models, model: reported } = await entry.sessions.metadata(key, {
      snapshot: snapshot(settings),
      where: where(settings),
    });
    const wanted = settings.model.trim() || reported;
    const listed = models.find(
      (model) =>
        model.value !== "default" &&
        (model.value === wanted || model.resolvedModel === wanted),
    );
    if (!listed)
      return unsupportedSetting(
        "effort",
        effort,
        `The synced effort "${effort}" couldn't be checked: Claude doesn't list ${wanted ? `the model ${wanted}` : "its model"}.`,
      );
    if (
      effortChoices(effortLevels(listed)).some((level) => level.id === effort)
    )
      return undefined;
    return unsupportedSetting(
      "effort",
      effort,
      `The synced effort "${effort}" isn't available for ${modelName(listed.resolvedModel ?? listed.value)}. Choose a supported effort in Settings.`,
    );
  }

  /** Conversations each agent has running, for its status view. */
  sessions(pubkey: string) {
    let view = this.views.get(pubkey);
    if (!view) {
      view = this.agents.get(pubkey)?.sessions.snapshot() ?? [];
      this.views.set(pubkey, view);
    }
    return view;
  }
  /** The agent's saved sessions, most recently used first. */
  conversations(pubkey: string): SavedConversation[] {
    const reads = this.reads(pubkey);
    return localSessions(this.storage, pubkey)
      .list()
      .map(([key, saved]) => {
        const [channelId = key, root] = key.split("/");
        const name = reads?.channelName(channelId);
        return {
          key,
          agent: pubkey,
          sessionId: saved.id,
          channelId,
          ...(root ? { root } : {}),
          ...(name ? { name } : {}),
          at: saved.at,
        };
      });
  }
  /** A conversation's transcript, found from the workspace it ran in. */
  transcript(
    conversation: Conversation,
    workspace: string,
    working: boolean,
    signal: AbortSignal,
  ) {
    return readTranscript(this.spawn, workspace, conversation, working, signal);
  }
  /** The agent's latest session for a conversation that another build of the
   * app started, found in the workspace's Claude Code history. */
  async find(
    pubkey: string,
    place: Readonly<{ channelId: string; root?: string }>,
    workspace: string,
    signal: AbortSignal,
  ): Promise<SavedConversation | undefined> {
    const transcript = await readTranscript(
      this.spawn,
      workspace,
      { agent: pubkey, ...place },
      false,
      signal,
    );
    const last = transcript?.turns.at(-1);
    if (!last?.sessionId) return undefined;
    const name = this.reads(pubkey)?.channelName(place.channelId);
    return {
      key: place.root ? `${place.channelId}/${place.root}` : place.channelId,
      agent: pubkey,
      sessionId: last.sessionId,
      ...place,
      ...(name ? { name } : {}),
      at: last.endedAt ?? last.startedAt,
    };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.views.clear();
    for (const listener of this.listeners) listener();
  }
  private readonly controls = new SessionControls(() => this.notify());
  /** The conversation a control acts on: the one a turn in `place` goes to. */
  private controlKey(agent: Agent, place: SessionPlace) {
    if (!place.root) return place.channelId;
    return this.pinnedKey(
      this.agents.get(agent.pubkey),
      { settings: agent.settings, epoch: agent.epoch },
      place.channelId,
      `${place.channelId}/${place.root}`,
    );
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = this.controlKey(agent, place);
    if (this.controls.compacting(`${agent.pubkey}/${key}`)) return "compacting";
    const entry = this.agents.get(agent.pubkey);
    return this.controls.active(`${agent.pubkey}/${key}`) ||
      entry?.policies.has(key) ||
      entry?.sessions.active(key)
      ? "active"
      : "idle";
  }
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    const key = this.controlKey(agent, place);
    const control = `${agent.pubkey}/${key}`;
    const entry =
      this.agents.get(agent.pubkey) ??
      this.entry(agent.pubkey, {
        settings: agent.settings,
        epoch: agent.epoch,
      });
    if (action === "interrupt") {
      this.controls.interrupt(control);
      entry.policies.get(key)?.cancel();
      await entry.sessions.interrupt(key);
      return;
    }
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    return this.controls.run(control, action, async (signal) => {
      signal.throwIfAborted();
      if (action === "new") await entry.sessions.forget(key);
      else {
        const result = await entry.sessions.compact(key);
        if (!result.ok) throw new Error(result.error);
      }
      signal.throwIfAborted();
    });
  }

  dispose() {
    this.spare.dispose();
    for (const entry of this.agents.values()) entry.sessions.dispose();
    this.agents.clear();
  }

  async run({
    trigger,
    agent,
    attempt,
    channelId,
    model,
    effort,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
    interruptible,
    named,
  }: Delivery) {
    const settings = this.resolveConfig(attempt.settings.config);
    const { synced } = attempt.settings;
    // Watches and timers come as standalone turns (`runOnce`).
    if (trigger.type !== "mention") return ignored?.();
    // Claude runs commands as you; mentions need owner or delegated authority.
    if (
      !(await fromOwner(
        trigger.event,
        agent.owner,
        workflowOf(this.reads(agent.pubkey), agent.pubkey),
      ))
    ) {
      ignored?.();
      return;
    }
    signal.throwIfAborted();
    const entry = this.delivery(agent.pubkey, attempt);
    // Set before `key` and the effort check read the fingerprint.
    entry.handle = agent;
    const { event } = trigger;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    const topLevel =
      (await this.reads(agent.pubkey)?.soloChat(
        agent.owner,
        channel,
        signal,
      )) ?? false;
    // Frozen with the policy: a scope change while this waits must not move
    // its prompt to another conversation than the one it is delivered to.
    const key = await this.key(
      entry,
      attempt,
      agent.pubkey,
      event,
      channel,
      topLevel,
    );
    // Only a Solo chat's Canvas is handed over; its folders go with the
    // prompt that describes them to the process it runs in.
    const canvas = async () =>
      topLevel ? this.project(entry, agent.pubkey, channel) : undefined;
    const project = await canvas();
    const folders = project?.directories;
    // Checked again where the turn is delivered; refused now when it can't
    // keep its process, so the host is told.
    const refused =
      (!model &&
        !effort &&
        (await this.refusedEffort(entry, settings, synced, key))) ||
      undefined;
    if (refused && !entry.sessions.pinned(key, folders)) throw refused;
    signal.throwIfAborted();
    const handoff = this.controls.deliver(
      `${agent.pubkey}/${key}`,
      async (deferred) => {
        // Accepted deferred work belongs to the captured agent lifetime, not
        // the short deadline for handing a message to the harness.
        if (this.agents.get(agent.pubkey) !== entry) return;
        if (!deferred) signal.throwIfAborted();
        // `fresh` is for a session that has been shown nothing yet.
        const prompt = async (fresh: boolean, read?: Project) => {
          const text = turnPrompt({
            ...(await this.turn(
              entry,
              agent.pubkey,
              event,
              channel,
              key,
              topLevel,
              read,
              fresh,
            )),
            agent: agent.pubkey,
            label: "@mention",
          });
          return this.review(
            entry,
            trigger.resumed ? `${text}\n\n${RESUMED_PROMPT}` : text,
          );
        };
        // A turn keeps the posting policy it was admitted with: a request under
        // the other policy waits for the conversation's turns to settle rather
        // than steering into them and changing their tools' context.
        const prior = entry.policies.get(key);
        const same = prior?.topLevel === topLevel;
        const wait = prior && (same ? prior.handed : prior.settled);
        let delivered!: Promise<Settled>;
        let interrupted = false;
        const handed = (async () => {
          await wait;
          if (interrupted) {
            delivered = Promise.resolve({ ok: true });
            return;
          }
          const text = await prompt(false, project);
          if (interrupted) {
            delivered = Promise.resolve({ ok: true });
            return;
          }
          // A conversation's tools default to its thread; a session shared by
          // several threads is told which to reply in instead.
          entry.contexts.set(
            key,
            topLevel
              ? { channel, topLevel }
              : key === channel
                ? { channel }
                : { channel, root: threadReference(event)?.rootId ?? event.id },
          );
          delivered = entry.sessions.deliver(key, text, event.created_at, {
            steer: steerPrompt(text),
            fresh: async () => {
              const read = await canvas();
              return {
                text: await prompt(true, read),
                folders: read?.directories,
              };
            },
            folders,
            attempt,
            activityScope: topLevel
              ? channel
              : (threadReference(event)?.rootId ?? event.id),
            ...(step ? { step } : {}),
            ...(acknowledged ? { acknowledged } : {}),
            ...(superseded ? { superseded } : {}),
            pick: {
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
            },
          });
        })();
        const done = handed.then(
          () => delivered,
          (error: unknown): Settled => ({ ok: false, error: String(error) }),
        );
        const policy = {
          topLevel,
          cancel() {
            interrupted = true;
            prior?.cancel();
          },
          handed: handed.catch(() => undefined),
          settled: Promise.all([same ? prior.settled : undefined, done]).then(
            () => undefined,
          ),
        };
        entry.policies.set(key, policy);
        void policy.settled.then(() => {
          if (entry.policies.get(key) === policy) entry.policies.delete(key);
        });
        // Deliveries keep their order: a later one waits on this handover, and
        // one with nothing to wait for is handed over before `run` returns.
        if (!wait) await handed;
        // The turn outlives `run`, which the host is told so it shows it as working.
        workingUntil(done);
        interruptible?.(() => entry.sessions.interrupt(key));
        this.notify();
        this.watch(done, async (error) => {
          if (error) await this.report(agent, channel, event, error, topLevel);
        });
        if (topLevel && named)
          void this.offerTitle(
            done,
            agent.pubkey,
            key,
            settings.workspace,
            named,
          );
      },
    );
    if (!handoff.deferred) return handoff.done;
    workingUntil(handoff.done);
    void handoff.done
      .catch((error) =>
        this.report(agent, channel, event, String(error), topLevel),
      )
      .catch((error) => console.warn("Claude handover failed", error));
  }

  /** After a Solo chat's turn, offers the host the title Claude Code generated
   * for its session, once. The host decides whether the chat takes it. */
  private async offerTitle(
    done: Promise<Settled>,
    pubkey: string,
    key: string,
    workspace: string,
    named: (title: string) => void,
  ) {
    const once = `${pubkey}:${key}`;
    if (this.titled.has(once)) return;
    this.titled.add(once);
    if (!(await done).ok) {
      // A failed turn has offered no title; a successful retry may still name it.
      this.titled.delete(once);
      return;
    }
    const signal = AbortSignal.timeout(30_000);
    // Claude Code writes the title alongside the first reply; give it a moment.
    for (const wait of [0, 3_000, 10_000]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const session = localSessions(this.storage, pubkey).get(key)?.id;
      if (!session || signal.aborted) return;
      try {
        const title = await readSessionTitle(
          this.spawn,
          workspace,
          session,
          signal,
        );
        if (title) return named(title);
      } catch (error) {
        console.warn("Claude could not read its session title", error);
        return;
      }
    }
  }

  /** Runs a standalone turn, such as a watch's or a timer's, as a one-off
   * process: a new session that is not saved. */
  async runOnce({
    delivery,
    key,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, attempt } = delivery;
    const entry = this.delivery(agent.pubkey, attempt);
    entry.handle = agent;
    const done = entry.sessions.runOnce(key, prompt, attempt);
    this.notify();
    return done.finally(() => this.notify());
  }

  /** `text` with the Buzz tools' end-of-turn note, when they have one. */
  private review(entry: Entry, text: string) {
    const note = turnNote(entry.handle);
    return note ? `${text}\n\n${note}` : text;
  }

  private watch(
    done: Promise<{ ok: boolean; error?: string }>,
    after: (error?: string) => unknown,
  ) {
    void done
      .then((result) => after(result.ok ? undefined : result.error))
      .catch((error) => console.warn("Claude turn failed", error))
      .finally(() => this.notify());
  }

  /** Says in the thread that a turn failed, so nobody waits on it. Tells the
   * owner even when a sibling asked: tagging the sibling would wake it, and two
   * agents failing alike would wake each other without end. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
  ) {
    return agent
      .publish({
        kind: 9,
        content: `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ["p", agent.owner],
        ],
      })
      .catch((failure) =>
        console.warn("Claude could not report a failed turn", failure),
      );
  }

  /** The conversation the event's turn goes to: a Solo chat or DM is one
   * conversation, as is a channel for an agent with channel scope. A
   * conversation pinned since the last local Save keeps the key its own scope
   * gave it, so a remote scope change never moves it; the thread's wins. */
  private async key(
    entry: Entry,
    attempt: Applied,
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const summary = await this.reads(self)?.channel(channelId);
    if (topLevel || summary?.dm === true) return channelId;
    return this.pinnedKey(
      entry,
      attempt,
      channelId,
      `${channelId}/${threadReference(event)?.rootId ?? event.id}`,
    );
  }
  /** Which of `channelId` and `thread` a turn admitted on `attempt` goes to.
   * One pinned at its epoch keeps the key its own scope gave it, and the
   * thread's wins; otherwise the attempt's scope picks. */
  private pinnedKey(
    entry: Entry | undefined,
    attempt: Pick<Applied, "settings" | "epoch">,
    channelId: string,
    thread: string,
  ) {
    const pinnedAs = (key: string, scope: Config["scope"]) => {
      const pin = entry?.sessions.pinOf(key);
      return (
        !!pin &&
        pin.epoch === attempt.epoch &&
        this.resolveConfig(pin.settings.config).scope === scope
      );
    };
    if (pinnedAs(thread, "thread")) return thread;
    if (pinnedAs(channelId, "channel")) return channelId;
    return this.resolveConfig(attempt.settings.config).scope === "channel"
      ? channelId
      : thread;
  }

  /** A Solo chat's Canvas; undefined when it couldn't be read. */
  private project(entry: Entry, self: string, channelId: string) {
    const reads = this.reads(self);
    const canvas = reads?.canvas?.bind(reads);
    const owner = entry.handle?.owner;
    return readProject(
      canvas && owner ? () => canvas(channelId, owner) : undefined,
    );
  }

  /** Where the event's turn goes, and what its prompt needs, `project` its
   * Solo chat's Canvas. */
  private async turn(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    key: string,
    topLevel: boolean,
    project: Project | undefined,
    fresh = false,
  ) {
    const reads = this.reads(self);
    const summary = await reads?.channel(channelId);
    const dm = summary?.dm === true;
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    const seen = fresh ? 0 : entry.sessions.seen(key);
    let earlier: readonly EventData[] = [];
    // A chat its owner is still creating has nothing earlier to read.
    if (reads && !summary?.starting && (thread || dm || topLevel))
      try {
        const events = await reads.read(
          thread && !topLevel
            ? [
                { ids: [rootId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          AbortSignal.timeout(NAMES_TIMEOUT_MS * 2),
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("Claude could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too.
    const unseen = earlier.filter(
      (item) => item.created_at > seen && (!seen || item.pubkey !== self),
    );
    const pubkeys = [
      ...new Set([
        event.pubkey,
        ...unseen.map((item) => item.pubkey),
        ...event.tags
          .filter((tag) => tag[0] === "p")
          .map((tag) => tag[1] ?? ""),
      ]),
    ].filter(Boolean);
    if (reads)
      await Promise.race([
        reads.profiles(pubkeys).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS)),
      ]);
    const members = summary?.members ?? [];
    return {
      key,
      event,
      scope,
      topLevel,
      channel: {
        id: channelId,
        ...(summary?.name ? { name: summary.name } : {}),
        dm,
      },
      ...(thread ? { thread } : {}),
      context: unseen,
      total: earlier.length + 1,
      name: (pubkey: string) => reads?.name(pubkey, members),
      ...(project?.section ? { project: project.section } : {}),
    };
  }

  /** Whether a conversation is pinned to settings other than `settings`,
   * what the host now resolves for the agent: it shows Restart to apply. */
  outdated(pubkey: string, settings: AgentSettings) {
    const key = pinKey(this.resolved({ settings, epoch: 0 }).settings);
    return !!this.agents
      .get(pubkey)
      ?.sessions.outdated((pin) => pinKey(pin.settings) === key);
  }
  /** Restart to apply: idle conversations stop now, busy ones once idle, and
   * each starts again on `applied`, which the host just applied. */
  restart(pubkey: string, applied: Applied) {
    const entry = this.agents.get(pubkey) ?? this.entry(pubkey, applied);
    this.install(entry, applied);
    entry.sessions.reconfigure();
  }

  /** The agent's entry for a delivery: a conversation started from here on
   * uses its settings, unless a newer epoch already replaced them. One
   * already running keeps its pin until its epoch moves. */
  private delivery(pubkey: string, applied: Applied): Entry {
    const entry = this.entry(pubkey, applied);
    this.install(entry, applied);
    return entry;
  }
  /** Replaces the entry's settings with `applied`, unless it is older. */
  private install(entry: Entry, applied: Applied) {
    if (applied.epoch >= entry.applied.epoch)
      entry.applied = this.resolved(applied);
  }
  private resolved({ settings, epoch }: Applied): Applied<Config> {
    return {
      settings: { ...settings, config: this.resolveConfig(settings.config) },
      epoch,
    };
  }

  private entry(pubkey: string, initial: Applied): Entry {
    const existing = this.agents.get(pubkey);
    if (existing) return existing;
    const entry: Entry = {
      applied: this.resolved(initial),
      sessions: undefined as unknown as AgentSessions,
      contexts: new Map(),
      policies: new Map(),
      directories: new Map(),
    };
    // Each process reads files where it was started, and keeps the tool list
    // it was given, until it is replaced.
    const tools =
      (cwd: string): ToolServer =>
      async (conversation, message) => {
        const handle = entry.handle;
        const client =
          handle &&
          appClient(handle, {
            relayAuthor: this.reads(pubkey)?.relayAuthor?.(),
            audienceAuthorityCommunity:
              this.reads(pubkey)?.audienceAuthorityCommunity?.(),
            signingAuthority: this.reads(pubkey)?.workflowAuthority(),
            read: (path) => readFile(this.spawn, cwd, path),
            memories: (slug) => this.memories(pubkey, slug),
            remembered: () => this.forget(pubkey),
          });
        const context =
          (conversation && entry.contexts.get(conversation)) || {};
        return respond(
          client,
          context,
          message,
          this.added(),
          listing(this.added()),
        );
      };
    entry.sessions = new AgentSessions({
      spawn: (id, options) => this.spawn(id, options),
      spare: this.spare,
      store: localSessions(this.storage, pubkey),
      onChange: () => this.notify(),
      fingerprint: (key, folders) =>
        JSON.stringify([
          key ? (folders ?? entry.directories.get(key) ?? []) : [],
          entry.applied.epoch,
          addedKey(this.added()),
        ]),
      inputs: () => inputsOf(entry.applied),
      snapshot: () => snapshot(entry.applied.settings.config),
      applied: () => entry.applied,
      refusedPick: (process, pick) => refusedPick(process, pick),
      launch: async (key, folders, skipEffort) => {
        // Read before anything is awaited, as `snapshot` and `fingerprint`
        // were: the settings checked and recorded are the ones it starts with.
        const { config, synced, blocked, name, team } = entry.applied.settings;
        const { workspace, instructions, scope } = config;
        // An unread Canvas keeps the folders the chat's process had.
        const directories = !key
          ? undefined
          : folders
            ? folders.length
              ? folders
              : undefined
            : entry.directories.get(key);
        // Every process a turn runs on starts here, retries included; a pick
        // doesn't run on settings admission would refuse either.
        if (blocked) throw new Refused(blocked);
        const refused =
          !skipEffort && (await this.refusedEffort(entry, config, synced, key));
        if (refused) throw refused;
        if (key && directories) entry.directories.set(key, directories);
        else if (key) entry.directories.delete(key);
        const memory = await this.core(pubkey);
        return {
          ...where(config),
          ...(directories ? { directories } : {}),
          tools: tools(workspace),
          systemPrompt: systemPrompt({
            scope,
            cwd: workspace,
            repositories: this.repositories(this.reads(pubkey)?.scope),
            ...(name ? { agent: { name, pubkey } } : {}),
            instructions,
            team,
            ...(memory === undefined ? {} : { memory }),
          }),
        };
      },
    });
    this.agents.set(pubkey, entry);
    return entry;
  }

  /** The agent's memory, or only entry `slug`, as its community's reads give
   * it. */
  private memories(pubkey: string, slug?: string) {
    const reads = this.reads(pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  private forget(pubkey: string) {
    const reads = this.reads(pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}

/** Everything a pin carries, as compared for Restart to apply. */
const pinKey = (settings: AgentSettings) =>
  JSON.stringify([
    snapshot(config(settings.config)),
    settings.synced,
    settings.blocked ?? null,
    settings.name,
    settings.team,
  ]);

/** The settings a process starts with. */
const snapshot = (config: Config) =>
  JSON.stringify([
    config.model,
    config.effort,
    config.workspace,
    config.instructions,
    config.scope,
  ]);

/** `claude-opus-5-5` reads as `Opus 5.5`, and an alias such as `opus` as
 * `Opus`. Anything else is shown as it is. */
export function modelName(model: string) {
  const id =
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(model);
  const family = id?.[1] ?? (/^[a-z]+$/.test(model) ? model : undefined);
  if (!family) return model;
  const name = family[0]?.toUpperCase() + family.slice(1);
  return id ? `${name} ${id[2]}${id[3] ? `.${id[3]}` : ""}` : name;
}
