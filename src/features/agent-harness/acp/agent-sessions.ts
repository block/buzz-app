// One agent's sessions in an ACP harness: one ACP session per conversation (a
// thread, a whole DM, or a channel), in the process its source gives. A quiet
// conversation's session is closed; its next message opens a new one, shown
// the conversation again. A one-off turn (a watch or timer wake) gets a
// session of its own, closed when it ends. Every session holds one of the
// host's MCP servers, in one pool every ACP plugin's agents share, and the
// least recently used idle session closes to make room, whichever plugin's.
// Sessions live as long as the app does; only when each conversation last used
// one is saved, so its sessions stay listed after they close.
import { absoluteWorkspace } from "../../../bundled/codex/config";
import type { SessionAction } from "../../agents/service";
import { offers } from "./options";
import type { AcpProcess } from "./process";
import type { AcpSession, Parity, Turn, TurnRoute } from "./session";
import {
  AUTH_REQUIRED,
  authMethodsOf,
  codeOf,
  errorMessage,
  HintedError,
} from "./steps";
import {
  type ActivityReceipt,
  type BuildPrompt,
  type Choice,
  FRESH,
  type Generation,
  type Mark,
  type OptionState,
  type Overridden,
  type Pick,
  type Pinned,
  type ResolveDirectory,
  type RouteMatch,
  type ServeMcp,
  type Settled,
  type Source,
  type ToolServer,
} from "./types";

/** A conversation's session closes after this long without a message. */
export const IDLE_MS = 15 * 60_000;
/** The most MCP servers the pool's sessions hold at once, below the host's 64
 * for every plugin, so plugins not on this client keep room. */
export const POOL_LIMIT = 48;

/** The most session ids a conversation keeps: each reopening starts one. */
export const SAVED_SESSIONS = 10;

/** What is saved for one conversation: when its session last took in a
 * message or ended a turn, the ids of its sessions, newest first, and, once a
 * prompt in it succeeded, how to resume it. */
export type SavedConversation = Readonly<{
  at: number;
  sessions?: readonly string[];
  /** The harness's session id. */
  id?: string;
  /** What the harness definitely received; a number from older records. */
  covered?: Mark | number;
  /** The pinned `context` it was opened with. */
  context?: string;
  overridden?: Overridden;
  /** What held work saved with its session (`keep`), as stored: read only
   * through `association`, so damage is never taken for none. */
  binding?: unknown;
  /** New session was asked for, until a session replacing the newest one
   * is saved. */
  next?: "new";
}>;
/** The longest session id kept; longer ones are taken as damaged. */
const SESSION_ID_LIMIT = 256;

/** Whether a saved time is one a Date can hold: finite alone lets 1e20
 * through, which throws when shown. */
export const validTime = (at: unknown): at is number =>
  typeof at === "number" && !Number.isNaN(new Date(at).getTime());

/** A saved conversation as read back from storage, or undefined when it is
 * damaged: a time a Date can hold, and its session ids de-duplicated, capped and kept
 * only when each is a short string. One saved before ids were has none. */
export function savedConversation(
  value: unknown,
): SavedConversation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { at, sessions, next } = value as {
    at?: unknown;
    sessions?: unknown;
    next?: unknown;
  };
  if (!validTime(at)) return undefined;
  const kept = {
    at,
    // Kept as stored, however damaged, for `association` to refuse.
    ...("binding" in value ? { binding: value.binding } : {}),
    ...(next === "new" ? { next: "new" as const } : {}),
  } as const;
  if (sessions === undefined) return kept;
  if (!Array.isArray(sessions)) return undefined;
  const ids = sessions.filter(
    (id): id is string =>
      typeof id === "string" && id.length > 0 && id.length <= SESSION_ID_LIMIT,
  );
  return { ...kept, sessions: [...new Set(ids)].slice(0, SAVED_SESSIONS) };
}

/** The value held work saved with the conversation's newest session:
 * none when nothing was saved or what was is another session's, and
 * "malformed" when what is stored can't be read. */
export function association(
  saved: SavedConversation | undefined,
): Readonly<{ value: unknown }> | "malformed" | undefined {
  if (!saved || !("binding" in saved)) return undefined;
  const { binding } = saved;
  if (!binding || typeof binding !== "object" || Array.isArray(binding))
    return "malformed";
  const keys = Object.keys(binding);
  if (keys.length !== 2 || !("session" in binding) || !("value" in binding))
    return "malformed";
  const { session, value } = binding;
  if (
    typeof session !== "string" ||
    !session ||
    session.length > SESSION_ID_LIMIT
  )
    return "malformed";
  return session === saved.sessions?.[0] ? { value } : undefined;
}
/** A saved `covered`; an older record's bare second covers no ids. */
function markOf(covered: Mark | number | undefined): Mark {
  if (typeof covered === "number") return { at: covered, ids: [] };
  return covered ?? FRESH;
}

export type SessionStore = {
  get(key: string): SavedConversation | undefined;
  set(key: string, saved: SavedConversation): void;
  load?(key: string): SavedConversation | undefined;
  /** Updates `at` only, keeping the rest. Used instead of `set` when given. */
  touch?(key: string, at: number): void;
  /** A prompt succeeded: the first writes every field, later ones `covered`. */
  advance?(
    key: string,
    commit: Readonly<{
      id: string;
      covered: Mark;
      context: string;
      overridden: Overridden;
    }>,
  ): void;
  drop?(key: string): void;
};

/** Where a session's process comes from. */
export type ProcessSource = Readonly<{
  /** The process sessions open in now. One that would replace a process
   * `drained` says no session needs stops it first. */
  get(drained?: (process: AcpProcess) => boolean): Promise<AcpProcess>;
  /** A process started from exactly that generation's launch. */
  at?(generation: Generation): Promise<AcpProcess>;
  /** Keeps a generation's process alive until released; release is
   * idempotent. A process stops only once no hold on it remains. */
  hold?(generation: Generation): Readonly<{ release(): void }>;
  /** Stops the current process and starts it again from the confirmed
   * launch, read afresh: after the owner signs in. */
  restart?(o: RestartOptions): Promise<Settled>;
}>;
export type RestartOptions = Readonly<{
  signal?: AbortSignal;
  /** 30s by default, for every try together. */
  deadlineMs?: number;
  /** 3 by default. */
  tries?: number;
  /** 1s by default, doubling. */
  backoffMs?: number;
}>;

/** A session's hold on one MCP server in the pool. */
export type Slot = {
  /** Whether it can be closed to make room: no turn runs in it. */
  idle(): boolean;
  /** Closes the session, and resolves once its server has stopped. */
  evict(): Promise<unknown>;
};

/** The MCP servers agents' sessions hold, least recently used first. */
export class ServerPool {
  private readonly slots = new Set<Slot>();
  constructor(private readonly limit = POOL_LIMIT) {}

  get size() {
    return this.slots.size;
  }
  /** Holds a server for `slot`, first closing idle sessions to keep below the
   * limit. Busy ones are never closed, so it can go over. Resolves once the
   * closed sessions' servers have stopped: the host counts them until then. */
  take(slot: Slot) {
    const evicted: Promise<unknown>[] = [];
    while (this.slots.size >= this.limit) {
      const stopped = this.evict();
      if (!stopped) break;
      evicted.push(stopped);
    }
    this.slots.add(slot);
    return Promise.all(evicted);
  }
  /** Marks `slot` as used now. */
  touch(slot: Slot) {
    if (this.slots.delete(slot)) this.slots.add(slot);
  }
  release(slot: Slot) {
    this.slots.delete(slot);
  }
  /** Closes the least recently used idle session, and resolves once its
   * server has stopped; undefined when every session is busy. */
  evict() {
    for (const slot of this.slots)
      if (slot.idle()) {
        this.slots.delete(slot);
        return slot.evict();
      }
    return undefined;
  }
}

