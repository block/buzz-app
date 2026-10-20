// One agent's goose sessions: one ACP session per conversation (a thread, a
// whole DM, or a channel), in the `goose-acp` process all goose agents share.
// A quiet conversation's session is closed; its next message opens a new one,
// shown the conversation again. A one-off turn (a watch or timer wake) gets a
// session of its own, closed when it ends. Every session holds one of the
// host's MCP servers, so all goose agents share one pool of them, and the least
// recently used idle session closes to make room. Sessions live as long as
// the app does; only when each conversation last used one is saved, so its
// sessions stay listed after they close.
import {
  GooseProcess,
  type ActivityReceipt,
  type Choice,
  type GooseHost,
  type GooseSession,
  type Handoff,
  type ServeMcp,
  type Settled,
  type ToolServer,
} from "./goose";
import type { SessionAction } from "../../features/agents/service";
import { absoluteWorkspace } from "../codex/config";
import {
  Refused,
  inputsFit,
  prompting,
  refusal,
  type Applied,
  type Inputs,
  type SettingsAttempt,
} from "../../features/agents/settings";
import type { Models } from "../../features/agents/service";

/** A conversation's session closes after this long without a message. */
export const IDLE_MS = 15 * 60_000;
/** The most MCP servers goose sessions hold at once, below the host's 64 for
 * every plugin, so other plugins keep room. */
export const POOL_LIMIT = 48;
const STOPPED: Settled = { ok: false, error: "goose was stopped" };
const LATE: Settled = { ok: false, error: "goose did not start in time" };
/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** What is saved for one conversation: when its session last took in a
 * message or ended a turn. */
export type SavedConversation = Readonly<{ at: number }>;
export type SessionStore = {
  set(key: string, saved: SavedConversation): void;
};

/** A session's hold on one MCP server in the pool. */
type Slot = {
  /** Whether it can be closed to make room: no turn runs in it. */
  idle(): boolean;
  /** Closes the session, and resolves once its server has stopped. */
  evict(): Promise<unknown>;
};

/** The MCP servers every goose agent's sessions hold, least recently used
 * first. One runtime shares one. */
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

/** The one `goose-acp` every goose agent's sessions open in, started in the
 * home folder when a session first needs it, and again after it exits. One
 * runtime shares one. */
