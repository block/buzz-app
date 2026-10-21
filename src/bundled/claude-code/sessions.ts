// One agent's Claude sessions: one per conversation (a thread, or a whole DM),
// each continuing across messages and app restarts. A conversation in use keeps
// its process; a quiet one is stopped and resumed from its saved session when it
// is next addressed. One spare process, shared by every agent, waits for the
// next new conversation, so that starts without a spawn. A one-off turn (a
// watch or timer wake) gets a new session of its own, which is never saved,
// resumed or shared.
import {
  ClaudeProcess,
  type ClaudeLaunch,
  type ClaudeModel,
  type ActivityReceipt,
  type Settled,
  type Spawn,
  type ToolServer,
  type TurnPick,
} from "./claude";
import { STANDALONE_DEADLINE_MS } from "../../features/agent-harness/standalone";
import type { AgentStore } from "../../features/agents/store";
import {
  Refused,
  inputsFit,
  prompting,
  refusal,
  type Applied,
  type Inputs,
  type SettingsAttempt,
} from "../../features/agents/settings";

export { Refused };

/** A conversation's process stops after this long without a message or its
 * own activity, such as background work. */
export const IDLE_MS = 15 * 60_000;
/** How long a one-off turn can run before it is given up; Janet's turn
 * deadline. */
export const ONCE_DEADLINE_MS = STANDALONE_DEADLINE_MS;
/** Saved sessions per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** What is saved for one conversation. */
export type SavedSession = Readonly<{
  id: string;
  /** created_at of the newest event this session has been shown. */
  seen: number;
  at: number;
}>;
export type SessionStore = {
  get(key: string): SavedSession | undefined;
  set(key: string, session: SavedSession): void;
  delete(key: string): void | Promise<void>;
};

export type SessionsOptions = Readonly<{
  spawn: Spawn;
  /** Where a new conversation looks for a process already started. */
  spare?: Spare;
  store: SessionStore;
  /** How to start a process with the agent's current settings, for the
   * conversation `key` when given, in `folders` when its turn named them.
   * Throws `Refused` when those settings can't run a turn; `skipEffort`
   * is set for a turn that picked its own model or effort. */
  launch(
    key?: string,
    folders?: Folders,
    skipEffort?: boolean,
  ): Promise<Omit<ClaudeLaunch, "resume" | "sessionId">>;
  /** Changes when a running process must be replaced: a local save,
   * Restart to apply, or the conversation `key`'s turn naming other
   * `folders`. A remote edit leaves it, so a conversation keeps the config
   * it started with. */
  fingerprint(key?: string, folders?: Folders): string;
  /** The team text and name a process started now runs on, read with
   * `fingerprint`; see `Inputs`. */
  inputs(): string;
  /** The config a process started now runs on, read with `fingerprint`
   * before `launch`, which must use the same config. */
  snapshot(): string;
  /** The settings and epoch a process started now is pinned to, read with
   * `snapshot`. */
  applied(): Applied;
  /** Why `process` can't run an explicit `pick`, checked before a new turn
   * hands off: the pick is as asked, not yet checked against any list. */
  refusedPick?(
    process: ClaudeProcess,
    pick: TurnPick,
  ): Promise<Refused | undefined>;
  now?(): number;
  newId?(): string;
  /** Called when a conversation's process starts, is sent a message, or
   * stops. */
  onChange?(): void;
}>;

/** The project folders a turn's process works in; undefined keeps the
 * conversation's own. */
export type Folders = readonly string[] | undefined;

/** A turn's text and the folders it describes, built again for a new session. */
export type Fresh = Readonly<{ text: string; folders?: Folders }>;