/** The pool every ACP plugin's sessions share. */
export const SHARED_POOL = new ServerPool();

/** What a session is opened with. */
export type Launch = Readonly<{
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  systemPrompt: string;
}>;

export type SessionsOptions<S = unknown> = Readonly<{
  /** Names the harness in errors. */
  label: string;
  /** The host's, for the workspace's absolute path. */
  resolveDirectory: ResolveDirectory;
  /** Answers the agent's Buzz tools. */
  tools: ToolServer;
  /** The process its sessions open in, started when needed. */
  process: ProcessSource;
  /** The servers its sessions hold: the shared pool unless given. */
  pool?: ServerPool;
  /** The agent's current settings, for a new session or a session's next
   * turn in `conversation`: none for a one-off turn. */
  launch(conversation?: string): Promise<Launch>;
  /** The agent's provider, model and thinking level now, which each new
   * turn runs on. */
  choice(): Choice;
  /** Changes when a setting only a new session runs on has changed. A
   * changed system prompt alone is given to the session as its next turn starts, where
   * the harness can take it. */
  fingerprint(): string;
  /** Where each conversation's last use is saved. */
  store?: SessionStore;
  /** Told of each session opened, with the prompt and title it was opened
   * with, and the conversation it opened for: none for a one-off turn. A
   * one-off turn's also gets its label, as `runOnce` was given it.
   * `resumed`: a saved session reopened, which today's prompt never started. */
  started?(
    sessionId: string,
    systemPrompt: string,
    title?: string,
    conversation?: string,
    wake?: string,
    resumed?: boolean,
  ): void;
  /** The tags a session opens with, for the conversation it opens for:
   * none for a one-off turn. */
  tags?(conversation?: string): Readonly<Record<string, string>>;
  /** Called when a conversation's session opens, is sent a message, or
   * closes. */
  onChange?(): void;
  /** Opt-in: an opening conversation resumes its saved record, through
   * `store.load`, when its `context` matches the pinned one. */
  resume?: true;
  /** Opt-in: picks go through ACP `session/set_config_option`, in place of
   * `hooks.select`, and a field Buzz set reopens fresh for the default. */
  configOptions?: true;
  /** Opt-in: each session pins its settings once, which then replace
   * `fingerprint`, `launch` and `choice` for it. Both are given the
   * conversation the session is for: none for a one-off turn. */
  pin?(conversation?: string): Pinned<S>;
  launchFor?(pinned: S, conversation?: string): Promise<Launch>;
  /** A turn's pick from the pinned snapshot and the message's own. */
  pickFor?(
    pinned: S,
    override: Pick | undefined,
  ): Readonly<{ pick: Pick; source: Source }>;
  /** Why a turn may not run on `pick`, checked before its prompt. */
  refuse?(state: OptionState, pick: Pick, source: Source): string | undefined;
  /** Every live option-state replacement for a launch, never during replay. */
  onState?(state: OptionState, pinned: S): void;
}>;

/** A conversation `exclusive` holds. */
type Held = { controller: AbortController; done: Promise<void> };

/** What `exclusive` gives the work it runs. */
export type Exclusive = Readonly<{
  /** The conversation's newest saved session, if any, and none once New
   * session was asked for. */
  saved: string | undefined;
  /** New session was asked for since the newest session was saved. */
  reset: boolean;
  /** What the work saved with `saved`, read by `association`. */
  binding: ReturnType<typeof association>;
  /** Saves `id` as its newest session with `binding`, while the work holds
   * the conversation: whether the store then reads it back so. */
  keep(id: string, binding: unknown): boolean;
  /** Notes what the session it runs in has been shown, as a message's
   * delivery does, while the work holds the conversation. */
  shown(seen: number): void;
  /** Aborts on `interrupt` or `dispose`. */
  signal: AbortSignal;
  /** A session the work opened outlives it until `done`, its process's
   * `exited`: until then the conversation cannot be held again and its
   * messages wait. Each call adds to the ones before, which are all waited
   * for. Should any `done` reject, its owner is unknown, and both fail from
   * then on. Throws once the work has settled. */
  outlives(done: Promise<unknown>): void;
}>;

/** A session left running by held work, until its process has exited. */
type Outliving = {
  exits: readonly Promise<unknown>[];
  settled: Promise<void>;
  failed: boolean;
};

/** A conversation's current owner, with `pin`: the live or opening session
 * that alone may write its record. A retired one is no longer in `claims`. */
type Claim<S> = Readonly<{ epoch: number; pinned: Pinned<S> }> & {
  /** The digest of the system prompt its session runs on. */
  prompt?: string;
};
type Lease = Readonly<{ release(): void }>;

type Live = {
  session: AcpSession;
  process: AcpProcess;
  fingerprint: string;
  /** The system prompt it runs on. */
  systemPrompt: string;
  slot: Slot;
  claim?: Claim<unknown>;
  /** Its hold on its generation's process, released when it closes. */
  lease?: Lease;
  /** When it last took in a message or ended a turn. */
  at: number;
  timer?: ReturnType<typeof setTimeout>;
};
type Opened = Promise<{ live: Live; settled?: Promise<Settled> }>;

export class AgentSessions<S = unknown> {
  /** The latest process its unpinned sessions opened in. */
  private process: AcpProcess | undefined;
  /** Earlier processes a newer one replaced, each stopped once no session is
   * in it. */
  private readonly replaced = new Set<AcpProcess>();
  /** Processes whose exit drops their sessions. */
  private readonly known = new WeakSet<AcpProcess>();
  /** How many processes have been asked for, and which ask `process`
   * answered: a start can finish after a later one. */
  private asked = 0;
  private promoted = 0;
  /** With `pin`: each conversation's current owner. */
  private readonly claims = new Map<string, Claim<S>>();
  private epochs = 0;
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  /** The label each open one-off turn was given. */
  private readonly onceLabels = new Map<string, string>();
  private onceCount = 0;
  /** Sessions opening, which `shutdown` waits for. */
  private readonly opens = new Set<Promise<Live>>();
  /** Sessions whose close is in flight. */
  private readonly closing = new Set<Live>();
  /** Each live process a close failed in, with its latest failure; no
   * session is kept, so a harness that can't close holds none in memory. */
  private readonly unclosed = new Map<AcpProcess, unknown>();
  /** Each conversation a close failed in, while its process runs: held
   * work refuses it. */
  private readonly unended = new Map<string, Map<AcpProcess, unknown>>();
  /** Conversations whose session is opening, and the turn it opened for. */
  /** Messages waiting, in arrival order, for a turn ahead to free their
   * conversation's session. Stop clears them. */
  private readonly lines = new Map<
    string,
    { tail: Promise<void>; stop: AbortController; waiting: number }
  >();
  private readonly opening = new Map<string, Opened>();
  /** Conversations `exclusive` holds, which messages wait for. */
  private readonly held = new Map<string, Held>();
  /** Conversations whose last held work left a session not yet retired. */
  private readonly outliving = new Map<string, Outliving>();
  /** Holds waiting their turn, by conversation, which `interrupt` ends. */
  private readonly waiting = new Map<string, Set<AbortController>>();
  /** Resolves on `dispose`, ending waits on a session left running. */
  private readonly stopping: Promise<void>;
  private stop!: () => void;
  /** created_at of the newest event each conversation's session was shown. */
  private readonly shown = new Map<string, number>();
  /** With `pin`: retired sessions still opening or mid-turn, by conversation,
   * which Stop still reaches until they close. */
  private readonly retired = new Map<string, Set<Opened | Live>>();
  /** Conversations that have had a session, whose next new one may have been
   * prompted for the old one. */
  private readonly had = new Set<string>();
  private disposed = false;

  private readonly stopped: Settled;
  private readonly late: Settled;
  private get unconfirmed() {
    return `${this.options.label} could not confirm this conversation's session ended`;
  }

