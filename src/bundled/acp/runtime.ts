// Turns Agents deliveries into turns in each ACP agent's own harness. An
// agent's harness runs the launch its owner confirmed; each conversation is
// one ACP session in it, and a watch or timer wake runs as a one-off session.
// The run returns once the turn is handed over. The harness acts in Buzz with
// the in-process Buzz tools over loopback HTTP MCP, signed by the agent's
// native-held key; the runtime only reports a turn that fails.
// The Buzz side (owner check, conversation context, memory, replies) follows
// the goose runtime's.
import { type AgentKey, pubkeyOf } from "../../features/agents/membership";
import type { Context, Memories } from "../../buzz-mcp/client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { respond } from "../../buzz-mcp/rpc";
import { appClient } from "../../buzz-mcp/app-client";
import {
  type AddedTool,
  addedKey,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  AgentSessions,
  type SessionsOptions,
} from "../../features/agent-harness/acp/agent-sessions";
import { readTranscript } from "../../features/agent-harness/acp/transcript";
import {
  ownerCanvas,
  readProject,
  worksElsewhere,
} from "../../features/agent-harness/project";
import {
  placeOf,
  replacedSections,
  sectionsOf,
} from "../../features/agent-harness/sections/compose";
import type { SectionChoices } from "../../features/agent-harness/sections/choices";
import {
  FRESH,
  type Generation,
  type Mark,
  type Pick,
  type Pinned,
  type RouteMatch,
  type ServeMcp,
  type Settled,
  type Source,
  type Spawn,
  type ToolServer,
} from "../../features/agent-harness/acp/types";
import type { Transcript } from "../../features/agents/activity-transcript";
import {
  mentionAuthority,
  type Agent,
  type AgentHandle,
  type Agents,
  type Delivery,
  type SessionControlAction,
  type SessionPlace,
  type SessionState,
  type StandaloneTurn,
  type TurnResult,
} from "../../features/agents/service";
import {
  conversationFolder,
  existingFolder,
  startingFolder,
} from "../../features/agents/conversation-folders";
import { soloChat } from "../../features/agents/solo-chat";
import { sessionPrompts } from "../../features/agents/session-prompts";
import { localStore, type AgentStore } from "../../features/agents/store";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  CONTEXT_LIMIT,
  type Scope,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import {
  digest,
  type SavedConversation,
  savedConversation,
} from "../../features/agent-harness/acp/agent-sessions";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { standalonePrompt } from "../goose/runtime";
import { readAuthorNames } from "../../features/agent-harness/author-names";
import {
  ownerReads,
  readyOwnerReads,
  workflowMarked,
} from "../../features/agents/reads";
import { workflowOf } from "../../features/agents/owner-attestation";
import { offers } from "../../features/agent-harness/acp/options";
import { unsupportedSynced } from "../../features/agents/agent-config";
import {
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import { type Config, config } from "./config";
import { AUTH_REQUIRED } from "../../features/agent-harness/acp/steps";
import { HarnessProcess, start } from "./harness";
import { launchKey, type ModelCache } from "./models";
import { preset } from "./presets";
import { localOwed, localSessions } from "./sessions";
import type { Conversation, SignIn } from "./tabs";

const CONVERSATION_READ_TIMEOUT_MS = 4_000;
const CHAT = [9, 40002];
/** No extension picks a model: the launch's args or env do. */
const HARNESS_CHOICE = Object.freeze({ provider: "", model: "" });
const LABEL = "ACP agent";
/** What a failed turn says in the channel. The harness's own error can carry
 * anything, secrets included, so it stays in the turn's local activity. */
const FAILED = "⚠️ I couldn't finish that. Details are in my activity.";

/** The settings a harness process is started with; a change makes a new
 * launch generation. */
const launchOf = ({ command, args, env, workspace, approval }: Config) =>
  JSON.stringify([command, args, env, workspace, approval]);

/** Sets or clears `entry`'s sign-in state from the `result` of a turn
 * delivered on launch `generation`; an older launch's says nothing of it. */
function signedIn(entry: Entry, generation: Generation, result: Settled) {
  if (generation !== entry.generation) return;
  // A stopped or undelivered turn proves nothing about signing in.
  if (result.ok && !result.stopped && !result.undelivered)
    entry.signIn = undefined;
  else if (result.code === AUTH_REQUIRED)
    entry.signIn = {
      methods: (result.authMethods ?? []).map(({ name, description }) => ({
        name,
        ...(description ? { description } : {}),
      })),
    };
}

/** What a live session pins when it opens, and runs on until it closes. */
type Snap = Readonly<{
  config: Config;
  team: string;
  name?: string;
  /** The tools plugins added, as `addedKey`. */
  added: string;
  /** Its model is synced: one the harness doesn't offer is refused. */
  syncedModel?: true;
  /** The base prompt's section choices for its conversation, taken as the
   * session is pinned: its prompt and Canvas both use these. */
  sections?: SectionChoices;
  /** The folder a plugin gave its conversation, which it works in. */
  folder?: string;
}>;

/** Everything a session is opened with, so a saved one resumes only while
 * none of it changed. The launch counts by its confirmation digest, never
 * its env values. */
const contextOf = ({ config: c, team, name, added, sections, folder }: Snap) =>
  digest(
    JSON.stringify([
      c.approval,
      c.workspace,
      c.instructions,
      team,
      name ?? "",
      added,
      c.scope,
      replacedSections(sections),
      folder ?? "",
    ]),
  );

/** Where a message sits: its channel, its thread root, and whether the
 * channel is one conversation whatever the scope (a DM or Solo chat). */
type Place = Readonly<{ channel: string; root: string; whole: boolean }>;

/** The conversation `place` belongs to under `scope`. Only a thread key
 * names exactly one thread. */
const keyOf = (
  scope: Config["scope"],
  { channel, root, whole }: Place,
): RouteMatch =>
  whole || scope === "channel"
    ? { key: channel, exact: false }
    : { key: `${channel}/${root}`, exact: true };

type Entry = {
  sessions: AgentSessions<Snap>;
  /** The current launch generation; a launch change makes the next one. */
  generation: Generation;
  /** The agent's saved conversations on this device. */
  store: ReturnType<typeof localSessions>;
  /** The sign-in its last failed turn asked for, until a turn succeeds or
   * Recheck restarts the harness. */
  signIn?: SignIn | undefined;
  /** Whether its harness replays sessions, once a transcript read found out. */
  replays?: boolean;
  /** The agent's own harness, running its confirmed launch. */
  harness: HarnessProcess;
  config: Config;
  /** The team sections of the latest run; a change reopens idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename reopens idle sessions. */
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each session's tools default to, and the handle they act with:
   * its current turn's. */
  places: WeakMap<Snap, { context: Context; handle: AgentHandle }>;
  /** Each conversation's folder as saved storage settled it before its
   * session was pinned: none when it starts in the workspace. */
  folders: Map<string, string | undefined>;
  /** Whether the latest delivery's model was synced. */
  syncedModel?: boolean;
};

/** A conversation's transcript, with how many of its sessions the harness
 * could no longer load. */
export type AcpTranscript = Transcript & Readonly<{ missing?: number }>;

export class AcpRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<
    string,
    ReturnType<AgentSessions["snapshot"]>
  >();
  private readonly lists = new Map<string, readonly Conversation[]>();
  private generations = 0;
  private readonly retiring = new Map<string, Promise<void>>();

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (key: AgentKey) => RelayData | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Each launch's models, fed by its sessions' option state. */
    private readonly cache?: ModelCache,
    /** Where saved conversations are kept on this device. */
    private readonly storage: Storage = globalThis.localStorage,
    /** Agent storage, where what each session started with is kept. */
    private readonly agentStore: AgentStore = localStore(storage),
  ) {}

  private get spawn(): Spawn {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn) throw new Error("ACP agents run only in the desktop app");
    return spawn;
  }
  private resolveDirectory(path: string): Promise<string> {
    if (!this.host.resolveDirectory)
      throw new Error("ACP agents run only in the desktop app");
    return this.host.resolveDirectory(path);
  }
  /** The folder a plugin gave conversation `key`, if any; a one-off turn has
   * none. */
  private folder(agent: AgentKey, key: string | undefined) {
    if (!key) return undefined;
    return conversationFolder(this.agentStore, this.scopeOf(agent), agent, key);
  }
  /** `folder`, checked to still be a directory without creating it. */
  private folderAt(folder: string) {
    return existingFolder(this.host.resolveDirectory?.bind(this.host), folder);
  }
  /** The community scope conversation folders are kept under. */
  private scopeOf(agent: AgentKey) {
    const scope = this.relay(agent)?.snapshot().scope;
    if (!scope) throw new Error("Buzz is not connected");
    return scope;
  }
  private readFile(path: string, cwd: string): Promise<Uint8Array> {
    if (!this.host.readFile)
      throw new Error("ACP agents run only in the desktop app");
    return this.host.readFile(path, { cwd });
  }
  private get serve(): ServeMcp {
    const serve = this.host.serveMcp?.bind(this.host);
    if (!serve) throw new Error("ACP agents run only in the desktop app");
    return serve;
  }

  /** Brings the runtime in line with this type's agents. A saved change
   * closes idle sessions and busy ones once their turn ends; a changed launch
   * starts the next generation, while a session still on the old one keeps
   * its process until it is done. Removed agents stop theirs. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.key));
    for (const [key, entry] of this.agents)
      if (!current.has(key)) {
        this.stop(entry);
        this.agents.delete(key);
      }
    for (const agent of agents) {
      const next = config(agent.config);
      const entry = this.agents.get(agent.key);
      if (!entry) this.entry(agent.key, next).name = agent.name;
      else if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name
      ) {
        if (launchOf(entry.config) !== launchOf(next)) {
          entry.generation = { id: ++this.generations, launch: next };
          // Another harness may replay sessions: the next read finds out.
          delete entry.replays;
        }
        entry.config = next;
        entry.name = agent.name;
        entry.sessions.reconfigure();
        entry.harness.reap();
      }
    }
    this.notify();
  }

  /** Conversations each agent has a session for, for its status view. */
  sessions(agent: AgentKey) {
    let view = this.views.get(agent);
    if (!view) {
      view = this.agents.get(agent)?.sessions.snapshot() ?? [];
      this.views.set(agent, view);
    }
    return view;
  }
  /** A field, so React can call it unbound. */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    this.views.clear();
    this.lists.clear();
    for (const listener of this.listeners) listener();
  }

  /** The conversation the session controls act on at `place`: a live
   * session's, under its pinned scope, or the agent's scope now. */
  private controlKey(agent: Agent, { channelId, root }: SessionPlace) {
    const entry = this.agents.get(agent.key);
    const place = { channel: channelId, root: root ?? "", whole: !root };
    return (
      entry?.sessions.route((pinned) => keyOf(pinned.config.scope, place))
        ?.key ?? keyOf(config(agent.config).scope, place).key
    );
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = this.controlKey(agent, place);
    return this.agents.get(agent.key)?.sessions.active(key) ? "active" : "idle";
  }
  /** Stops the place's turn, or closes its session so the next message
   * opens a new one. ACP has no common way to compact a session. */
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
    reset?: (change: () => Promise<void>) => Promise<void>,
  ) {
    const sessions = this.agents.get(agent.key)?.sessions;
    const key = this.controlKey(agent, place);
    if (action === "interrupt") return sessions?.interrupt(key);
    if (action === "compact")
      throw new Error("ACP agents can't compact their sessions.");
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    const change = async () => {
      const result = await sessions?.reset(key, action);
      if (result && !result.ok) throw new Error(result.error);
    };
    await (reset ? reset(change) : change());
    this.notify();
  }

  dispose() {
    for (const entry of this.agents.values()) this.stop(entry);
    this.agents.clear();
  }
  private stop(entry: Entry) {
    entry.sessions.dispose();
    void entry.harness.stop().catch(() => undefined);
  }
  /** Stops the agent's sessions, then its processes, and resolves once they
   * have; its next turn starts afresh. Killing a process also ends a session
   * whose close it never acknowledged. A second call joins the first. */
  retire(agent: AgentKey): Promise<void> {
    const entry = this.agents.get(agent);
    if (!entry) return this.retiring.get(agent) ?? Promise.resolve();
    this.agents.delete(agent);
    this.notify();
    const retiring = entry.sessions
      .shutdown()
      .catch((error: unknown) =>
        console.warn("ACP agent's sessions didn't all close", error),
      )
      .then(() => entry.harness.stop())
      .finally(() => {
        if (this.retiring.get(agent) === retiring) this.retiring.delete(agent);
      });
    this.retiring.set(agent, retiring);
    return retiring;
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    team,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
    interruptible,
    model,
    effort,
    named,
    synced,
    wakeText,
    current,
  }: Delivery) {
    const settings = config(raw);
    // Unaddressed watches and timers come as standalone turns (`runOnce`).
    if (
      trigger.type !== "mention" &&
      trigger.type !== "attention" &&
      trigger.type !== "plugin"
    )
      return ignored?.();
    // A wake is not a message to check: a plugin's is the owner's installed
    // code, and the agent's own handoff comes from a turn already acting
    // for the owner.
    const wake = trigger.type !== "mention" ? trigger : undefined;
    // Interrupted by a reload or quit: it carries on, past its request.
    const resumed = trigger.type === "mention" && !!trigger.resumed;
    // The harness runs commands as you; mentions need owner or delegated
    // authority.
    if (trigger.type === "mention") {
      // A workflow's mention waits out a reconnect; the check below decides.
      const ready = workflowMarked(trigger.event, agent.owner);
      const reads = ready
        ? await readyOwnerReads(
            this.relay(agent.key),
            agent,
            signal,
            channelId ?? trigger.event.tags.find((tag) => tag[0] === "h")?.[1],
          )
        : ownerReads(this.relay(agent.key), agent.pubkey);
      if (ready) {
        signal.throwIfAborted();
        if (current && !current()) return ignored?.();
      }
      const authority = await mentionAuthority(
        trigger.event,
        agent.owner,
        workflowOf(reads, agent.pubkey),
      );
      if (authority !== "owner") return ignored?.(authority);
      signal.throwIfAborted();
    }
    const entry = this.entry(agent.key, settings);
    entry.handle = agent;
    entry.team = team ?? "";
    entry.syncedModel = !!synced?.model;
    const event =
      trigger.type !== "mention" ? wakeAnchor(trigger) : trigger.event;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    // Where it answers needs the channel's kind, which a reconnecting
    // community, or one still listing its channels, does not know yet: it
    // waits, as a workflow's mention does, rather than answer a Solo chat or
    // a DM as a thread. A community that knows it answers at once.
    await readyOwnerReads(
      this.relay(agent.key),
      agent,
      signal,
      channel,
      "This turn",
    );
    signal.throwIfAborted();
    if (current && !current()) return ignored?.();
    // Frozen for the turn: its key, prompt, tools and posts all follow it.
    const solo = await soloChat(
      () => this.relay(agent.key),
      agent.owner,
      channel,
      signal,
    );
    const topLevel = solo || wake?.topLevel === true;
    if (wake && !wakeLands(wake, topLevel)) return ignored?.();
    const place = this.place(agent.key, event, channel, topLevel);
    // A live or opening session keeps the conversation it was opened for,
    // under its own pinned scope; only otherwise does today's scope decide.
    const key =
      entry.sessions.route((pinned) => keyOf(pinned.config.scope, place))
        ?.key ?? keyOf(entry.config.scope, place).key;
    // Only a Solo chat has no threads; a channel-level wake may reply in one.
    const context: Context = topLevel
      ? { channel, ...(solo ? { topLevel } : {}) }
      : place.whole
        ? { channel }
        : key === channel
          ? // A thread of a channel-scoped session: one conversation.
            { channel, root: place.root, wholeChannel: true }
          : { channel, root: place.root };
    // Settled before the session is pinned, from saved storage rather than
    // this program's copy, so its cwd, prompt, tools, Canvas and saved
    // context all have the one folder. It also records that a conversation
    // without one starts in the workspace, so a later folder is refused.
    entry.folders.set(
      key,
      await startingFolder(
        this.agentStore,
        this.scopeOf(agent.key),
        agent.key,
        key,
      ),
    );
    signal.throwIfAborted();
    // A new session's first turn is where a harness asks to sign in.
    const first = !entry.sessions.seen(key);
    // Owed from now until a committed prompt has carried it: a turn that
    // fails, is refused or is stopped leaves it for the next prompt.
    const owed = localOwed(this.storage, agent.key);
    // A wake is no message on the relay to read back.
    if (!wake)
      owed.set(key, [
        ...owed.get(key).filter((id) => id !== event.id),
        event.id,
      ]);
    const { generation } = entry;
    // Plugins' notes and instructions are keyed by the session's own
    // conversation: a channel-scoped one's is the whole channel.
    const noteRoot = key === channel ? undefined : context.root;
    // Plugins' notes, taken once the prompt is built; back if never sent.
    let notes: readonly string[] = [];
    let sent = false;
    // Once its delivery has settled, a late build takes no notes: they could
    // be neither sent nor given back.
    let settled = false;
    const done = entry.sessions.deliver(key, "", event.created_at, {
      // Built when it is sent, from what the session has definitely seen.
      build: async (from, pinned) => {
        // The serving session's tools act here from now on; a replacement
        // session on the same key never moves them.
        entry.places.set(pinned, { context, handle: agent });
        // Only a commit adds to `from`, so what it holds was delivered.
        const unpaid = owed.get(key).filter((id) => !from.ids.includes(id));
        owed.set(key, unpaid);
        // Only a request a prompt delivered as its own is answered; one shown
        // as another prompt's context still is.
        if (from.requests?.includes(event.id)) return undefined;
        const turn = await this.turn(
          agent.key,
          event,
          channel,
          topLevel,
          key,
          from,
          unpaid,
          solo,
          resumed,
          pinned,
        );
        const wakePrompt = wake
          ? ((await wakeText?.()) ?? wake.text)
          : undefined;
        if (!settled)
          notes = [...notes, ...(agent.notes?.(channel, noteRoot) ?? [])];
        const prompt = turnPrompt({
          ...turn,
          agent: agent.pubkey,
          channelLevel: topLevel && !solo,
          ...(wake ? { wake: { ...wake, text: wakePrompt ?? wake.text } } : {}),
        });
        return {
          text: this.review(
            entry,
            channel,
            noteRoot,
            notes,
            resumed ? `${prompt}\n\n${RESUMED_PROMPT}` : prompt,
          ),
          // Only what the prompt shows counts as seen.
          through: cover(from, turn.context.slice(-CONTEXT_LIMIT), event),
        };
      },
      signal,
      // A wake its owner disabled or rearmed meanwhile, or a stopped
      // delivery, is not sent.
      current: () => !signal.aborted && (!current || current()),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      // A pick runs on its own level; a synced one is checked.
      ...(synced?.effort && !model && !effort ? { kept: synced.effort } : {}),
      ...(topLevel && named ? { named } : {}),
      activityScope: topLevel ? channel : place.root,
      ...(step ? { step } : {}),
      ...(acknowledged ? { acknowledged } : {}),
      ...(superseded ? { superseded } : {}),
      accepted: () => {
        sent = true;
      },
    });
    // The whole error reaches the turn's local activity through `done`.
    workingUntil(done);
    interruptible?.(() => entry.sessions.interrupt(key));
    this.notify();
    void done
      .then((result) => {
        settled = true;
        if (!sent && notes.length)
          agent.restoreNotes?.(channel, notes, noteRoot);
        signedIn(entry, generation, result);
        // Of the messages one turn answered, only one has its error. A
        // delivery cancelled by its own signal says nothing; it stays owed.
        if (result.error !== undefined && !signal.aborted)
          return this.report(
            agent,
            channel,
            event,
            topLevel,
            result.hint ??
              (first && result.code === AUTH_REQUIRED
                ? preset(entry.config.preset)?.login
                : undefined),
          );
      })
      .catch((error) => console.warn("ACP agent turn failed", error))
      .finally(() => this.notify());
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * session that joins no conversation. Its failure goes only to the app log,
   * whole (`wake` in `agent-harness/wakes.ts`). */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent.key, config(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    entry.syncedModel = !!delivery.synced?.model;
    const { generation } = entry;
    const done = entry.sessions.runOnce(
      key,
      async (pinned) => {
        // Its tools act with its own handle, and default to no place.
        if (pinned) entry.places.set(pinned, { context: {}, handle: agent });
        const text = await prompt();
        return text === undefined
          ? undefined
          : standalonePrompt(agent.pubkey, text);
      },
      {
        signal,
        current: delivery.current,
        ...(delivery.synced?.effort ? { kept: delivery.synced.effort } : {}),
      },
    );
    this.notify();
    return done
      .then((result) => {
        signedIn(entry, generation, result);
        return result;
      })
      .finally(() => this.notify());
  }

  /** `text` with plugins' `notes`, then the Buzz tools' end-of-turn note
   * for conversation `channel`/`root`, when they have one. ACP has no
   * community session, so no instructions are cleared when absent. */
  private review(
    entry: Entry,
    channel: string,
    root: string | undefined,
    notes: readonly string[],
    text: string,
  ) {
    return [text, ...notes, turnNote(entry.handle, channel, root)]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    topLevel: boolean,
    /** What to do about it, in words of our own: none of the harness's.
     * Signing in is asked on a new session's first turn. */
    hint?: string,
  ) {
    return this.post(
      agent,
      channel,
      event,
      hint ? `${FAILED} ${hint}` : FAILED,
      topLevel,
      [["p", agent.owner]],
    );
  }

  /** Replies as the agent in the event's thread, or at a Me chat's top
   * level. */
  private post(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    content: string,
    topLevel: boolean,
    tags: string[][] = [],
  ) {
    return agent
      .publish({
        kind: 9,
        content,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...tags,
        ],
      })
      .catch((failure) => console.warn("ACP agent could not post", failure));
  }

  /** Where a message sits, from the channel list as it is now. A Me chat is
   * one conversation, as a DM is. */
  private place(
    self: string,
    event: EventData,
    channel: string,
    topLevel: boolean,
  ): Place {
    const snapshot = this.relay(self)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channel) ??
      session?.channels.get?.(channel);
    return {
      channel,
      root: threadReference(event)?.rootId ?? event.id,
      whole: topLevel || summary?.channelType === "dm",
    };
  }

  /** What the event's turn in conversation `key` needs for its prompt: the
   * messages after `from`, which a fresh session (`FRESH`) is shown all of. */
  private async turn(
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
    key: string,
    from: Mark,
    owed: readonly string[] = [],
    solo = topLevel,
    resumed = false,
    pinned?: Snap,
  ) {
    const snapshot = this.relay(self)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    const fresh = from.at === FRESH.at;
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const owner = this.agents.get(self)?.handle?.owner;
    const reading = solo
      ? readProject(
          session && owner
            ? () =>
                ownerCanvas(
                  session.canvas,
                  owner,
                  channelId,
                  session.channelWrites.startingCanvas(channelId),
                )
            : undefined,
          // Its serving session's choices: the ones its prompt has.
          worksElsewhere(pinned?.folder, pinned?.sections),
        )
      : Promise.resolve(undefined);
    let earlier: readonly EventData[] = [];
    // A resumed turn reads its request's thread, replies past it included.
    const inThread = (thread || (resumed && !dm)) && !topLevel;
    const window = inThread || dm || topLevel;
    const inRoot = (item: EventData) =>
      item.id === rootId ||
      item.tags.some(([name, value]) => name === "e" && value === rootId);
    if (session && (window || owed.length))
      try {
        const events = await session.read(
          [
            ...(!window
              ? []
              : inThread
                ? [
                    { ids: [rootId], limit: 1 },
                    {
                      kinds: CHAT,
                      "#h": [channelId],
                      "#e": [rootId],
                      limit: 200,
                    },
                  ]
                : [
                    {
                      kinds: CHAT,
                      "#h": [channelId],
                      limit: CONTEXT_LIMIT + 1,
                    },
                  ]),
            // Owed messages by id, however far back the window has moved.
            ...(owed.length
              ? [{ ids: [...owed], "#h": [channelId], limit: owed.length }]
              : []),
          ],
          { signal: AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS) },
        );
        const seen = new Set<string>();
        earlier = events
          .filter(
            (item) =>
              !seen.has(item.id) &&
              seen.add(item.id) &&
              CHAT.includes(item.kind) &&
              item.tags.some(
                ([name, value]) => name === "h" && value === channelId,
              ) &&
              // Owed messages follow the conversation's scope, not the trigger's.
              (owed.includes(item.id)
                ? scope !== "thread" || inRoot(item)
                : !inThread || inRoot(item)) &&
              item.id !== event.id &&
              (resumed || item.created_at <= event.created_at),
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("ACP agent could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too. A
    // resumed turn's thread may sit below the mark another thread moved, so
    // it is shown all of it but what the session saw by id.
    const candidates = earlier.filter(
      (item) =>
        (resumed || item.created_at >= from.at || owed.includes(item.id)) &&
        !from.ids.includes(item.id) &&
        (fresh || resumed || item.pubkey !== pubkeyOf(self)),
    );
    // Owed messages come first; the newest others fill what is left.
    const others = candidates.filter((item) => !owed.includes(item.id));
    const room = CONTEXT_LIMIT - (candidates.length - others.length);
    const recent = new Set(room > 0 ? others.slice(-room) : []);
    const unseen = candidates.filter(
      (item) => owed.includes(item.id) || recent.has(item),
    );
    const reads = ownerReads(this.relay(self), pubkeyOf(self));
    const signingAuthority = reads?.workflowAuthority();
    const [names, project] = await Promise.all([
      readAuthorNames(
        reads,
        [event, ...unseen.slice(-CONTEXT_LIMIT)],
        signingAuthority,
      ),
      reading.then((read) => read?.section),
    ]);
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
      names,
      ...(signingAuthority ? { signingAuthority } : {}),
      ...(project ? { project } : {}),
    };
  }

  /** The agent's entry, made from `initial` if it has none. */
  private entry(agent: AgentKey, initial: Config): Entry {
    const pubkey = pubkeyOf(agent);
    const existing = this.agents.get(agent);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      generation: { id: ++this.generations, launch: initial },
      store: localSessions(this.storage, agent),
      sessions: undefined as unknown as AgentSessions<Snap>,
      harness: new HarnessProcess(
        (id, options) => this.spawn(id, options),
        (handler) => this.serve(handler),
        () => entry.generation,
      ),
      places: new WeakMap(),
      folders: new Map(),
    };
    // Every session of the agent shares them, so they read the handle as it is
    // when called, and the place and workspace of the serving session.
    const tools: ToolServer = async (
      _conversation,
      message,
      signal,
      pinned,
    ) => {
      const place = pinned ? entry.places.get(pinned as Snap) : undefined;
      // The serving turn's handle.
      const handle = place?.handle ?? entry.handle;
      // Where the serving session works: its conversation's folder, if any.
      const workspace =
        (pinned as Snap | undefined)?.folder ??
        (pinned as Snap | undefined)?.config.workspace ??
        entry.config.workspace;
      // Built again after a wait through a reload, so a call carries the
      // community's details as they are then.
      const client = () =>
        handle && {
          ...appClient(handle, {
            // The serving work's lifetime: nothing acts after it ends.
            ...(signal && { signal, callSignal: signal }),
            relayAuthor: this.relay(agent)?.snapshot().session.relayAuthor,
            signingAuthority:
              this.relay(agent)?.snapshot().session.workflowAuthority,
            read: (path) => this.readFile(path, workspace),
            memories: (slug) => this.memories(agent, slug),
            remembered: () => this.forgetMemories(agent),
          }),
        };
      const context = place?.context ?? {};
      return respond(client, context, message, this.added());
    };
    const snap = (): Snap => ({
      config: entry.config,
      team: entry.team,
      ...(entry.name ? { name: entry.name } : {}),
      added: addedKey(this.added()),
      ...(entry.syncedModel ? { syncedModel: true } : {}),
    });
    const launchFor = async (
      { config: c, team, name, sections, folder: assigned }: Snap,
      conversation?: string,
    ) => {
      // A conversation given its own folder starts there, and the folder must
      // still exist; the agent's workspace stays its home. The confirmed
      // launch is the process's, which runs as it was confirmed.
      const cwd = assigned ? await this.folderAt(assigned) : c.workspace;
      const memory = await this.core(agent);
      return {
        workspace: cwd,
        systemPrompt: systemPrompt({
          scope: c.scope,
          cwd,
          ...(assigned
            ? { workspace: await this.resolveDirectory(c.workspace) }
            : {}),
          ...(name ? { agent: { name, pubkey } } : {}),
          instructions: c.instructions,
          team,
          ...(memory === undefined ? {} : { memory }),
          sections,
          place: placeOf(conversation),
        }),
      };
    };
    const options: SessionsOptions<Snap> = {
      label: LABEL,
      resolveDirectory: (path) => this.resolveDirectory(path),
      tools,
      process: entry.harness,
      store: entry.store,
      onChange: () => this.notify(),
      // Only a new session's prompt is its own: a resumed one started with
      // whatever it was sent then.
      started: (session, text, title, conversation, _wake, resumed) => {
        if (conversation !== undefined)
          entry.store.remember(conversation, session);
        if (resumed) return;
        void this.prompts(agent)
          .save(session, [{ label: "", text }], {
            at: Date.now(),
            title: title ?? "",
            conversation: conversation ?? null,
          })
          // A standalone start is listed once it is kept.
          .then(() => this.notify());
      },
      resume: true,
      configOptions: true,
      // Each session runs on the settings it opened with. Only a saved change
      // (a new `localKey`) closes it; a new launch is a new generation.
      pin: (conversation): Pinned<Snap> => {
        // Its conversation's choices as they are now, so a change makes the
        // next turn a new session's, a busy one's included.
        const sections = sectionsOf(entry.handle, conversation);
        // As settled before delivery; synchronous, and never throws.
        const folder = conversation
          ? entry.folders.get(conversation)
          : undefined;
        const snapshot: Snap = {
          ...snap(),
          ...(sections ? { sections } : {}),
          ...(folder ? { folder } : {}),
        };
        return {
          snapshot,
          context: contextOf(snapshot),
          localKey: JSON.stringify([
            snapshot.config,
            snapshot.team,
            snapshot.name,
            snapshot.added,
            // A model turning synced is refused from then on, not only in
            // sessions opened after.
            snapshot.syncedModel ?? false,
            replacedSections(snapshot.sections),
            snapshot.folder ?? "",
          ]),
          generation: entry.generation,
        };
      },
      launchFor,
      pickFor: (pinned, override) =>
        pickFor(pinned.config, override, pinned.syncedModel),
      // A synced model is the agent's on every device: never run another.
      refuse: (state, { model }, source) =>
        source.model === "synced" && model && !offers(state.model, model)
          ? unsupportedSynced("model", model, `this ${LABEL}`)
          : undefined,
      onState: (state, pinned) => {
        const key = launchKey(pinned.config);
        if (key) this.cache?.record(key, state);
      },
      // Unused with `pin`, which replaces them for every session.
      choice: () => HARNESS_CHOICE,
      fingerprint: () => contextOf(snap()),
      launch: () => launchFor(snap()),
    };
    entry.sessions = new AgentSessions<Snap>(options);
    this.agents.set(agent, entry);
    return entry;
  }

  /** Whether the agent's last turn asked its owner to sign in. */
  signIn(agent: AgentKey) {
    return this.agents.get(agent)?.signIn;
  }

  /** Restarts the agent's harness after its owner signed in; the error, if
   * it still can't start. */
  async recheck(agent: AgentKey): Promise<string | undefined> {
    const entry = this.agents.get(agent);
    if (!entry) return "This agent isn't running.";
    const result = await entry.sessions.reconnect();
    if (result.ok) entry.signIn = undefined;
    this.notify();
    return result.ok ? undefined : (result.error ?? "The harness didn't start");
  }

  /** The agent's conversations on this device, most recent first, with the
   * live ones' status. */
  conversations(agent: AgentKey): readonly Conversation[] {
    let list = this.lists.get(agent);
    if (list) return list;
    const entry = this.agents.get(agent);
    const live = new Map(this.sessions(agent).map((view) => [view.key, view]));
    const saved = new Map(
      (entry?.store ?? localSessions(this.storage, agent)).list(),
    );
    const keys = new Set([...saved.keys(), ...live.keys()]);
    list = [...keys]
      .flatMap((key): Conversation[] => {
        const view = live.get(key);
        const at = view?.at ?? saved.get(key)?.at;
        // A one-off turn joins no conversation.
        if (at === undefined) return [];
        const [channelId = key, root] = key.split("/");
        return [
          {
            key,
            channelId,
            ...(root ? { root } : {}),
            at,
            ...(view ? { status: view.busy ? "Working" : "Idle" } : {}),
            ...(view?.sessionId ? { session: view.sessionId } : {}),
            replayable:
              !!view?.sessionId || replayable(saved.get(key)).length > 0,
          },
        ];
      })
      // A standalone turn's session, such as a watch's or a timer's, joins
      // no conversation: listed on its own.
      .concat(
        this.prompts(agent)
          .sessions()
          .flatMap(({ id, at, title, conversation }): Conversation[] =>
            conversation === null && at !== undefined
              ? [
                  {
                    key: `${STANDALONE}${id}`,
                    channelId: "",
                    at,
                    title: title || "Standalone turn",
                    replayable: true,
                  },
                ]
              : [],
          ),
      )
      .sort((a, b) => b.at - a.at);
    this.lists.set(agent, list);
    return list;
  }

  /** What each of the agent's new sessions was started with. */
  private prompts(agent: AgentKey) {
    return sessionPrompts(this.agentStore, "acp", agent);
  }

  replays(agent: AgentKey) {
    return this.agents.get(agent)?.replays;
  }

  /** A saved conversation's transcript, replayed by a short-lived harness
   * process on the current launch; undefined if the harness can't. */
  async transcript(
    agent: AgentKey,
    key: string,
    signal: AbortSignal,
  ): Promise<AcpTranscript | undefined> {
    const entry = this.agents.get(agent);
    // The working session too, before any turn of it succeeded: shown only,
    // never saved as the one to resume.
    const live = entry?.sessions.serving(key)?.sessionId;
    const standalone = key.startsWith(STANDALONE)
      ? key.slice(STANDALONE.length)
      : undefined;
    const ids = standalone
      ? [standalone]
      : [
          ...new Set([
            ...replayable(entry?.store.load(key)),
            ...(live ? [live] : []),
          ]),
        ];
    if (!entry || !ids.length) return undefined;
    const launch = entry.config;
    const { generation } = entry;
    // Where its sessions ran: its folder, which must still exist, else the
    // workspace.
    const folder = standalone ? undefined : this.folder(agent, key);
    const cwd = folder
      ? await this.folderAt(folder)
      : await this.resolveDirectory(launch.workspace);
    const [channelId, root] = standalone ? [] : key.split("/");
    // Each of its sessions in turn, oldest first. One the harness can no
    // longer load is left out, and the rest still shown.
    let transcript: Transcript | undefined;
    let missing = 0;
    let failure: unknown;
    for (const sessionId of ids) {
      let read: Transcript | undefined;
      try {
        read = await readTranscript({
          start: (o) => start(this.spawn, launch, o),
          cwd,
          sessionId,
          signal,
          threadOf: (prefix) => root ?? threadIn(prefix),
          name: (pubkey) =>
            ownerReads(this.relay(agent), pubkeyOf(agent))?.name(pubkey),
        });
      } catch (error) {
        signal.throwIfAborted();
        missing++;
        failure = error;
        continue;
      }
      if (!read) break;
      transcript = { turns: [...(transcript?.turns ?? []), ...read.turns] };
    }
    // None it could load: that is the read's failure.
    if (!transcript && missing) throw failure;
    // A read for an older launch says nothing about the current one.
    if (entry.generation === generation) {
      entry.replays = transcript !== undefined;
      this.notify();
    }
    return (
      transcript && {
        ...(missing ? { missing } : {}),
        turns: this.prompts(agent)
          .shown(transcript.turns)
          .map((turn) => ({
            ...turn,
            channelId: channelId ?? null,
          })),
      }
    );
  }

  /** The agent's memory, or only entry `slug`, read back through the owner's
   * session: it is encrypted to the owner, so no agent key is needed. */
  private memories(agent: AgentKey, slug?: string): Promise<Memories> {
    const pubkey = pubkeyOf(agent);
    const reads = ownerReads(this.relay(agent), pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  /** After a memory write, a read that may have started before it is not
   * shared with later callers. */
  private forgetMemories(agent: AgentKey) {
    const pubkey = pubkeyOf(agent);
    const reads = ownerReads(this.relay(agent), pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}

/** The sessions of a saved conversation a transcript replays, oldest first:
 * its history and its resume pointer. */
/** Starts a standalone session's History key. */
const STANDALONE = "standalone:";

const replayable = (saved: SavedConversation | undefined): string[] => {
  const history = savedConversation(saved)?.sessions ?? [];
  return [...new Set([...history].reverse().concat(saved?.id ?? []))];
};

/** Newest event ids a mark remembers; an id that falls out can only repeat. */
const COVERED_IDS = 256;

/** `from` plus the events a prompt carried as context and its `request`:
 * identities, not just seconds, so a distinct message in a covered second, or
 * a late older one, still goes. */
export function cover(
  from: Mark,
  context: readonly EventData[],
  request: EventData,
): Mark {
  const carried = [...context, request];
  const added = new Set(carried.map((item) => item.id));
  return {
    at: Math.max(from.at, ...carried.map((item) => item.created_at)),
    ids: [...from.ids.filter((id) => !added.has(id)), ...added].slice(
      -COVERED_IDS,
    ),
    requests: [
      ...(from.requests ?? []).filter((id) => id !== request.id),
      request.id,
    ].slice(-COVERED_IDS),
  };
}

/** A turn's pick: the message's own fields win, and the rest come from the
 * session's pinned settings: a synced model's, else this device's. A synced
 * effort is checked as `kept`. */
export function pickFor(
  pinned: Config,
  override: Pick | undefined,
  syncedModel = false,
): Readonly<{ pick: Pick; source: Source }> {
  const field = (name: "model" | "effort") => {
    const own = override?.[name];
    if (own !== undefined) return { value: own, source: "message" as const };
    const value = pinned[name];
    const source: "synced" | "device" =
      name === "model" && syncedModel ? "synced" : "device";
    return value ? { value, source } : undefined;
  };
  const model = field("model");
  const effort = field("effort");
  return {
    pick: {
      ...(model?.value ? { model: model.value } : {}),
      ...(effort?.value ? { effort: effort.value } : {}),
    },
    source: {
      ...(model ? { model: model.source } : {}),
      ...(effort ? { effort: effort.source } : {}),
    },
  };
}

/** The thread a channel-scoped turn replied in, from the reply instruction
 * its prompt carries; undefined when it names none. */
export const threadIn = (prompt: string) =>
  /pass `reply: "([0-9a-f]{64})"`/.exec(prompt)?.[1];