type Live = Inputs & {
  process: ClaudeProcess;
  fingerprint: string;
  /** The config it started on; never changes while it runs. */
  snapshot: string;
  /** The settings it is pinned to, which a new turn's handoff checks. */
  applied: Applied;
  /** The project folders it was started in. */
  directories: readonly string[];
  used: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Settles once it is idle again after its latest message. */
  idle?: Promise<unknown>;
  /** Settles once the turn checking its pick has sent or been refused; a
   * later message waits for it rather than overtaking that turn. */
  claim?: Promise<void>;
};

export class AgentSessions {
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  private readonly opening = new Map<string, Promise<Live | Settled>>();
  /** A turn waiting for its conversation's busy process to move to other
   * folders: later turns wait until it is placed, so none overtakes it. */
  private readonly handovers = new Map<string, Promise<void>>();
  private discovery:
    | {
        fingerprint: string;
        snapshot: string;
        result: Promise<{
          models: readonly ClaudeModel[];
          model: string | undefined;
          effort: string | undefined;
        }>;
        process?: ClaudeProcess | undefined;
      }
    | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: SessionsOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** What `seen` says this conversation's session has been shown. */
  seen(key: string) {
    return this.options.store.get(key)?.seen ?? 0;
  }
  active(key: string) {
    return this.opening.has(key) || !!this.live.get(key)?.process.active;
  }
  async forget(key: string) {
    // Commit the reset before dropping the live process; failed writes must
    // not report success and resume the old session after restarting Buzz.
    await this.options.store.delete(key);
    const live = this.live.get(key);
    if (live) this.drop(key, live);
    this.options.onChange?.();
  }
  /** Conversations with a running process, and whether each is working. */
  snapshot() {
    return [
      ...[...this.live].map(([key, live]) => ({
        key,
        busy: live.process.busy,
      })),
      ...[...this.once.keys()].map((key) => ({ key, busy: true })),
    ];
  }

  /** The settings `key`'s running process is pinned to once it has sent its
   * first prompt; undefined while it has none or hasn't prompted. */
  pinOf(key: string) {
    const live = this.live.get(key);
    return live?.process.running && live.inputs === undefined
      ? live.applied
      : undefined;
  }
  /** Whether the conversation's next turn runs on a process it keeps, started
   * on config other than `current`, rather than one started now. */
  pinned(key: string, folders?: Folders) {
    const live = this.live.get(key);
    return (
      !!live &&
      live.process.running &&
      this.fits(key, live, folders) &&
      live.snapshot !== this.options.snapshot()
    );
  }