  constructor(private readonly options: SessionsOptions<S>) {
    this.stopping = new Promise((resolve) => (this.stop = resolve));
    this.stopped = { ok: false, error: `${options.label} was stopped` };
    this.late = {
      ok: false,
      error: `${options.label} did not start in time`,
      undelivered: true,
    };
  }

  /** What this conversation's session has been shown. */
  seen(key: string) {
    const live = this.live.get(key);
    if (live?.claim) return live.session.covered.at;
    return this.shown.get(key) ?? 0;
  }
  active(key: string) {
    return (
      this.opening.has(key) ||
      this.held.has(key) ||
      this.outliving.has(key) ||
      !!this.live.get(key)?.session.working
    );
  }
  /** Whether the work conversation or one-off turn `key`'s session runs now
   * still runs, unstopped and in that session, when asked later. */
  current(key: string): () => boolean {
    const serving = () => (this.live.get(key) ?? this.once.get(key))?.session;
    const session = serving();
    const current = session?.current();
    return () => !!current?.() && serving() === session;
  }
  /** The harness session serving a conversation or one-off turn, and the
   * process it lives in. */
  serving(key: string) {
    const live = this.live.get(key) ?? this.once.get(key);
    return live && { sessionId: live.session.id, process: live.process };
  }
  /** Conversations with a session, whether each is working, and when each
   * last took in a message or ended a turn. */
  snapshot(): {
    key: string;
    busy: boolean;
    sessionId?: string;
    at?: number;
  }[] {
    return [
      ...[...this.live].map(([key, live]) => ({
        key,
        busy: live.session.busy,
        sessionId: live.session.id,
        at: live.at,
      })),
      ...[...this.once.keys()].map((key) => ({ key, busy: true })),
    ];
  }