export class SharedProcess {
  private ready: Promise<GooseProcess> | undefined;
  constructor(
    private readonly host: GooseHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<GooseProcess> {
    if (this.ready) return this.ready;
    const ready = (async () =>
      GooseProcess.start(this.host.spawn, {
        cwd: await this.host.resolveDirectory("~"),
        serve: this.serve,
      }))();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((goose) => goose.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }
  /** Stops it, failing every session in it. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    void ready?.then((goose) => goose.kill()).catch(() => undefined);
  }
}

/** What a session is opened with. */
export type Launch = Readonly<{
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  systemPrompt: string;
  /** The provider, model and thinking level each of the session's turns
   * runs on. */
  choice: Choice;
}>;

export type SessionsOptions = Readonly<{
  /** The host's, for the workspace's absolute path. */
  resolveDirectory: GooseHost["resolveDirectory"];
  /** Answers the agent's Buzz tools. */
  tools: ToolServer;
  /** The process all goose agents' sessions open in. */
  process: SharedProcess;
  /** The servers all goose agents' sessions hold. */
  pool: ServerPool;
  /** The agent's current settings, for a new session. */
  launch(): Promise<Launch>;
  /** Changes when an open session must be replaced: a local save or Restart
   * to apply. A remote edit leaves it, so a conversation keeps the config it
   * started with. */
  fingerprint(): string;
  /** The team text and name a session opened now runs on, read with
   * `fingerprint`; see `Inputs`. */
  inputs(): string;
  /** Where each conversation's last use is saved. */
  store?: SessionStore;
  /** The config a session opened now runs on, read with `fingerprint` before
   * `launch`, which must use the same config. */
  snapshot(): string;
  /** The settings and epoch a session opened now is pinned to, read with
   * `snapshot`. A session pinned to an older epoch is replaced. */
  applied(): Applied;
  /** The models each turn's provider and model can be asked to run on; see
   * `GooseSession`. */
  models?: (choice: Choice) => Promise<Models>;
  /** Called when a conversation's session opens, is sent a message, or
   * closes. */
  onChange?(): void;
}>;

/** A local save of a choice; `next` is the save after it, and `applied` the
 * settings and epoch it saved. A session `same` accepts was opened on what
 * it saved but the choice, so once switched it runs the saved settings. */
type Chosen = {
  choice: Choice;
  same: (snapshot: string) => boolean;
  after: string;
  applied: Applied;
  next?: Chosen;
};

/** Switches a session to a saved choice; one opened as the save was now
 * runs on the config saved, at its epoch. Any other keeps its older epoch,
 * which replaces it. */
const switchTo = (live: Live, { choice, same, after, applied }: Chosen) => {
  live.choice = choice;
  if (!same(live.snapshot)) return;
  live.snapshot = after;
  live.applied = applied;
};

type Live = Inputs & {
  session: GooseSession;
  process: GooseProcess;
  fingerprint: string;
  /** The config it opened on; only a local save of its choice
   * changes it while it is open. */
  snapshot: string;
  /** The settings it is pinned to, which each new turn hands off through. */
  applied: Applied;
  /** The provider, model and thinking level its turns run on. */
  choice: Choice;
  slot: Slot;
  /** When it last took in a message or ended a turn. */
  at: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class AgentSessions {
  /** The latest process its sessions opened in, whose exit drops them. */
  private process: GooseProcess | undefined;
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  /** Conversations whose session is opening, and the turn it opened for. */
  private readonly opening = new Map<
    string,
    Promise<{ settled?: Promise<Settled> }>
  >();
  /** created_at of the newest event each conversation's session was shown. */
  private readonly shown = new Map<string, number>();
  /** Conversations that have had a session, whose next new one may have been
   * prompted for the old one. */
  private readonly had = new Set<string>();
  private disposed = false;
  /** The latest local save of a choice, or none yet; a session opening
   * replays each save after the one it read with its settings. */
  private chosen: { next?: Chosen } = {};

  constructor(private readonly options: SessionsOptions) {}

  /** What this conversation's session has been shown. */
  seen(key: string) {
    return this.shown.get(key) ?? 0;
  }
  active(key: string) {
    return this.opening.has(key) || !!this.live.get(key)?.session.working;
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
   * has answered it. `steer` replaces `text` when the session is mid-turn;
   * `fresh` builds it again when the session it was built for was closed;
   * `title` names a session opened for it; `model`, one of the agent's
   * provider's, is what its turn runs on; `attempt` the settings it was
   * admitted with, which a new turn hands off through. A message that can't
   * steer into a busy session opened on superseded settings waits for its
   * turn to end, then opens a new one: it never prompts the old one. Once
   * `signal` aborts, it stops waiting for a session to open, which is then
   * kept for the next message, and sends nothing. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      fresh,
      title,
      signal,
      model,
      attempt,
      ...activity
    }: Readonly<{
      steer?: string;
      fresh?: () => Promise<string>;
      title?: string;
      signal?: AbortSignal;
      model?: string;
      attempt: SettingsAttempt;
    }> &
      ActivityReceipt,
  ): Promise<Settled> {
    for (;;) {
      if (this.disposed) return STOPPED;
      // A message that arrives while its conversation's session opens uses it.
      const opening = this.opening.get(key);
      if (opening) {
        // The session stays shared; only this message gives up on it.
        try {
          await abortable(
            opening.catch(() => undefined),
            signal,
          );
        } catch {
          return LATE;
        }
        continue;
      }
      const live = this.live.get(key);
      if (!live) break;
      if (!live.session.open || (!live.session.busy && this.stale(live))) {
        this.drop(key, live);
        break;
      }
      if (live.session.busy && this.stale(live)) {
        const steered = await live.session.steerOnly(
          steer,
          activity,
          model,
          signal,
        );
        if (steered) {
          this.touch(key, live, seen);
          return this.settled(key, live, steered.settled);
        }
        // Not into the old session: once its turn ends, it is replaced.
        try {
          await abortable(live.session.idle(), signal);
        } catch {
          return LATE;
        }
        continue;
      }
      this.touch(key, live, seen);
      return this.answer(
        key,
        live,
        live.session.busy ? steer : text,
        activity,
        model,
        attempt,
        signal,
      );
    }
    // Reserved before anything is awaited, so a message that comes meanwhile
    // waits for this session instead of opening another.
    const starting = (async () => {
      // Perhaps built for a session closed since, which had been shown the rest.
      if (this.had.has(key) && fresh) text = await fresh();
      const live = await this.open(
        key,
        title,
        (live) => this.disposed || this.adopt(key, live),
      );
      if (this.disposed) {
        void this.close(live);
        throw new Error("goose was stopped");
      }
      if (signal?.aborted) return {};
      this.touch(key, live, seen);
      return {
        settled: this.answer(key, live, text, activity, model, attempt, signal),
      };
    })();
    this.opening.set(key, starting);
    const opened = () => {
      if (this.opening.get(key) === starting) this.opening.delete(key);
    };
    starting.then(opened, opened);
    try {
      const { settled } = await abortable(starting, signal);
      return settled ? await settled : LATE;
    } catch (error) {
      if (this.disposed) return STOPPED;
      if (signal?.aborted) return LATE;
      if (error instanceof Refused) return refusal(error);
      console.warn("goose could not start", error);
      return { ok: false, error: `goose could not start: ${message(error)}` };
    }
  }

  /** Stops the turn running in conversation `key`, if any, once a session
   * opening for it has taken its message. */
  async interrupt(key: string) {
    await this.opening.get(key)?.catch(() => undefined);
    this.live.get(key)?.session.interrupt();
  }
  /** Waits for the conversation's session to finish its work, then compacts
   * it or closes it, so the message opens a new one. Without an open session
   * there is nothing to do. */
  async reset(key: string, action: SessionAction): Promise<Settled> {
    const live = this.live.get(key);
    if (!live?.session.open) return { ok: true };
    await live.session.idle();
    if (this.disposed) return STOPPED;
    if (this.live.get(key) !== live || !live.session.open) return { ok: true };
    if (action === "new") {
      this.drop(key, live);
      return { ok: true };
    }
    const result = await this.answer(key, live, "/compact", {}, undefined);
    // goose ends the turn either way, and says which in its text.
    if (!result.ok || result.text === "Compaction complete") return result;
    return {
      ok: false,
      error: result.text || "goose could not compact the session",
    };
  }

  /** Runs one turn in a new session, then closes it. `label` names it in the
   * snapshot. It gives up, and stops the turn, once `signal` aborts.
   * `prompt` is asked for the turn's text once the session is open, so a turn
   * that should no longer run by then returns undefined and sends nothing. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    attempt: SettingsAttempt,
    {
      signal,
      title,
    }: Readonly<{
      signal?: AbortSignal;
      title?: string;
    }> = {},
  ): Promise<Settled> {
    if (this.disposed) return STOPPED;
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    const opening = this.open(
      key,
      title,
      (live) => this.once.has(key) && this.once.set(key, live),
    );
    let live: Live | undefined;
    try {
      live = await abortable(opening, signal);
      if (this.disposed) return STOPPED;
      const text = await abortable(Promise.resolve(prompt()), signal);
      if (text === undefined || this.disposed) return { ok: true };
      return await abortable(
        live.session.send(
          text,
          {},
          undefined,
          handoffOf(live, attempt, this.options.inputs),
        ),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: message(signal.reason) };
      if (error instanceof Refused) return refusal(error);
      console.warn("goose could not start a one-off session", error);
      return { ok: false, error: `goose could not start: ${message(error)}` };
    } finally {
      this.once.delete(key);
      // One that opens after the turn was given up is closed once it has.
      if (live) await this.close(live);
      else void opening.then((late) => this.close(late)).catch(() => undefined);
      this.options.onChange?.();
    }
  }

  /** A local save of only the provider, model or thinking level: open and
   * opening sessions switch to it from their next turn. Those opened on
   * what `same` accepts now run on the config saved, pinned to `applied`. */
  choose(
    choice: Choice,
    same: (snapshot: string) => boolean,
    applied: Applied,
  ) {
    const chosen: Chosen = {
      choice,
      same,
      after: this.options.snapshot(),
      applied,
    };
    this.chosen.next = chosen;
    this.chosen = chosen;
    for (const live of this.live.values()) switchTo(live, chosen);
  }

  /** Whether a conversation's session is pinned to settings other than the
   * ones `current` accepts. */
  outdated(current: (pin: Applied) => boolean) {
    return [...this.live.values()].some((live) => !current(live.applied));
  }

  /** Closes idle sessions opened with old settings; busy ones close when they
   * next fall idle. */
  reconfigure() {
    for (const [key, live] of this.live)
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
  }

  /** Closes its sessions, ending their turns; the process keeps serving other
   * agents. */
  dispose() {
    this.disposed = true;
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) if (live) void this.close(live);
  }

  /** Opened with old settings, pinned to an older epoch than a choice could
   * switch it to, or on a thinking level when goose's own is chosen now,
   * which only a new session runs on. */
  /** The settings `key`'s open session is pinned to once it has sent its
   * first prompt; undefined while it has none or hasn't prompted. */
  pinOf(key: string) {
    const live = this.live.get(key);
    return live?.session.open && live.inputs === undefined
      ? live.applied
      : undefined;
  }
  private stale(live: Live) {
    return (
      live.fingerprint !== this.options.fingerprint() ||
      !inputsFit(live, this.options.inputs()) ||
      live.applied.epoch !== this.options.applied().epoch ||
      Boolean(live.session.effort && !live.choice.effort)
    );
  }

  /** Opens a session for `key` in the agent's workspace, which `use` records
   * as its user's. */
  private async open(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
  ): Promise<Live> {
    const { pool, resolveDirectory } = this.options;
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint();
    const inputs = this.options.inputs();
    const snapshot = this.options.snapshot();
    const applied = this.options.applied();
    const chosen = this.chosen;
    const launch = await this.options.launch();
    // Removed meanwhile: a goose started now would outlive it.
    if (this.disposed) throw new Error("goose was stopped");
    const [process, cwd] = await Promise.all([
      this.options.process.get(),
      absolute(resolveDirectory, launch.workspace),
    ]);
    if (process !== this.process) {
      this.process = process;
      void process.exited.then(() => {
        for (const [key, live] of this.live)
          if (live.process === process) this.drop(key, live);
      });
    }
    // Busy until it is adopted as a conversation's.
    const slot: Slot = { idle: () => false, evict: async () => undefined };
    const room = pool.take(slot);
    // Asked as the session opens and before each turn.
    let live: Live | undefined;
    const start = () =>
      process.open({
        cwd,
        systemPrompt: launch.systemPrompt,
        ...(title ? { title } : {}),
        tools: this.options.tools,
        choice: () => live?.choice ?? launch.choice,
        ...(this.options.models ? { models: this.options.models } : {}),
      });
    let session: GooseSession;
    try {
      await room;
      session = await start().catch(async (error: unknown) => {
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
      throw error;
    }
    const released = () => pool.release(slot);
    void (session.server?.closed ?? Promise.resolve()).then(released, released);
    session.conversation = key;
    live = {
      session,
      process,
      fingerprint,
      inputs,
      snapshot,
      applied,
      choice: launch.choice,
      slot,
      at: Date.now(),
    };
    for (let next = chosen.next; next; next = next.next) switchTo(live, next);
    if (
      (fingerprint !== this.options.fingerprint() ||
        inputs !== this.options.inputs() ||
        live.applied.epoch !== this.options.applied().epoch) &&
      !this.disposed
    ) {
      // Settings saved while it opened: it would work with the old ones.
      void this.close(live);
      return this.open(key, title, use);
    }
    use(live);
    return live;
  }

  private adopt(key: string, live: Live) {
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
  private answer(
    key: string,
    live: Live,
    text: string,
    activity: ActivityReceipt,
    model: string | undefined,
    attempt?: SettingsAttempt,
    signal?: AbortSignal,
  ) {
    return this.settled(
      key,
      live,
      live.session.send(
        text,
        activity,
        model,
        attempt && handoffOf(live, attempt, this.options.inputs),
        signal,
      ),
    );
  }
  private async settled(key: string, live: Live, sent: Promise<Settled>) {
    // A final Buzz send can answer before goose finishes its model work.
    void live.session.idle().then(() => {
      if (this.live.get(key) === live) this.options.onChange?.();
    });
    // Sending made it busy; a snapshot read when it opened is not.
    this.options.onChange?.();
    const settled = await sent;
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
    }
    return settled;
  }
  /** Notes that the session took in a message or ended a turn, and what it
   * has been shown, and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    live.at = Date.now();
    this.options.store?.set(key, { at: live.at });
    this.countdown(key, live);
    if (seen !== undefined)
      this.shown.set(key, Math.max(seen, this.shown.get(key) ?? 0));
  }
  /** Closes the session after IDLE_MS, or waits again while it is busy: a
   * long turn is not new use. */
  private countdown(key: string, live: Live) {
    this.options.pool.touch(live.slot);
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
    void this.close(live);
  }
  private close(live: Live) {
    return live.process.close(live.session);
  }
}

/** How a new turn in `live` hands off: through `attempt`, with the pin `live`
 * holds when the turn's prompt is written. */
const handoffOf =
  (live: Live, attempt: SettingsAttempt, inputs: () => string): Handoff =>
  (send) =>
    attempt.handoff(live.applied, prompting(live, inputs, send));

/** Conversations saved in local storage, by agent and then conversation. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = "buzz.goose.sessions.v1",
): SessionStore & {
  /** Saved conversations, most recently used first. */
  list(): [string, SavedConversation][];
} {
  const readAll = (): Record<string, Record<string, SavedConversation>> => {
    try {
      const value = JSON.parse(storage.getItem(name) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const list = (saved: Record<string, SavedConversation> = {}) =>
    Object.entries(saved)
      .filter(([, conversation]) => typeof conversation?.at === "number")
      .sort(([, a], [, b]) => b.at - a.at);
  return {
    list: () => list(readAll()[agent]),
    set: (key, saved) => {
      const all = readAll();
      const kept = list({ ...all[agent], [key]: saved }).slice(0, SAVED_LIMIT);
      all[agent] = Object.fromEntries(kept);
      try {
        storage.setItem(name, JSON.stringify(all));
      } catch (error) {
        console.warn("goose sessions were not saved", error);
      }
    },
  };
}

/** `workspace` as an absolute path, which ACP sessions need. One already
 * absolute stays as written, as the sessions started in it recorded it. */
export async function absolute(
  resolveDirectory: GooseHost["resolveDirectory"],
  workspace: string,
) {
  return absoluteWorkspace(workspace) ? workspace : resolveDirectory(workspace);
}

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

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