  /** Read defaults without assigning the shared spare to this agent: from
   * `key`'s own process when it runs on config `at`, else any such one, else
   * a discovery process started where `at` says. Callers capture `at` from
   * one config in one synchronous step, so a result is never stored under
   * settings other than the ones that produced it. */
  async metadata(
    key: string | undefined,
    at: Readonly<{ snapshot: string; where: Where }>,
  ) {
    const fingerprint = this.options.fingerprint();
    const current = at.snapshot;
    const launch = at.where;
    const read = async (process: ClaudeProcess) => {
      const [models, model, effort] = await Promise.all([
        process.models(),
        process.readModel(),
        process.readEffort(),
      ]);
      return { models, model, effort };
    };
    // Discovery started on other config reports that config's model.
    const fresh = (
      discovery: AgentSessions["discovery"],
    ): discovery is NonNullable<AgentSessions["discovery"]> =>
      discovery?.fingerprint === fingerprint && discovery.snapshot === current;
    const own = key === undefined ? undefined : this.live.get(key);
    const candidates = [
      ...(own ? [own] : []),
      ...[...this.live.values()].filter((live) => live !== own),
    ];
    for (const live of candidates)
      if (
        live.fingerprint ===
          (live === own ? this.options.fingerprint(key) : fingerprint) &&
        live.process.running &&
        live.snapshot === current
      ) {
        const metadata = await read(live.process);
        const discovered = fresh(this.discovery)
          ? await this.discovery.result
          : undefined;
        return { ...metadata, model: metadata.model ?? discovered?.model };
      }
    if (this.disposed)
      return { models: [], model: undefined, effort: undefined };
    if (fresh(this.discovery)) return this.discovery.result;
    this.clearDiscovery();
    const discovery: NonNullable<AgentSessions["discovery"]> = {
      fingerprint,
      snapshot: current,
      result: Promise.resolve().then(async () => {
        // Never given a turn, and read by the check `launch` makes.
        if (this.disposed || this.discovery !== discovery)
          throw new Error("Claude was stopped");
        const process = await ClaudeProcess.start(this.options.spawn, {
          cwd: launch.cwd,
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.effort ? { effort: launch.effort } : {}),
          systemPrompt: "",
        });
        discovery.process = process;
        try {
          if (this.disposed || this.discovery !== discovery)
            throw new Error("Claude was stopped");
          return await read(process);
        } finally {
          await process.kill();
          discovery.process = undefined;
        }
      }),
    };
    this.discovery = discovery;
    void discovery.result.catch(() => {
      if (this.discovery === discovery) this.discovery = undefined;
    });
    return discovery.result;
  }
  private clearDiscovery() {
    void this.discovery?.process?.kill();
    this.discovery = undefined;
  }

  /** Sends `text` into the conversation `key`, and resolves when the session
   * has answered it. `steer` replaces `text` when the session is mid-turn;
   * `fresh` builds it again for a new session when the saved one is lost;
   * `pick` is the model and effort the turn was asked to run with; `folders`
   * are the ones `text` describes; `attempt` the settings the turn was
   * admitted with, which a new turn hands off through. A process started for
   * it is refused where `launch` reads the settings it starts with. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      fresh,
      pick = {},
      folders,
      attempt,
      step,
      acknowledged,
      superseded,
      activityScope,
    }: Readonly<{
      steer?: string;
      fresh?: () => Promise<Fresh>;
      pick?: TurnPick;
      folders?: Folders;
      attempt: SettingsAttempt;
    }> &
      ActivityReceipt,
  ): Promise<Settled> {
    let live: Live | undefined;
    let handover: Promise<void> | undefined;
    let release = () => {};
    const placed = () => {
      if (this.handovers.get(key) === handover) this.handovers.delete(key);
      release();
    };
    for (;;) {
      if (this.disposed) {
        placed();
        return { ok: false, error: "Claude was stopped" };
      }
      const waiting = this.handovers.get(key);
      if (waiting && waiting !== handover) {
        await waiting;
        continue;
      }
      // A message that arrives while its conversation's process starts uses
      // it. Checked without awaiting first, so the first message opens it at
      // once.
      const opening = this.opening.get(key);
      if (opening) {
        await opening;
        continue;
      }
      live = this.live.get(key);
      if (live?.claim) {
        await live.claim;
        continue;
      }
      // A busy process started in other folders than `text` describes is
      // never steered: the turn waits for it, then is placed again.
      if (
        live?.process.running &&
        live.process.busy &&
        folders &&
        JSON.stringify(folders) !== JSON.stringify(live.directories)
      ) {
        if (!handover) {
          handover = new Promise<void>((resolve) => (release = resolve));
          this.handovers.set(key, handover);
        }
        await Promise.race([live.idle, live.process.exited]).catch(
          () => undefined,
        );
        continue;
      }
      break;
    }
    if (
      live &&
      (!live.process.running ||
        (!this.fits(key, live, folders) && !live.process.busy))
    ) {
      this.drop(key, live);
      live = undefined;
    }
    if (live) {
      placed();
      this.touch(key, live, seen);
      // Steering joins a turn that already started; only a new one hands off.
      return this.answer(key, live, live.process.busy ? steer : text, {
        ...(live.process.busy ? {} : { attempt }),
        ...pick,
        ...(activityScope ? { activityScope } : {}),
        ...(step ? { step } : {}),
        ...(acknowledged ? { acknowledged } : {}),
        ...(superseded ? { superseded } : {}),
      }).catch(asRefusal);
    }
    const saved = this.options.store.get(key);
    const opening = this.open(
      key,
      saved?.id,
      seen,
      folders,
      pick.model !== undefined || pick.effort !== undefined,
    );
    placed();
    const opened = await opening;
    if (!("process" in opened)) return opened;
    live = opened;
    const activity = {
      ...pick,
      ...(activityScope ? { activityScope } : {}),
      ...(step ? { step } : {}),
      ...(acknowledged ? { acknowledged } : {}),
      ...(superseded ? { superseded } : {}),
    };
    let delivered: Settled;
    try {
      delivered = await this.answer(key, live, text, { ...activity, attempt });
    } catch (error) {
      // Refused before sending: the saved session never ran, so it is kept.
      return asRefusal(error);
    }
    // A saved session that no longer loads starts over rather than failing
    // every message in the conversation, shown the conversation so far.
    if (!delivered.ok && saved && !live.process.started) {
      await this.options.store.delete(key);
      this.drop(key, live);
      let next: Fresh = { text, folders };
      try {
        if (fresh) next = await fresh();
      } catch (error) {
        return { ok: false, error: String(error) };
      }
      return this.deliver(key, next.text, seen, {
        pick,
        folders: next.folders,
        attempt,
        ...activity,
      });
    }
    return delivered;
  }

  /** Stops the turn running in conversation `key`, if any, once a process
   * starting for it has taken its message. */
  async interrupt(key: string) {
    await this.opening.get(key);
    await this.live.get(key)?.process.interrupt();
  }
  /** Compacts the conversation's session, resuming it when its process has
   * stopped. Without a session there is nothing to compact. */
  async compact(key: string): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "Claude was stopped" };
    let live = this.live.get(key);
    const saved = this.options.store.get(key);
    if (!live && !saved) return { ok: true };
    if (!live) {
      const opened = await this.open(key, saved?.id, 0);
      if (!("process" in opened)) return opened;
      live = opened;
    }
    // Claude takes the command in stream-json input as it does in a terminal.
    const settled = await this.answer(key, live, "/compact", {});
    // A saved session that no longer loads is the message's to start over.
    if (!settled.ok && !live.process.started) {
      await this.options.store.delete(key);
      this.drop(key, live);
      return { ok: true };
    }
    return settled;
  }

  /** Runs one turn in a new session, then stops its process. The session is
   * not saved, so it never displaces a conversation's saved session and is
   * never resumed. `label` names it in the snapshot. It gives up, and stops
   * the turn, after `deadline` ms of running. `prompt` is asked for the turn's
   * text once a process is ready, so a turn that should no longer run by then
   * returns undefined and sends nothing. It settles only when its process has
   * exited, so it shows as working while it may still be working. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    attempt: SettingsAttempt,
    deadline = ONCE_DEADLINE_MS,
  ): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "Claude was stopped" };
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    let live: Live | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      live = await this.start(undefined);
      if (this.disposed) return { ok: false, error: "Claude was stopped" };
      // A key no conversation uses: its tools have no default destination.
      live.process.conversation = key;
      live.process.onActivity = this.options.onChange;
      this.once.set(key, live);
      const text = await prompt();
      if (text === undefined || this.disposed) return { ok: true };
      const pinned = live;
      return await Promise.race([
        // Refused when the inputs it started on changed while `prompt` ran.
        attempt.handoff(
          pinned.applied,
          prompting(pinned, this.options.inputs, () =>
            pinned.process.send(text),
          ),
        ),
        new Promise<Settled>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                ok: false,
                error: `The turn ran past its ${Math.round(deadline / 1000)}s deadline and was stopped`,
              }),
            deadline,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof Refused) return refusal(error);
      console.warn("Claude could not start a one-off session", error);
      return { ok: false, error: "Claude could not start" };
    } finally {
      clearTimeout(timer);
      if (live) {
        // Killing only asks it to stop; the host may let it run a few seconds.
        void live.process.kill();
        await live.process.exited.catch(() => undefined);
      }
      this.once.delete(key);
      this.options.onChange?.();
    }
  }

  /** Whether a conversation's process is pinned to settings other than the
   * ones `current` accepts. */
  outdated(current: (pin: Applied) => boolean) {
    return [...this.live.values()].some((live) => !current(live.applied));
  }

  /** Stops idle processes started with old settings; busy ones stop when they
   * next fall idle. */
  reconfigure() {
    this.clearDiscovery();
    for (const [key, live] of this.live)
      if (!this.fits(key, live) && !live.process.busy) this.drop(key, live);
  }

  dispose() {
    this.disposed = true;
    this.clearDiscovery();
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) void live?.process.kill();
  }

  /** Starts the conversation's process, resuming session `resume` when given;
   * a message that arrives meanwhile waits for it, and is answered after the
   * caller's. */
  private open(
    key: string,
    resume: string | undefined,
    seen: number,
    folders?: Folders,
    skipEffort?: boolean,
  ): Promise<Live | Settled> {
    const opened = this.start(resume, key, folders, skipEffort).then(
      (live): Live | Settled => {
        if (this.opening.get(key) === opened) this.opening.delete(key);
        if (this.disposed) {
          void live.process.kill();
          return { ok: false, error: "Claude was stopped" };
        }
        this.adopt(key, live, seen);
        return live;
      },
      (error): Settled => {
        if (this.opening.get(key) === opened) this.opening.delete(key);
        if (error instanceof Refused) return refusal(error);
        console.warn("Claude could not start", error);
        return { ok: false, error: "Claude could not start" };
      },
    );
    this.opening.set(key, opened);
    return opened;
  }

  /** Whether `key`'s process may take its next turn rather than be
   * replaced. */
  private fits(key: string, live: Live, folders?: Folders) {
    return (
      live.fingerprint === this.options.fingerprint(key, folders) &&
      inputsFit(live, this.options.inputs())
    );
  }

  private async start(
    resume: string | undefined,
    key?: string,
    folders?: Folders,
    skipEffort?: boolean,
  ): Promise<Live> {
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint(key, folders);
    const inputs = this.options.inputs();
    const snapshot = this.options.snapshot();
    const applied = this.options.applied();
    const launch = await this.options.launch(key, folders, skipEffort);
    const directories = launch.directories ?? [];
    const process = resume
      ? await ClaudeProcess.start(this.options.spawn, { ...launch, resume })
      : await this.fresh(launch);
    if (
      (fingerprint === this.options.fingerprint(key, folders) &&
        inputs === this.options.inputs()) ||
      this.disposed
    )
      return {
        process,
        fingerprint,
        inputs,
        snapshot,
        applied,
        directories,
        used: this.now(),
      };
    // Settings saved while it started: it would work with the old ones.
    void process.kill();
    return this.start(resume, key, folders, skipEffort);
  }
  /** A process for a new session: the spare when it fits, else a new one. */
  private async fresh(launch: Omit<ClaudeLaunch, "resume" | "sessionId">) {
    const spare = await this.options.spare?.take(launch);
    if (spare)
      try {
        await spare.initialize(launch);
        return spare;
      } catch {
        void spare.kill();
      }
    return ClaudeProcess.start(this.options.spawn, {
      ...launch,
      sessionId: this.newId(),
    });
  }
  private adopt(key: string, live: Live, seen: number) {
    live.process.conversation = key;
    live.process.onActivity = this.options.onChange;
    // Not a stop: a turn that reports finished work may be about to start.
    live.process.onQuiet = () => {
      if (this.live.get(key) === live) this.touch(key, live);
    };
    this.live.set(key, live);
    this.touch(key, live, seen);
    this.options.onChange?.();
    void live.process.exited.then(() => {
      if (this.live.get(key) === live) this.drop(key, live);
    });
  }
  /** Sends `text` on `live`, or throws `Refused` having sent nothing. */
  private async answer(
    key: string,
    live: Live,
    text: string,
    {
      attempt,
      ...activity
    }: TurnPick & ActivityReceipt & { attempt?: SettingsAttempt },
  ): Promise<Settled> {
    // A pick is checked against the process the turn runs on, whose list
    // it reports itself; steering into a running turn picks nothing new.
    let sent: Promise<Settled>;
    if (attempt && (activity.model || activity.effort)) {
      let release!: () => void;
      const claim = new Promise<void>((resolve) => (release = resolve));
      live.claim = claim;
      try {
        const refused = await this.options.refusedPick?.(
          live.process,
          activity,
        );
        if (refused) throw refused;
        sent = this.handoff(live, text, activity, attempt);
      } finally {
        if (live.claim === claim) delete live.claim;
        release();
      }
    } else
      sent = attempt
        ? this.handoff(live, text, activity, attempt)
        : live.process.send(text, activity);
    live.idle = sent;
    // Sending made it busy; a snapshot read when it started is not.
    this.options.onChange?.();
    const settled = await sent;
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (!this.fits(key, live) && !live.process.busy) this.drop(key, live);
    }
    return settled;
  }
  private handoff(
    live: Live,
    text: string,
    activity: TurnPick & ActivityReceipt,
    attempt: SettingsAttempt,
  ) {
    return attempt.handoff(
      live.applied,
      prompting(live, this.options.inputs, () =>
        live.process.send(text, activity),
      ),
    );
  }
  /** Saves the session as used now, when it takes in a message or ends a
   * turn, and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    live.used = this.now();
    this.countdown(key, live);
    const id = live.process.sessionId;
    if (!id) return;
    const prior = this.options.store.get(key);
    this.options.store.set(key, {
      id,
      seen: Math.max(seen ?? 0, prior?.id === id ? prior.seen : 0),
      at: live.used,
    });
  }
  /** Stops the process after IDLE_MS, or waits again while it is active:
   * a long turn or background work is not new use. */
  private countdown(key: string, live: Live) {
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (live.process.active) this.countdown(key, live);
      else if (this.live.get(key) === live) this.drop(key, live);
    }, IDLE_MS);
  }
  private drop(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.live.get(key) === live) {
      this.live.delete(key);
      this.options.onChange?.();
    }
    void live.process.kill();
  }
}