  /** Sends `text` into the conversation `key`, and resolves when the session
   * has answered it; the activity's `refresh`, if any, builds it again as
   * it is handed over, and `fresh` when the session it was built for was
   * closed;
   * `title` names a session opened for it, except that the conversation's
   * first one is left for the harness to name, if it names sessions, when `named`
   * takes that name;
   * `model`, one of the agent's
   * provider's, and `effort`, one of its thinking levels, are what its turn
   * runs on, and `kept`, a synced level, one it must run on; `route`
   * chooses them instead for a turn it starts (`Delivery.route`). Once
   * `signal` aborts, it stops
   * waiting for a session to open, which is then kept for the next message,
   * and sends nothing. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      current,
      fresh,
      title,
      named,
      signal,
      model,
      effort,
      kept,
      build,
      route,
      ...activity
    }: Readonly<{
      /** With `pin`: builds the turn's prompt when it is sent, from the
       * session's boundary, in place of `text`. */
      build?: BuildPrompt<S>;
      current?: () => boolean;
      fresh?: () => Promise<string>;
      title?: string;
      named?: (title: string) => void;
      signal?: AbortSignal;
      model?: string;
      effort?: string;
      kept?: string;
      route?: TurnRoute;
    }> &
      ActivityReceipt = {},
  ): Promise<Settled> {
    // Once taken, this message's place in line, left as it is admitted.
    let place: ReturnType<typeof this.join> | undefined;
    // The launch last read for an idle session, while it is still that one.
    let read: { live: Live; systemPrompt: string } | undefined;
    try {
      for (;;) {
        if (current && !current()) return { ok: true, undelivered: true };
        if (this.disposed) return { ...this.stopped, undelivered: true };
        // Cancelled during a read, whatever admission does next.
        if (read && place?.stop.aborted) return { ok: true, stopped: true };
        if (read && signal?.aborted) return this.late;
        if (!place && this.lines.has(key)) {
          place = this.join(key);
          const left = await this.wait(place.ahead, place.stop, signal);
          if (left) return left;
          continue;
        }
        // One that arrives while `exclusive` holds the conversation waits.
        const held = this.held.get(key);
        if (held) {
          const left = await this.wait(held.done, place?.stop, signal);
          if (left) return left;
          continue;
        }
        // Or while a session held work left running has yet to exit.
        const outliving = this.outliving.get(key);
        if (outliving) {
          if (outliving.failed)
            return { ok: false, error: this.unconfirmed, undelivered: true };
          const left = await this.wait(
            Promise.race([outliving.settled, this.stopping]),
            place?.stop,
            signal,
          );
          if (left) return left;
          continue;
        }
        // A message that arrives while its conversation's session opens uses it.
        const opening = this.opening.get(key);
        if (opening) {
          // The session stays shared; only this message gives up on it. A
          // pinned session's message takes its place in line, so Stop reaches
          // it meanwhile. An unpinned (goose) session's waits as on main.
          if (this.options.pin) place ??= this.join(key);
          const left = await this.wait(
            opening.catch(() => undefined),
            place?.stop,
            signal,
          );
          if (left) return left;
          continue;
        }
        const live = this.live.get(key);
        if (!live) break;
        // A pinned session opened before a local save takes no new message.
        if (live.claim && this.stale(live, key)) {
          this.retire(key);
          break;
        }
        // A turn on an idle session is chosen now, so its level is checked as
        // a picked one is; a busy session's queue asks once the turn starts.
        // Its place in line keeps a message that comes meanwhile behind it.
        if (route && live.session.open && !live.session.busy) {
          place ??= this.join(key);
          const chosen = await route();
          if (place.stop.aborted) return { ok: true, stopped: true };
          if (!chosen) return { ok: true, undelivered: true };
          ({ model, effort } = chosen);
          route = undefined;
          continue;
        }
        const turn = this.turn(live.claim, model, effort, build, route);
        // A turn on a harness default runs only on a session Buzz never moved
        // off it, which a turn still ahead of it may yet do: decide when it can
        // run.
        if (live.session.busy && this.waits(live.session, turn)) {
          place ??= this.join(key);
          const left = await this.wait(live.session.idle(), place.stop, signal);
          if (left) return left;
          continue;
        }
        if (
          !live.session.open ||
          (!live.session.busy &&
            (this.stale(live, key) ||
              this.leveled(live, effort) ||
              !this.fits(live.session, turn)))
        ) {
          if (live.session.open && live.claim) this.forget(key, live.claim);
          this.drop(key, live);
          break;
        }
        // A harness that cannot take a new prompt in place needs a new session.
        // The read holds this message's place, so Stop reaches it and what
        // arrives meanwhile waits; admission is then checked again.
        if (!live.session.busy && !live.process.repromptable) {
          if (read?.live !== live) {
            place ??= this.join(key);
            const { stop } = place;
            try {
              read = {
                live,
                ...(await abortable(
                  abortable(this.launchOf(live.claim, key), signal),
                  stop,
                )),
              };
            } catch (error) {
              if (stop.aborted) return { ok: true, stopped: true };
              if (signal?.aborted) return this.late;
              throw error;
            }
            continue;
          }
          if (read.systemPrompt !== live.systemPrompt) {
            if (live.claim) this.forget(key, live.claim);
            this.drop(key, live);
            continue;
          }
        }
        return this.answer(
          key,
          live,
          seen,
          text,
          { ...activity, ...(current ? { current } : {}) },
          turn.model,
          turn.effort,
          kept,
          turn,
        );
      }
    } finally {
      // Admitted, or gone: what arrived behind it may go on. Nothing is
      // awaited before a session opening for it is reserved.
      place?.leave();
    }
    // Pinned, owned and leased before anything is awaited.
    const pinned = this.options.pin?.(key);
    const claim = pinned && { epoch: ++this.epochs, pinned };
    if (claim) this.claims.set(key, claim);
    const lease = pinned && this.options.process.hold?.(pinned.generation);
    const turn = this.turn(claim, model, effort, build, route);
    // Reserved before anything is awaited, so a message that comes meanwhile
    // waits for this session instead of opening another.
    const starting = (async () => {
      const first = !this.had.has(key);
      // Perhaps built for a session closed since, which had been shown the rest.
      if (!first && fresh) text = await fresh();
      // Naming costs a model call: the harness names only the conversation's start.
      const naming = first ? named : undefined;
      let live: Live;
      try {
        live = await this.open(
          key,
          title,
          (live) => this.disposed || this.adopt(key, live),
          naming,
          claim && { claim, fits: (session) => this.fits(session, turn) },
        );
      } catch (error) {
        lease?.release();
        if (claim && this.claims.get(key) === claim) this.claims.delete(key);
        throw error;
      }
      if (lease) live.lease = lease;
      // `start` has closed it; its lease was not yet the session's.
      if (this.disposed) {
        lease?.release();
        throw new Error(`${this.options.label} was stopped`);
      }
      // Retired while it opened: it serves only its own message, then closes.
      const orphan = !!claim && this.live.get(key) !== live;
      const closeOrphan = () => {
        if (orphan)
          this.hold(
            key,
            live,
            live.session.idle().then(() => this.close(live)),
          );
      };
      if (signal?.aborted) {
        closeOrphan();
        return { live };
      }
      if (current && !current()) {
        closeOrphan();
        return {
          settled: Promise.resolve({ ok: true, undelivered: true } as Settled),
          live,
        };
      }
      const refresh = activity.refresh;
      const settled = this.answer(
        key,
        live,
        seen,
        text,
        {
          ...activity,
          ...(current ? { current } : {}),
          ...(refresh
            ? {
                refresh: () => refresh(!first),
              }
            : {}),
        },
        turn.model,
        turn.effort,
        kept,
        turn,
      );
      closeOrphan();
      return { settled, live };
    })();
    this.opening.set(key, starting);
    const opened = () => {
      if (this.opening.get(key) === starting) this.opening.delete(key);
    };
    starting.then(opened, opened);
    // Every failure here comes before a turn takes the message in.
    let started: Awaited<typeof starting>;
    try {
      started = await abortable(starting, signal);
    } catch (error) {
      if (this.disposed) return { ...this.stopped, undelivered: true };
      if (signal?.aborted) return this.late;
      console.warn(`${this.options.label} could not start`, error);
      const code = codeOf(error);
      return {
        ok: false,
        error: `${this.options.label} could not start: ${message(error)}`,
        ...(code === undefined ? {} : { code }),
        ...(this.options.pin && code === AUTH_REQUIRED
          ? { authMethods: authMethodsOf(error) }
          : {}),
        undelivered: true,
        ...(error instanceof HintedError ? { hint: error.hint } : {}),
      };
    }
    return started.settled ?? this.late;
  }

  /** Resolves once each session opening now has taken its message or
   * failed, so that `snapshot` lists every conversation that has one. */
  async opened() {
    await Promise.allSettled([...this.opening.values()]);
  }
  /** Stops the turn running in conversation `key`, if any, once a session
   * opening for it has taken its message. */
  async interrupt(key: string) {
    this.lines.get(key)?.stop.abort();
    this.lines.delete(key);
    // Held work is told at once, never waited for, as is work waiting to be.
    for (const waiting of this.waiting.get(key) ?? []) waiting.abort();
    this.held.get(key)?.controller.abort();
    const stopped = new Set<Live>();
    const stop = (item?: Promise<unknown> | Live) => {
      if (item && !(item instanceof Promise) && !stopped.has(item)) {
        stopped.add(item);
        item.session.interrupt();
      }
    };
    const retired = [...(this.retired.get(key) ?? [])];
    for (const item of [this.live.get(key), ...retired]) stop(item);
    // An opening stops only the session it produced, never a later one.
    await Promise.all(
      [this.opening.get(key), ...retired].map((item) =>
        item instanceof Promise
          ? item.catch(() => null).then((o) => stop(o?.live))
          : item,
      ),
    );
  }
  /** Includes the model call after a final send has answered the turn. */
  async idle(key: string) {
    await this.held.get(key)?.done;
    await this.opening.get(key)?.catch(() => undefined);
    await this.live.get(key)?.session.idle();
  }

  /** Runs `work` with conversation `key` to itself: messages wait for it.
   * It waits its turn behind a session opening, another hold and a session
   * one left running, until `interrupt`, `signal` or `dispose`, and is
   * refused, never queued, once a session left running could not be
   * confirmed ended. Its session finishes its work and is closed first, and
   * `work` starts only once the harness has acknowledged that close and
   * every earlier close of the conversation's sessions, or their process has
   * exited; it never starts after a close that was not, nor once interrupted
   * or stopped, when it rejects with "<label> was stopped". An interrupt
   * while it waits for a close takes effect when that close settles, within
   * REQUEST_TIMEOUT_MS. A close that failed refuses the conversation while
   * the process runs. Saved sessions are never deleted. `work` retires
   * whatever session it opens before it settles, or says what it
   * `outlives`, which messages and holds then wait for. Once `deadline`
   * aborts, it stops waiting its turn, as `deliver` stops waiting for a
   * session, and rejects with "<label> did not start in time"; work it has
   * started runs on. */
  async exclusive<T>(
    key: string,
    work: (exclusive: Exclusive) => Promise<T>,
    signal?: AbortSignal,
    deadline?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const follow = () => controller.abort(signal?.reason);
    if (signal?.aborted) follow();
    signal?.addEventListener("abort", follow, { once: true });
    try {
      const { mine, release } = await this.reserve(key, controller, deadline);
      try {
        return await this.handOff(key, mine, work);
      } finally {
        if (this.held.get(key) === mine) this.held.delete(key);
        release();
        this.options.onChange?.();
      }
    } finally {
      signal?.removeEventListener("abort", follow);
    }
  }

  /** Holds `key` once no session opens for it, no other work holds it and
   * no session held work left running is still to exit: reserved with
   * nothing awaited after the last check. Each wait ends on `controller`'s
   * abort, which `interrupt` reaches from the start, or on `dispose`; both
   * reject with "<label> was stopped". A session left running that could
   * not be confirmed ended refuses it. Once `deadline` aborts, a wait
   * rejects with "<label> did not start in time". */
  private async reserve(
    key: string,
    controller: AbortController,
    deadline?: AbortSignal,
  ) {
    const { label } = this.options;
    const waiting = this.waiting.get(key) ?? new Set<AbortController>();
    waiting.add(controller);
    this.waiting.set(key, waiting);
    try {
      for (;;) {
        if (this.disposed || controller.signal.aborted)
          throw new Error(`${label} was stopped`);
        const outliving = this.outliving.get(key);
        if (outliving?.failed) throw new Error(this.unconfirmed);
        const busy =
          this.opening.get(key) ??
          this.held.get(key)?.done ??
          outliving?.settled;
        if (!busy) break;
        if (deadline?.aborted) throw new Error(this.late.error);
        await abortable(
          Promise.race([busy.then(noop, noop), this.stopping]),
          deadline
            ? AbortSignal.any([controller.signal, deadline])
            : controller.signal,
        ).catch(noop);
      }
    } finally {
      waiting.delete(controller);
      if (!waiting.size && this.waiting.get(key) === waiting)
        this.waiting.delete(key);
    }
    let release!: () => void;
    const mine: Held = {
      controller,
      done: new Promise<void>((resolve) => (release = resolve)),
    };
    this.held.set(key, mine);
    this.options.onChange?.();
    return { mine, release };
  }

  /** Closes the conversation's session, then runs `work` under hold `mine`
   * with what is saved for it. */
  private async handOff<T>(
    key: string,
    mine: Held,
    work: (exclusive: Exclusive) => Promise<T>,
  ): Promise<T> {
    const { label, store } = this.options;
    const { controller } = mine;
    const live = this.live.get(key);
    if (live) {
      await live.session.idle();
      if (this.live.get(key) === live) this.drop(key, live);
    }
    await Promise.all(
      [...this.closing]
        .filter((closing) => closing.session.conversation === key)
        .map((closing) => this.strict(closing)),
    );
    for (const [process, error] of this.unended.get(key) ?? [])
      if (process.running) throw error;
    if (controller.signal.aborted || this.disposed)
      throw new Error(`${label} was stopped`);
    const saved = savedConversation(store?.get(key));
    // New session wins over whatever is saved, unread, so nothing stored can
    // stand in the way of the way out of it.
    const reset = saved?.next === "new";
    // A later message's session follows this one, as after any other.
    this.had.add(key);
    return await work({
      saved: reset ? undefined : saved?.sessions?.[0],
      reset,
      binding: reset ? undefined : association(saved),
      keep: (id, binding) => {
        // Stored, none would read back as damage.
        if (binding === undefined) return false;
        if (!store || this.held.get(key) !== mine) return false;
        const sessions = savedConversation(store.get(key))?.sessions ?? [];
        const kept = { session: id, value: binding };
        try {
          store.set(key, {
            at: Date.now(),
            sessions: [id, ...sessions.filter((other) => other !== id)].slice(
              0,
              SAVED_SESSIONS,
            ),
            binding: kept,
          });
          // Saved only once it reads back as written.
          const read = savedConversation(store.get(key));
          return (
            read?.sessions?.[0] === id &&
            read.next === undefined &&
            JSON.stringify(read.binding) === JSON.stringify(kept)
          );
        } catch (error) {
          console.warn(`${label} could not save a session`, error);
          return false;
        }
      },
      shown: (seen) => {
        if (this.held.get(key) === mine)
          this.shown.set(key, Math.max(seen, this.shown.get(key) ?? 0));
      },
      signal: controller.signal,
      outlives: (done) => {
        // Too late to block anything: the hold may already be another's.
        if (this.held.get(key) !== mine)
          throw new Error(`${label} has released this conversation`);
        // Every process the work left running is waited for, not just the
        // last, and a rejection of any keeps the conversation blocked.
        const prior = this.outliving.get(key);
        const exits = [...(prior?.exits ?? []), done];
        const outliving: Outliving = {
          exits,
          failed: false,
          settled: Promise.all(exits).then(
            () => {
              if (this.outliving.get(key) !== outliving) return;
              this.outliving.delete(key);
              this.options.onChange?.();
            },
            (error: unknown) => {
              // Only an exit retires it: an unknown owner stays blocking.
              outliving.failed = true;
              if (this.outliving.get(key) === outliving)
                console.warn(
                  `${label} could not confirm a session ended`,
                  error,
                );
            },
          ),
        };
        this.outliving.set(key, outliving);
      },
    });
  }

  /** New session (`new`): closes the conversation's session once it has
   * finished its work, so the next message opens one, and has held work
   * open a new one too, keeping every saved session listed. Compaction
   * compacts the open session; with `forwarded`, one with none whose newest
   * saved session held work keeps a value for is given to `forwarded`
   * instead. Either is chosen under a hold of the conversation, and is
   * refused once a session held work left running could not be confirmed
   * ended. Without either there is nothing to do. */
  async reset(
    key: string,
    action: SessionAction,
    forwarded?: (exclusive: Exclusive) => Promise<Settled>,
  ): Promise<Settled> {
    if (action !== "new" && !forwarded) return this.compact(key);
    let reservation: Awaited<ReturnType<typeof this.reserve>>;
    try {
      reservation = await this.reserve(key, new AbortController());
    } catch (error) {
      return this.disposed
        ? this.stopped
        : { ok: false, error: message(error) };
    }
    const { mine, release } = reservation;
    const { signal } = mine.controller;
    const { store, label } = this.options;
    try {
      const live = this.live.get(key);
      if (action !== "new") {
        if (live?.session.open) return await this.compact(key, signal);
        const saved = savedConversation(store?.get(key));
        if (!forwarded || saved?.next === "new" || !association(saved))
          return { ok: true };
        return await this.handOff(key, mine, forwarded);
      }
      if (live) await live.session.idle();
      // Interrupted while it waited: it does nothing more.
      if (signal.aborted || this.disposed) return this.stopped;
      // Saved before the session goes, so a failed save leaves it as it was.
      const saved = savedConversation(store?.get(key));
      if (store && saved?.sessions?.length) {
        store.set(key, { ...saved, next: "new" });
        // Done only once it reads back so: a store that kept the old record
        // would have the next held work resume what was left.
        const read = savedConversation(store.get(key));
        if (read?.next !== "new" || read.sessions?.[0] !== saved.sessions[0])
          return { ok: false, error: `${label} could not save New session` };
      }
      if (!live?.session.open) {
        // Or the next message would resume the saved session.
        if (this.options.resume) store?.drop?.(key);
      } else if (this.live.get(key) === live) {
        // Or the next message would resume the session the owner just left.
        if (live.claim && this.options.resume) this.forget(key, live.claim);
      }
      if (live && this.live.get(key) === live) this.drop(key, live);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: message(error) };
    } finally {
      if (this.held.get(key) === mine) this.held.delete(key);
      release();
      this.options.onChange?.();
    }
  }
  /** Waits for the conversation's session to finish its work, then compacts
   * it. Without an open session there is nothing to do. */
  private async compact(key: string, signal?: AbortSignal): Promise<Settled> {
    const live = this.live.get(key);
    if (!live?.session.open) return { ok: true };
    await live.session.idle();
    // Interrupted while it waited: nothing is sent.
    if (signal?.aborted || this.disposed) return this.stopped;
    if (this.live.get(key) !== live || !live.session.open) return { ok: true };
    const result = await this.answer(
      key,
      live,
      this.seen(key),
      "/compact",
      {},
      undefined,
    );
    // goose ends the turn either way, and says which in its text.
    if (!result.ok || result.text === "Compaction complete") return result;
    return {
      ok: false,
      error:
        result.text || `${this.options.label} could not compact the session`,
    };
  }

  /** Runs one turn in a new session, then closes it. `label` names it in the
   * snapshot. It gives up, and stops the turn, once `signal` aborts.
   * `prompt` is asked for the turn's text once the session is open, so a turn
   * that should no longer run by then returns undefined and sends nothing. */
  async runOnce(
    label: string,
    /** Given the session's pinned snapshot, when it has one. */
    prompt: (pinned?: S) => string | undefined | Promise<string | undefined>,
    {
      signal,
      title,
      current,
      kept,
    }: Readonly<{
      signal?: AbortSignal;
      current?: () => boolean;
      title?: string;
      kept?: string;
    }> = {},
  ): Promise<Settled> {
    if (this.disposed) return this.stopped;
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.onceLabels.set(key, label);
    this.options.onChange?.();
    // Pinned like a conversation's, but never an owner: it saves nothing.
    const pinned = this.options.pin?.();
    const claim = pinned && { epoch: 0, pinned };
    const turn = this.turn(claim, undefined, undefined, undefined, undefined);
    const lease = pinned && this.options.process.hold?.(pinned.generation);
    const opening = this.open(
      key,
      title,
      (live) => {
        if (lease) live.lease = lease;
        return this.once.has(key) && this.once.set(key, live);
      },
      undefined,
      claim && { claim, fits: () => true },
    );
    opening.catch(() => lease?.release());
    let live: Live | undefined;
    try {
      live = await abortable(opening, signal);
      if (this.disposed) return this.stopped;
      const text = await abortable(
        Promise.resolve(prompt(pinned?.snapshot)),
        signal,
      );
      if (text === undefined || this.disposed) return { ok: true };
      return await abortable(
        live.session.send(
          text,
          { ...(current ? { current } : {}) },
          turn.model,
          turn.effort,
          kept,
          turn,
        ),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: message(signal.reason) };
      console.warn(
        `${this.options.label} could not start a one-off session`,
        error,
      );
      // A pinned session's caller sets its sign-in state from these; an
      // unpinned (goose) one's result stays as on main.
      const code = this.options.pin ? codeOf(error) : undefined;
      return {
        ok: false,
        error: `${this.options.label} could not start: ${message(error)}`,
        ...(code === undefined ? {} : { code }),
        ...(code === AUTH_REQUIRED
          ? { authMethods: authMethodsOf(error) }
          : {}),
      };
    } finally {
      this.once.delete(key);
      this.onceLabels.delete(key);
      // One that opens after the turn was given up is closed once it has.
      if (live) await this.close(live);
      else void opening.then((late) => this.close(late)).catch(() => undefined);
      this.options.onChange?.();
    }
  }

  /** Closes idle sessions opened with old settings; busy ones close when they
   * next fall idle. With `pin`, every session pinned before a local save is
   * retired at once, opening and busy ones included. */
  reconfigure() {
    const { pin } = this.options;
    if (pin) {
      for (const [key, claim] of [...this.claims])
        if (claim.pinned.localKey !== pin(key).localKey) this.retire(key);
      return;
    }
    for (const [key, live] of this.live)
      if (!live.session.busy && this.stale(live, key)) this.drop(key, live);
  }

  /** Like `dispose()`, then resolves once every session it opened, or was
   * opening, is closed or its process has exited; rejects if one cannot be. */
  async shutdown() {
    this.dispose();
    await Promise.allSettled([
      ...this.opens,
      ...[...this.held.values()].map((held) => held.done),
    ]);
    const closed = await Promise.allSettled(
      [...this.closing].map((live) => this.strict(live)),
    );
    this.options.onChange?.();
    const failed = closed.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const [unclosed] = this.unclosed.values();
    if (this.unclosed.size) throw unclosed;
  }
  /** With `pin`: the live or opening route a message belongs to, under each
   * route's own pinned scope. Retired routes never match, an exact thread
   * route beats a channel route, and the newest wins a tie. */
  route(
    match: (pinned: S) => RouteMatch | undefined,
  ): Readonly<{ key: string; pinned: Pinned<S> }> | undefined {
    let best: { key: string; exact: boolean; claim: Claim<S> } | undefined;
    for (const [key, claim] of this.claims) {
      const found = match(claim.pinned.snapshot);
      // A route answers only for its own conversation.
      if (found?.key !== key) continue;
      if (
        !best ||
        (found.exact && !best.exact) ||
        (found.exact === best.exact && claim.epoch > best.claim.epoch)
      )
        best = { key, exact: found.exact, claim };
    }
    return best && { key: best.key, pinned: best.claim.pinned };
  }
  /** With `pin`: retires every session, even when the settings are unchanged;
   * the next message opens on the plugin's current generation. Busy and
   * opening ones finish their own turn first. */
  restart(): void {
    for (const key of [...this.claims.keys()]) this.retire(key);
  }
  /** After sign-in: fails live sessions, keeping their records, and restarts
   * the process through `process.restart`. */
  async reconnect(o: RestartOptions = {}): Promise<Settled> {
    const { process } = this.options;
    if (!process.restart)
      return { ok: false, error: "Restart isn't available for this agent" };
    for (const [key, live] of [...this.live]) {
      live.session.fail("Restarting after sign-in");
      this.drop(key, live);
    }
    return process.restart(o);
  }

  /** Closes its sessions, ending their turns; the process keeps serving other
   * agents. */
  dispose() {
    this.disposed = true;
    this.stop();
    for (const held of this.held.values()) held.controller.abort();
    this.claims.clear();
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) if (live) void this.close(live);
    // Retired mid-turn: its turn ends now, so `shutdown` waits for its close.
    for (const held of this.retired.values())
      for (const item of held) if ("session" in item) void this.close(item);
  }

  private get pool() {
    return this.options.pool ?? SHARED_POOL;
  }
  /** `serve` for a session in a process of its own, outside these: each
   * server it starts holds a busy slot in the pool, taken before it starts,
   * making room as a session's does, until it has closed. */
  pooled(serve: ServeMcp): ServeMcp {
    return async (handler) => {
      const { pool } = this;
      const slot: Slot = { idle: () => false, evict: async () => undefined };
      const released = () => pool.release(slot);
      try {
        await pool.take(slot);
        const server = await serve(handler);
        void server.closed.then(released, released);
        return server;
      } catch (error) {
        released();
        throw error;
      }
    };
  }

  /** Opened with old settings, which only a new session runs on. */
  /** The launch a session runs on now: its claim's snapshot, read afresh. */
  private launchOf(claim: Claim<unknown> | undefined, conversation?: string) {
    const { launchFor } = this.options;
    return claim && launchFor
      ? launchFor(claim.pinned.snapshot as S, conversation)
      : this.options.launch(conversation);
  }
  private stale(live: Live, key: string) {
    const { pin } = this.options;
    if (live.claim && pin)
      return live.claim.pinned.localKey !== pin(key).localKey;
    return live.fingerprint !== this.options.fingerprint();
  }
  /** A turn's model, effort and their sources: from its session's pinned
   * snapshot and the message's own pick when it pins. */
  private turn(
    claim: Claim<unknown> | undefined,
    model: string | undefined,
    effort: string | undefined,
    build: BuildPrompt<S> | undefined,
    route: TurnRoute | undefined,
  ): Turn & Pick {
    const own = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    const { pickFor } = this.options;
    const picked =
      claim && pickFor
        ? pickFor(claim.pinned.snapshot as S, model || effort ? own : undefined)
        : { pick: own, source: {} };
    return {
      ...picked.pick,
      source: picked.source,
      ...(build ? { build: build as BuildPrompt<never> } : {}),
      ...(route ? { route } : {}),
    };
  }
  /** Whether a session can take a turn on `pick`, with `configOptions`: only
   * a new session goes back to a default Buzz overrode, and a resumed one
   * reopens new when the pick is no longer offered. */
  private fits(session: AcpSession, pick: Pick) {
    if (!this.options.configOptions) return true;
    return (["model", "effort"] as const).every((field) => {
      const value = pick[field];
      if (!value) return !session.overridden[field];
      const control = session.state[field];
      return !session.resumed || !control || offers(control, value);
    });
  }
  /** With `configOptions`, whether `pick` leaves a field on its default that
   * the session is on, or a turn ahead of it moves, off its default. */
  /** Takes the last place in `key`'s line: `ahead` resolves at its head. */
  private join(key: string) {
    let line = this.lines.get(key);
    if (!line) {
      line = {
        tail: Promise.resolve(),
        stop: new AbortController(),
        waiting: 0,
      };
      this.lines.set(key, line);
    }
    const joined = line;
    const ahead = joined.tail;
    let pass!: () => void;
    joined.tail = new Promise<void>((resolve) => (pass = resolve));
    joined.waiting++;
    let left = false;
    return {
      ahead,
      stop: joined.stop.signal,
      leave: () => {
        if (left) return;
        left = true;
        // One that leaves early lets those behind it go only after those
        // ahead of it.
        void ahead.then(pass);
        // Stop reaches the line while anyone is still in it.
        if (--joined.waiting === 0 && this.lines.get(key) === joined)
          this.lines.delete(key);
      },
    };
  }

  /** Waits in line for `work`: a result once Stop or `signal` ends it. */
  private async wait(
    work: Promise<unknown>,
    stop: AbortSignal | undefined,
    signal?: AbortSignal,
  ): Promise<Settled | undefined> {
    try {
      await abortable(abortable(work, signal), stop);
    } catch {
      return stop?.aborted ? { ok: true, stopped: true } : this.late;
    }
  }

  private waits(session: AcpSession, pick: Pick) {
    if (!this.options.configOptions) return false;
    return (["model", "effort"] as const).some(
      (field) =>
        !pick[field] && (session.overridden[field] || session.sets(field)),
    );
  }
  /** Drops `key`'s saved record, only while `claim` owns it. */
  private forget(key: string, claim: Claim<unknown>) {
    if (this.claims.get(key) === claim) this.options.store?.drop?.(key);
  }
  /** Takes `key` from its owner: it takes no new message and writes nothing.
   * Its record stays only when its session is open and idle; one still
   * opening or mid-turn may yet use it, so the next owner must not. */
  private retire(key: string) {
    const live = this.live.get(key);
    const opening = this.opening.get(key);
    this.claims.delete(key);
    if (opening) this.hold(key, opening, opening);
    if (this.opening.delete(key) || live?.session.working)
      this.options.store?.drop?.(key);
    if (!live) return;
    clearTimeout(live.timer);
    this.live.delete(key);
    this.shown.delete(key);
    this.options.onChange?.();
    const closed = live.session.idle().then(() => this.close(live));
    this.hold(key, live, closed);
  }
  /** Keeps `item` reachable by Stop for `key` until `done` settles. */
  private hold(key: string, item: Opened | Live, done: Promise<unknown>) {
    const held = this.retired.get(key) ?? new Set();
    this.retired.set(key, held.add(item));
    void done
      .catch(() => undefined)
      .finally(() => {
        held.delete(item);
        if (!held.size && this.retired.get(key) === held)
          this.retired.delete(key);
      });
  }
  /** On a thinking level, when a turn with neither a pick nor a saved level
   * wants the harness's own. goose names no value for its own, so only a new
   * session runs on it; checked as that turn comes, so a session put on a
   * picked level keeps its conversation until then. */
  private leveled(live: Live, effort?: string) {
    if (this.options.configOptions) return false;
    return Boolean(
      live.session.effort && !effort && !this.options.choice().effort,
    );
  }

  /** Opens a session for `key` in the agent's workspace, which `use` records
   * as its user's. */
  /** With `pinned`, its launch and process come from that claim's snapshot
   * and generation alone, and it resumes the saved record while the claim
   * owns `key`. */
  private open(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
    named?: (title: string) => void,
    pinned?: Readonly<{
      claim: Claim<S>;
      fits(session: AcpSession): boolean;
    }>,
  ) {
    const opening = this.start(key, title, use, named, pinned);
    this.opens.add(opening);
    const done = () => {
      this.opens.delete(opening);
      this.stopReplaced();
    };
    opening.then(done, done);
    return opening;
  }
  private async start(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
    named?: (title: string) => void,
    pinned?: Readonly<{
      claim: Claim<S>;
      fits(session: AcpSession): boolean;
    }>,
  ): Promise<Live> {
    const { resolveDirectory } = this.options;
    const { pool } = this;
    const claim = pinned?.claim;
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = claim ? "" : this.options.fingerprint();
    const conversation = this.once.has(key) ? undefined : key;
    const launch = await this.launchOf(claim, conversation);
    if (claim) claim.prompt = digest(launch.systemPrompt);
    // Removed meanwhile: a process started now would outlive it.
    if (this.disposed) throw new Error(`${this.options.label} was stopped`);
    const asked = ++this.asked;
    const [process, cwd] = await Promise.all([
      claim && this.options.process.at
        ? this.options.process.at(claim.pinned.generation)
        : // Only this open is opening: no other can be in it.
          this.options.process.get(
            (process) => this.opens.size === 1 && !this.used(process),
          ),
      absolute(resolveDirectory, launch.workspace),
    ]);
    // A pinned session's process is its generation's, never the current one.
    if (claim) this.watch(process);
    else this.promote(process, asked);
    // Busy until it is adopted as a conversation's.
    const slot: Slot = { idle: () => false, evict: async () => undefined };
    const room = pool.take(slot);
    let opened: AcpSession | undefined;
    const tags = this.options.tags?.(conversation);
    const start = (resume?: string) =>
      process.open({
        ...(tags ? { tags } : {}),
        onSession: (session) => (opened = session),
        cwd,
        systemPrompt: launch.systemPrompt,
        ...(title ? { title } : {}),
        ...(named && !resume ? { named } : {}),
        tools: this.options.tools,
        choice: this.options.choice,
        ...(resume ? { resume } : {}),
      });
    // A resumed session not kept: its close is retired like any other.
    const discard = () => {
      if (opened)
        void this.close({
          session: opened,
          process,
          fingerprint,
          systemPrompt: launch.systemPrompt,
          slot,
          at: 0,
        });
      opened = undefined;
    };
    let session: AcpSession | undefined;
    try {
      await room;
      if (pinned) session = await this.resume(key, pinned, start, discard);
      session ??= await start().catch(async (error: unknown) => {
        // Other plugins hold servers too: make room once, and try again.
        const room = /too many mcp servers/i.test(message(error))
          ? pool.evict()
          : undefined;
        if (!room) throw error;
        await room;
        return start();
      });
    } catch (error) {
      pool.release(slot);
      // Opened but not set up: its close is retired like any other.
      if (opened)
        void this.close({
          session: opened,
          process,
          fingerprint,
          systemPrompt: launch.systemPrompt,
          slot,
          at: Date.now(),
        });
      throw error;
    }
    const released = () => pool.release(slot);
    void (session.server?.closed ?? Promise.resolve()).then(released, released);
    session.conversation = key;
    const live: Live = {
      session,
      process,
      fingerprint,
      systemPrompt: launch.systemPrompt,
      slot,
      at: Date.now(),
    };
    // Each turn runs on the current prompt. The session runs these one at a
    // time, so an older prompt never lands after a newer one. A failure fails
    // that turn undelivered, as a rule it no longer has would not hold for it,
    // and keeps the session to try again at the next turn.
    if (process.repromptable)
      session.beforeTurn = async () => {
        const { systemPrompt } = await this.launchOf(claim, conversation);
        if (systemPrompt === live.systemPrompt) return;
        try {
          await process.reprompt(session, systemPrompt);
        } catch (error) {
          throw new Error(
            `${this.options.label} could not update its instructions: ${errorMessage(error)}`,
          );
        }
        live.systemPrompt = systemPrompt;
        if (claim) {
          claim.prompt = digest(systemPrompt);
          // Its saved record resumes only on the prompt it now runs on.
          session.parity?.commit(session.covered);
        }
      };
    if (claim) {
      live.claim = claim;
      session.parity = this.parity(key, claim, session);
      session.parity.onState?.(session.state);
    } else if (fingerprint !== this.options.fingerprint() && !this.disposed) {
      // Settings saved while it opened: it would work with the old ones.
      void this.close(live);
      return this.open(key, title, use, named);
    }
    this.options.started?.(
      session.id,
      launch.systemPrompt,
      title,
      this.once.has(key) ? undefined : key,
      this.onceLabels.get(key),
      session.resumed,
    );
    // Removed meanwhile: the callers are gone, and `shutdown` waits for this.
    if (this.disposed) void this.close(live);
    use(live);
    return live;
  }

  /** The saved session for `key`, reopened, when its record matches the
   * claim's pinned context and the turn can run on it; otherwise the record
   * is dropped and undefined means open a new one. */
  private async resume(
    key: string,
    {
      claim,
      fits,
    }: Readonly<{ claim: Claim<S>; fits(session: AcpSession): boolean }>,
    start: (resume: string) => Promise<AcpSession>,
    discard: () => void,
  ) {
    const { store } = this.options;
    // A retired opening must never read its successor's record.
    if (!this.options.resume || this.claims.get(key) !== claim) return;
    const saved = store?.load?.(key);
    if (!saved) return;
    if (!saved.id || saved.context !== savedContext(claim)) {
      this.forget(key, claim);
      return;
    }
    // Its late close would unload the session resumed now: open a new one.
    if (this.closes(saved.id)) return;
    let session: AcpSession | undefined;
    try {
      session = await start(saved.id);
      session.covered = markOf(saved.covered);
      session.overridden = saved.overridden ?? { model: false, effort: false };
      if (fits(session)) return session;
    } catch (error) {
      console.warn(`${this.options.label} could not resume a session`, error);
    }
    discard();
    this.forget(key, claim);
    return undefined;
  }
  /** What a pinned session does for its owner: every write checks that the
   * claim still owns `key`. */
  private parity(key: string, claim: Claim<S>, session: AcpSession): Parity {
    const { store, refuse, onState } = this.options;
    return {
      pinned: claim.pinned.snapshot,
      configOptions: !!this.options.configOptions,
      setting: () => this.forget(key, claim),
      commit: (covered) => {
        if (this.claims.get(key) === claim)
          store?.advance?.(key, {
            id: session.id,
            covered,
            context: savedContext(claim),
            overridden: session.overridden,
          });
      },
      lost: () => this.forget(key, claim),
      ...(refuse ? { refuse } : {}),
      ...(onState
        ? { onState: (state) => onState(state, claim.pinned.snapshot) }
        : {}),
    };
  }

  private adopt(key: string, live: Live) {
    // Retired while it opened: it serves its message unadopted.
    if (live.claim && this.claims.get(key) !== live.claim) return;
    this.had.add(key);
    this.live.set(key, live);
    // Not idle while the message it opened for is still on its way to it.
    live.slot.idle = () =>
      !live.session.busy &&
      this.live.get(key) === live &&
      !this.opening.has(key);
    live.slot.evict = async () => {
      this.drop(key, live);
      await live.session.server?.closed;
    };
    // Not saved until a message is handed to it: its own may have given up.
    this.countdown(key, live);
    this.options.onChange?.();
  }
  private async answer(
    key: string,
    live: Live,
    seen: number,
    text: string,
    activity: ActivityReceipt,
    model: string | undefined,
    effort?: string,
    kept?: string,
    turn?: Turn,
  ) {
    const sent = live.session.send(
      text,
      {
        ...activity,
        delivered: () => {
          if (this.live.get(key) === live) this.touch(key, live, seen);
          activity.delivered?.();
        },
      },
      model,
      effort,
      kept,
      turn,
    );
    // A final Buzz send can answer before the harness finishes its model work.
    void live.session.idle().then(() => {
      if (this.live.get(key) === live) this.options.onChange?.();
    });
    // Sending made it busy; a snapshot read when it opened is not.
    this.options.onChange?.();
    const settled = await sent;
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (!live.session.busy && this.stale(live, key)) this.drop(key, live);
    }
    return settled;
  }
  /** Notes that the session took in a message or ended a turn, and what it
   * has been shown, and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    live.at = Date.now();
    const { store } = this.options;
    if (store?.touch) store.touch(key, live.at);
    else this.save(key, live.session.id, live.at);
    this.countdown(key, live);
    if (seen !== undefined)
      this.shown.set(key, Math.max(seen, this.shown.get(key) ?? 0));
  }
  /** Saves `id` as the conversation's newest session, used `at`. */
  private save(key: string, id: string, at: number) {
    const { store } = this.options;
    if (!store) return;
    const saved = savedConversation(store.get(key));
    const sessions = saved?.sessions ?? [];
    store.set(key, {
      at,
      sessions: [id, ...sessions.filter((kept) => kept !== id)].slice(
        0,
        SAVED_SESSIONS,
      ),
      ...(saved && "binding" in saved ? { binding: saved.binding } : {}),
      // New session holds until a session replacing the newest is saved.
      ...(saved?.next === "new" && id === sessions[0]
        ? { next: saved.next }
        : {}),
    });
  }
  /** Closes the session after IDLE_MS, or waits again while it is busy: a
   * long turn is not new use. */
  private countdown(key: string, live: Live) {
    this.pool.touch(live.slot);
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (live.session.busy) this.countdown(key, live);
      else if (this.live.get(key) === live) this.drop(key, live);
    }, IDLE_MS);
  }
  private drop(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.live.get(key) === live) {
      this.live.delete(key);
      this.shown.delete(key);
      this.options.onChange?.();
    }
    if (live.claim && this.claims.get(key) === live.claim)
      this.claims.delete(key);
    void this.close(live);
  }
  /** Closes the session, failing only for a caller that needs the harness to
   * have acknowledged it. */
  private strict(live: Live) {
    this.closing.add(live);
    return live.process.close(live.session, true).then(
      () => {
        this.closing.delete(live);
        this.stopReplaced();
      },
      (error: unknown) => {
        // No close is coming now, so it no longer blocks resuming it.
        this.closing.delete(live);
        if (live.process.running) {
          this.unclosed.set(live.process, error);
          const { conversation } = live.session;
          if (conversation !== undefined) {
            const failed = this.unended.get(conversation) ?? new Map();
            this.unended.set(conversation, failed.set(live.process, error));
          }
        }
        throw error;
      },
    );
  }
  /** Makes the latest ask's `process` the current one; an earlier ask's
   * that finished late is replaced, and stops once no session is in it. */
  private promote(process: AcpProcess, asked: number) {
    if (asked > this.promoted) {
      this.promoted = asked;
      if (this.process && this.process !== process)
        this.replaced.add(this.process);
      this.process = process;
    } else if (process !== this.process) this.replaced.add(process);
    this.watch(process);
  }
  /** Drops `process`'s sessions once it exits. */
  private watch(process: AcpProcess) {
    if (this.known.has(process)) return;
    this.known.add(process);
    void process.exited.then(() => {
      this.replaced.delete(process);
      if (this.process === process) this.process = undefined;
      this.unclosed.delete(process);
      for (const [key, failed] of this.unended)
        if (failed.delete(process) && !failed.size) this.unended.delete(key);
      for (const live of this.closing)
        if (live.process === process) this.closing.delete(live);
      for (const [key, live] of this.live)
        if (live.process === process) this.drop(key, live);
    });
  }
  /** Whether session `id` is retired, or its close is in flight. */
  private closes(id: string) {
    const held = [...this.retired.values()].flatMap((set) => [...set]);
    return [...held, ...this.closing].some(
      (item) => !(item instanceof Promise) && item.session.id === id,
    );
  }
  /** Whether a session is in `process`, or closing in it. */
  private used(process: AcpProcess) {
    return (
      [...this.live.values(), ...this.once.values(), ...this.closing].some(
        (live) => live?.process === process,
      ) || this.unclosed.has(process)
    );
  }
  /** Stops each replaced process that no session is in or opening in. */
  private stopReplaced() {
    if (this.opens.size) return;
    for (const process of this.replaced)
      if (!this.used(process)) {
        this.replaced.delete(process);
        void process.kill().catch(() => undefined);
      }
  }
  private close(live: Live) {
    const closing = this.strict(live).catch(() => undefined);
    // Its process may stop once no session holds it; released once.
    const { lease } = live;
    delete live.lease;
    void closing.finally(() => lease?.release());
    return closing;
  }
}

/** `workspace` as an absolute path, which ACP sessions need. One already
 * absolute stays as written, as the sessions started in it recorded it. */
export async function absolute(
  resolveDirectory: ResolveDirectory,
  workspace: string,
) {
  return absoluteWorkspace(workspace) ? workspace : resolveDirectory(workspace);
}

/** What a saved session must match to resume: its pinned context and the
 * prompt it ran on, which also holds core memory. */
const savedContext = (claim: Claim<unknown>) =>
  `${claim.pinned.context}.${claim.prompt ?? ""}`;

/** `work`, or a rejection with `signal`'s reason once it aborts. */
export function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

const noop = () => {};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A short, stable digest of `text`, so a saved record holds no
 * instructions or launch details (53-bit cyrb53). */
export function digest(text: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