/** Where a process runs and may work, its model and effort: all a spare is
 * started with. */
export type Where = Pick<
  ClaudeLaunch,
  "cwd" | "directories" | "model" | "effort"
>;
const place = ({ cwd, directories = [], model, effort }: Where) =>
  JSON.stringify([cwd, directories, model ?? "", effort ?? ""]);

/** One process started ahead of need, for whichever agent next starts a
 * conversation where it runs and with its model and effort. Starting is most
 * of the wait before a new conversation's first reply; giving the process its
 * prompt is not.
 * It is kept only where the runtime's agents run, and follows the latest new
 * conversation among those places, the likeliest place for the next. */
export class Spare {
  private next:
    | { place: string; process: Promise<ClaudeProcess | undefined> }
    | undefined;
  /** Where a spare is wanted: set by the runtime alone. */
  private wanted: readonly Where[] = [];
  /** Not started again after it failed to start or died, until a conversation
   * asks for one, so a `claude` that cannot run is not started over and over. */
  private stopped = false;

  constructor(
    private readonly spawn: Spawn,
    /** Answers the tool server before any agent has it: it lists the tools. */
    private readonly tools: ToolServer,
    private readonly newId: () => string = () => crypto.randomUUID(),
    /** Changes when the tools it lists would; a spare listing others is not
     * handed over. */
    private readonly toolsKey: () => string = () => "",
  ) {}

  /** Wants a spare for one of `wheres`, or none when there are none. */
  warm(...wheres: Where[]) {
    this.wanted = wheres;
    if (!wheres.length) this.stopped = false;
    this.fill(wheres);
  }

  /** The spare, when it was started for `where`. Another is started for
   * `where` when a spare is wanted there, else where one is wanted. */
  async take(where: Where) {
    const next = this.next;
    this.next = undefined;
    this.stopped = false;
    const here = this.wanted.some((wanted) => place(wanted) === place(where));
    this.fill(here ? [where] : this.wanted);
    if (next?.place !== this.place(where)) {
      void next?.process.then((process) => process?.kill());
      return undefined;
    }
    const process = await next.process;
    if (process?.running) return process;
    void process?.kill();
    return undefined;
  }

  dispose() {
    this.warm();
  }

  private place(where: Where) {
    return JSON.stringify([place(where), this.toolsKey()]);
  }

  /** Keeps the spare when it fits one of `wheres`, else starts one for the
   * first; with none, keeps none. */
  private fill(wheres: readonly Where[]) {
    const current = this.next;
    if (current && wheres.some((where) => this.place(where) === current.place))
      return;
    this.next = undefined;
    void current?.process.then((process) => process?.kill());
    const [first] = wheres;
    if (this.stopped || !first) return;
    const next = {
      place: this.place(first),
      process: ClaudeProcess.spawn(this.spawn, {
        ...first,
        sessionId: this.newId(),
        tools: this.tools,
      }).catch((error) => {
        console.warn("Claude could not start a spare session", error);
        return undefined;
      }),
    };
    this.next = next;
    void next.process.then(async (process) => {
      await process?.exited;
      if (this.next !== next) return;
      this.next = undefined;
      this.stopped = true;
    });
  }
}

/** Where sessions were kept for every agent in one value, before each agent's
 * had its own key. */
export const LEGACY_SESSIONS = "buzz.claude-code.sessions.v1";

/** Sessions saved in agent storage, one key per agent, by conversation. Each
 * agent's own key lets programs that run different agents share the storage. */
export function localSessions(
  storage: AgentStore,
  agent: string,
  name = LEGACY_SESSIONS,
): SessionStore & {
  /** Saved sessions, most recently used first. */
  list(): [string, SavedSession][];
} {
  const key = `${name}:${agent}`;
  const object = (text: string | null) => {
    try {
      const value = JSON.parse(text ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const read = (): Record<string, SavedSession> => {
    const own = storage.get(key);
    return own === null
      ? (object(storage.get(name))[agent] ?? {})
      : object(own);
  };
  const update = (change: (sessions: Record<string, SavedSession>) => void) => {
    const sessions = { ...read() };
    change(sessions);
    const kept = Object.entries(sessions)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, SAVED_LIMIT);
    const own = storage.set(key, JSON.stringify(Object.fromEntries(kept)));
    // Drop the legacy copy only after the agent's own value is durable.
    return own.then(async () => {
      const legacy = object(storage.get(name));
      if (!(agent in legacy)) return;
      delete legacy[agent];
      await storage.set(
        name,
        Object.keys(legacy).length ? JSON.stringify(legacy) : null,
      );
    });
  };

  return {
    list: () =>
      Object.entries(read())
        .filter(([, saved]) => typeof saved?.id === "string")
        .sort(([, a], [, b]) => b.at - a.at),
    get: (conversation) => {
      const saved = read()[conversation];
      return saved && typeof saved.id === "string" ? saved : undefined;
    },
    set: (conversation, session) => {
      void update((sessions) => {
        sessions[conversation] = session;
      }).catch((error) =>
        console.warn("Claude sessions were not saved", error),
      );
    },
    delete: (conversation) =>
      update((sessions) => {
        delete sessions[conversation];
      }),
  };
}

/** A turn refused before sending, as its result; other errors propagate. */
function asRefusal(error: unknown): Settled {
  if (error instanceof Refused) return refusal(error);
  throw error;
}
