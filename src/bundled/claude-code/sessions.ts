// One agent's Claude sessions: one per conversation (a thread, or a whole DM),
// each continuing across messages and app restarts. A conversation in use keeps
// its process; a quiet one is stopped and resumed from its saved session when it
// is next addressed. One spare process, shared by every agent, waits for the
// next new conversation, so that starts without a spawn. A one-off turn (a
// watch or timer wake) gets a new session of its own, which is never saved,
// resumed or shared.
import { steerPrompt } from "./prompt";
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
import type { AgentStore } from "../../features/agents/store";
import type { GatewayBinding } from "../../features/agents/gateway/contract";
import type { Generation } from "./forwarding";

/** A conversation's process stops after this long without a message or its
 * own activity, such as background work. */
export const IDLE_MS = 15 * 60_000;
/** Saved sessions per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** What is saved for one conversation. */
export type SavedSession = Readonly<{
  protection?: string;
  id: string;
  /** created_at of the newest event this session has been shown. */
  seen: number;
  /** Thread-local history in a shared channel session. Older saves have none. */
  threads?: Readonly<Record<string, number>>;
  /** Its gateway binding (the Buzz session beside this harness session),
   * once a forwarded turn ran in it. Kept while the session resumes. */
  gateway?: unknown;
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
   * conversation `key` when given. */
  launch(key?: string): Promise<Omit<ClaudeLaunch, "resume" | "sessionId">>;
  /** Changes when a setting that a running process fixed has changed, for the
   * conversation `key` when given. */
  fingerprint(key?: string): string;
  now?(): number;
  newId?(): string;
  /** Told of each new session, never a resumed one, with the prompt it was
   * started with. */
  started?(sessionId: string, systemPrompt: string): void;
  /** Called when a conversation's process starts, is sent a message, or
   * stops. */
  onChange?(): void;
}>;

type DeliveryOptions = Readonly<{
  steer?: string;
  current?: () => boolean;
  refresh?: (fresh?: boolean) => Promise<string>;
  fresh?: () => Promise<string>;
  pick?: TurnPick;
  /** The thread whose history was supplied to a shared channel session. */
  contextRoot?: string;
  /** Rejects a turn the current settings can't start, asked after every
   * wait just before the prompt is sent. Not asked of a busy process, which
   * steers on the settings it already runs. */
  admit?: () => Promise<void>;
  /** This turn's gateway generation for harness session `session`, given
   * its saved binding; it throws, failing the delivery before anything
   * spawns, when the turn can't be forwarded. A forwarded turn gets a
   * process of its own that no other turn shares. */
  forward?: Forward;
  /** False when a saved session Claude no longer has is not to be started
   * over: it is forgotten, and the delivery has nothing to do. */
  startOver?: false;
}> &
  ActivityReceipt;

export type Forward = (session: string, saved: unknown) => Promise<Forwarded>;
export type Forwarded = Readonly<{
  generation: Generation;
  binding: GatewayBinding;
}>;
const REVOKED =
  "This agent's gateway access changed before the turn could start.";

/** A process `shutdown` can stop and wait for. */
type Stoppable = Readonly<{ kill(): unknown; exited: Promise<unknown> }>;

type Live = {
  process: ClaudeProcess;
  fingerprint: string;
  used: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The forwarded turn this process serves, and its binding. */
  forwarded?: Forwarded;
  /** It serves one forwarded delivery alone: it
   * stops at the qualifying idle and holds the conversation till it exits. */
  exclusive?: boolean;
  /** Told at Claude's qualifying idle. */
  idled?: () => void;
};

export class AgentSessions {
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  private readonly handing = new Map<string, Promise<void>>();
  private readonly opening = new Map<string, Promise<Live | Settled>>();
  /** Per conversation, from a forwarded turn's opening until its process has
   * exited and native has closed its generation: no other turn starts in
   * between, so no turn runs on another's generation or overlaps it. */
  private readonly forwarding = new Map<string, Promise<void>>();
  private discovery:
    | {
        fingerprint: string;
        result: Promise<{
          models: readonly ClaudeModel[];
          model: string | undefined;
          effort: string | undefined;
        }>;
        process?: ClaudeProcess | undefined;
      }
    | undefined;
  private disposed = false;
  /** Every process this pool may have started for the agent, from the moment
   * it asked for one until it exits: `shutdown` stops and waits for them all,
   * those still starting too. */
  private readonly started = new Set<Promise<Stoppable>>();
  /** The host's spawn, recording what it starts; none starts once disposed. */
  private readonly spawn: Spawn = (id, options) =>
    this.disposed
      ? Promise.reject(new Error("Claude was stopped"))
      : this.track(this.options.spawn(id, options));
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: SessionsOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** What `seen` says this conversation's session has been shown. */
  seen(key: string, contextRoot?: string) {
    const saved = this.options.store.get(key);
    return (contextRoot ? saved?.threads?.[contextRoot] : saved?.seen) ?? 0;
  }
  protectionContext(key: string) {
    const live = this.live.get(key) ?? this.once.get(key);
    if (!live) throw new Error("The protected Claude session is unavailable");
    return live.process.protectionContext();
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

  /** Read defaults without assigning the shared spare to this agent. */
  async metadata() {
    const fingerprint = this.options.fingerprint();
    const read = async (process: ClaudeProcess) => {
      const [models, model, effort] = await Promise.all([
        process.models(),
        process.readModel(),
        process.readEffort(),
      ]);
      return { models, model, effort };
    };
    for (const live of this.live.values())
      if (live.fingerprint === fingerprint && live.process.running) {
        const metadata = await read(live.process);
        const discovered =
          this.discovery?.fingerprint === fingerprint
            ? await this.discovery.result
            : undefined;
        return { ...metadata, model: metadata.model ?? discovered?.model };
      }
    if (this.disposed)
      return { models: [], model: undefined, effort: undefined };
    if (this.discovery?.fingerprint === fingerprint)
      return this.discovery.result;
    this.clearDiscovery();
    const discovery: NonNullable<AgentSessions["discovery"]> = {
      fingerprint,
      result: Promise.resolve().then(async () => {
        const launch = await this.options.launch();
        if (this.disposed || this.discovery !== discovery)
          throw new Error("Claude was stopped");
        const process = await ClaudeProcess.start(this.spawn, {
          cwd: launch.cwd,
          ...(launch.protection
            ? { protection: launch.protection, discovery: true }
            : {}),
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
   * `pick` is the model and effort the turn was asked to run with. */
  deliver(
    key: string,
    text: string,
    seen: number,
    options: DeliveryOptions = {},
  ): Promise<Settled> {
    const prior = this.handing.get(key);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.handing.set(key, pending);
    const handed = () => {
      release();
      if (this.handing.get(key) === pending) this.handing.delete(key);
    };
    const send = () => this.submit(key, text, seen, options, handed);
    return (prior ? prior.then(send) : send()).finally(handed);
  }

  private async submit(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      current,
      forward,
      refresh,
      fresh,
      pick = {},
      contextRoot,
      admit,
      step,
      acknowledged,
      superseded,
      submitted,
      activityScope,
      startOver,
    }: DeliveryOptions,
    handed: () => void,
  ): Promise<Settled> {
    for (;;) {
      if (this.disposed)
        return { ok: false, error: "Claude was stopped", undelivered: true };
      const opening = this.opening.get(key);
      if (opening) await opening;
      if (current && !current()) return { ok: true, undelivered: true };
      // An eligible delivery's process serves it alone: anything else
      // starts after it, in a new process.
      const barrier = this.forwarding.get(key);
      if (barrier) {
        await barrier;
        continue;
      }
      let live = this.live.get(key);
      // An eligible delivery decides its own routing, in a process of its
      // own: an ordinary process's work, background work and the turns its
      // completion starts too, ends at Claude's idle, and the process exits
      // first.
      if (live && forward) {
        const { process } = live;
        // Rechecked once woken: Claude may report activity in the same
        // output as its idle, before this resumes. Its exit ends the wait.
        while (!process.idle && process.running)
          await Promise.race([
            new Promise<void>((resolve) => {
              if (live) live.idled = resolve;
            }),
            process.exited,
          ]);
        this.drop(key, live);
        await process.exited;
        continue;
      }
      if (
        live &&
        (!live.process.running ||
          (live.fingerprint !== this.options.fingerprint(key) &&
            !live.process.busy))
      ) {
        this.drop(key, live);
        live = undefined;
      }
      const saved = live ? undefined : this.options.store.get(key);
      if (!live) {
        // A forwarded turn names its session before spawning; others let
        // the process mint one.
        const session = forward ? (saved?.id ?? this.newId()) : "";
        const opened = await this.open(
          key,
          saved?.id,
          0,
          undefined,
          forward &&
            (async () => ({
              session,
              forwarded: await forward(session, saved?.gateway),
            })),
        );
        if (!("process" in opened)) return opened;
        live = opened;
      }
      // A forwarded process this turn won't use stops, ending its barrier.
      // A session it never started was never written: the next turn starts
      // a new one rather than resume it.
      const mine = live;
      const leave = async (settled: Settled) => {
        if (!mine.exclusive) return settled;
        this.drop(key, mine);
        if (!saved && !mine.process.started)
          await this.options.store.delete(key);
        return settled;
      };
      if (refresh) {
        text = await refresh();
        steer = steerPrompt(text);
      }
      // Last, after every wait: a new turn starts only on settings that still
      // hold. A busy process steers on the settings it already runs.
      if (admit && !live.process.busy)
        try {
          await admit();
        } catch (error) {
          return await leave({
            ok: false,
            error: message(error),
            undelivered: true,
          });
        }
      if (current && !current())
        return await leave({ ok: true, undelivered: true });
      if (this.disposed)
        return { ok: false, error: "Claude was stopped", undelivered: true };
      // Refresh can outlive the process or the settings it was opened with,
      // and the route its generation was opened on.
      if (
        this.live.get(key) !== live ||
        !live.process.running ||
        live.forwarded?.generation.isRevoked() ||
        (live.fingerprint !== this.options.fingerprint(key) &&
          !live.process.busy)
      ) {
        await leave({ ok: true });
        continue;
      }
      this.touch(key, live, seen, contextRoot);
      const activity = {
        ...pick,
        ...(activityScope ? { activityScope } : {}),
        ...(step ? { step } : {}),
        ...(acknowledged ? { acknowledged } : {}),
        ...(superseded ? { superseded } : {}),
        ...(submitted ? { submitted } : {}),
      };
      const answering = this.answer(
        key,
        live,
        live.process.busy ? steer : text,
        activity,
      );
      // Later messages may steer this turn once its prompt has been submitted.
      handed();
      const delivered = await answering;
      // A saved session that no longer loads starts over rather than failing
      // every message in the conversation, shown the conversation so far.
      // An eligible one starts over only when Claude said the session is
      // gone; a failed sign-in, network or startup keeps it and its binding.
      const lost = !delivered.ok && !!saved && !live.process.started;
      if (lost && startOver === false && live.process.missingSession) {
        await this.options.store.delete(key);
        this.drop(key, live);
        return { ok: true };
      }
      if (
        lost &&
        startOver !== false &&
        (!forward || live.process.missingSession)
      ) {
        let retry: string;
        try {
          await this.options.store.delete(key);
          this.drop(key, live);
          retry = fresh ? await fresh() : text;
        } catch (error) {
          console.warn("Claude could not start over", error);
          return {
            ok: false,
            error: `Claude could not start over: ${error instanceof Error ? error.message : String(error)}`,
            undelivered: true,
          };
        }
        return this.deliver(key, retry, seen, {
          pick,
          ...(current ? { current } : {}),
          ...(admit ? { admit } : {}),
          ...(refresh ? { refresh: () => refresh(true) } : {}),
          ...(contextRoot ? { contextRoot } : {}),
          ...(forward ? { forward } : {}),
          ...activity,
        });
      }
      return delivered;
    }
  }

  /** Stops the turn running in conversation `key`, if any, once a process
   * starting for it has taken its message. */
  async interrupt(key: string) {
    await this.opening.get(key);
    await this.live.get(key)?.process.interrupt();
  }
  /** Compacts the conversation's session, resuming it when its process has
   * stopped. Without a session there is nothing to compact. `forward` runs
   * it as a forwarded turn does, in a process and generation of its own on
   * the saved session, which is forgotten, never replaced, once Claude says
   * it's gone. */
  async compact(
    key: string,
    forward?: Forward,
    current?: () => boolean,
  ): Promise<Settled> {
    if (forward) {
      if (!this.live.has(key) && !this.options.store.get(key))
        return { ok: true };
      return this.deliver(key, "/compact", 0, {
        forward,
        startOver: false,
        ...(current ? { current } : {}),
      });
    }
    // Never into a forwarded turn's process, on its generation.
    while (this.forwarding.has(key)) await this.forwarding.get(key);
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
    // A bound one is forgotten only once Claude says it's gone: an auth or
    // network failure keeps it, and its Buzz session id, for the next turn.
    if (
      !settled.ok &&
      !live.process.started &&
      (!saved?.gateway || live.process.missingSession)
    ) {
      await this.options.store.delete(key);
      this.drop(key, live);
      return { ok: true };
    }
    return settled;
  }

  /** Runs one turn in a new session, then stops its process. The session is
   * not saved, so it never displaces a conversation's saved session and is
   * never resumed. `label` names it in the snapshot. It gives up, and stops
   * the turn, once `signal` aborts. `prompt` is asked for the turn's text once
   * a process is ready, so a turn that should no longer run by then returns
   * undefined and sends nothing. It settles only when its process has exited,
   * so it shows as working while it may still be working. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    signal?: AbortSignal,
    forward?: Forward,
  ): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "Claude was stopped" };
    if (signal?.aborted) return { ok: false, error: message(signal.reason) };
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    // Its process as soon as it exists, so one still initializing can be
    // stopped; one that spawns after the turn was given up is stopped at once.
    let spawned: ClaudeProcess | undefined;
    let over = false;
    let forwarded: Forwarded | undefined;
    try {
      const session = forward ? this.newId() : "";
      // Nothing saved: the caller binds it standalone, like the session. Not
      // abandoned on abort: the caller closes a generation opened late, and
      // `finally` closes one that arrives.
      if (forward)
        try {
          forwarded = await forward(session, undefined);
        } catch (error) {
          // A turn that can't be forwarded fails visibly, saying why.
          if (signal?.aborted)
            return { ok: false, error: message(signal.reason) };
          return { ok: false, error: message(error) };
        }
      signal?.throwIfAborted();
      const live = await abortable(
        this.start(
          undefined,
          undefined,
          (process) => {
            spawned = process;
            if (over) void process.kill();
          },
          forwarded && { session, forwarded },
        ),
        signal,
      );
      const generation = forwarded?.generation;
      if (generation) {
        live.process.onIdle = () => generation.seal();
        void generation.revoked.then(() => live.process.kill());
      }
      if (this.disposed) return { ok: false, error: "Claude was stopped" };
      // A key no conversation uses: its tools have no default destination.
      live.process.conversation = key;
      live.process.onActivity = this.options.onChange;
      this.once.set(key, live);
      const text = await abortable(Promise.resolve(prompt()), signal);
      if (text === undefined || this.disposed) return { ok: true };
      if (generation?.isRevoked()) return { ok: false, error: REVOKED };
      return await abortable(live.process.send(text), signal);
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: message(signal.reason) };
      console.warn("Claude could not start a one-off session", error);
      return { ok: false, error: "Claude could not start" };
    } finally {
      over = true;
      if (spawned) {
        // Killing only asks it to stop; the host may let it run a few seconds.
        void spawned.kill();
        await spawned.exited.catch(() => undefined);
      }
      // Claude ends its turn the same either way; native drops it on reload.
      await forwarded?.generation.close().catch(() => undefined);
      this.once.delete(key);
      this.options.onChange?.();
    }
  }

  /** Stops idle processes started with old settings; busy ones stop when they
   * next fall idle. */
  reconfigure() {
    this.clearDiscovery();
    for (const [key, live] of this.live)
      if (
        live.fingerprint !== this.options.fingerprint(key) &&
        !live.process.busy
      )
        this.drop(key, live);
  }

  async shutdown() {
    this.dispose();
    await Promise.allSettled(
      [...this.started].map(async (started) => {
        const process = await started;
        void process.kill();
        await process.exited;
      }),
    );
  }
  private track<T extends Stoppable>(started: Promise<T>) {
    const done = () => void this.started.delete(started);
    this.started.add(started);
    void started.then((process) => process.exited.then(done, done), done);
    return started;
  }
  dispose() {
    this.disposed = true;
    this.clearDiscovery();
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) void live?.process.kill();
  }

  /** Starts the conversation's process, resuming session `resume` when given;
   * a message that arrives meanwhile waits for it, and is answered after the
   * caller's. `gateway` opens a forwarded turn's generation first, inside the
   * same wait; its failure fails the delivery before anything is spawned. */
  private open(
    key: string,
    resume: string | undefined,
    seen: number,
    contextRoot?: string,
    gateway?: () => Promise<
      Readonly<{ session: string; forwarded: Forwarded }>
    >,
  ): Promise<Live | Settled> {
    let gate: Gateway | undefined;
    let refused = false;
    // The barrier, published before any await. It ends at once when nothing
    // starts, else once the process has exited and any generation closed.
    let end = () => {};
    if (gateway) {
      const barrier = new Promise<void>((resolve) => {
        end = () => {
          if (this.forwarding.get(key) === barrier) this.forwarding.delete(key);
          resolve();
        };
      });
      this.forwarding.set(key, barrier);
    }
    const finish = (exited: Promise<unknown> = Promise.resolve()) =>
      void exited
        .catch(() => undefined)
        .then(() => gate?.forwarded.generation.close())
        .catch(() => undefined)
        .then(end);
    const started = gateway
      ? gateway().then(
          ({ session, forwarded }) => {
            gate = { session, forwarded };
            return this.start(resume, key, undefined, gate);
          },
          (error: unknown) => {
            refused = true;
            end();
            throw error;
          },
        )
      : this.start(resume, key, undefined);
    const opened = started.then(
      (live): Live | Settled => {
        if (this.opening.get(key) === opened) this.opening.delete(key);
        if (gateway) {
          live.exclusive = true;
          finish(live.process.exited);
        }
        if (this.disposed) {
          void live.process.kill();
          return { ok: false, error: "Claude was stopped", undelivered: true };
        }
        this.adopt(key, live, seen, contextRoot);
        return live;
      },
      (error): Settled => {
        if (this.opening.get(key) === opened) this.opening.delete(key);
        if (refused)
          return { ok: false, error: message(error), undelivered: true };
        if (gateway) finish();
        console.warn("Claude could not start", error);
        return {
          ok: false,
          error: "Claude could not start",
          undelivered: true,
        };
      },
    );
    this.opening.set(key, opened);
    return opened;
  }
  /** `spawned` is told of a new session's process as soon as it exists,
   * before it is initialized. */
  private async start(
    resume: string | undefined,
    key?: string,
    spawned?: (process: ClaudeProcess) => void,
    gateway?: Gateway,
  ): Promise<Live> {
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint(key);
    const own = await this.options.launch(key);
    // On the session the generation was opened for.
    const launch = gateway
      ? {
          ...own,
          forward: gateway.forwarded.generation.url,
          sessionId: gateway.session,
        }
      : own;
    const process = resume
      ? await ClaudeProcess.start(this.spawn, { ...launch, resume })
      : await this.fresh(launch, spawned);
    if (fingerprint === this.options.fingerprint(key) || this.disposed) {
      if (!resume && process.sessionId)
        this.options.started?.(process.sessionId, launch.systemPrompt);
      return {
        process,
        fingerprint,
        used: this.now(),
        ...(gateway ? { forwarded: gateway.forwarded } : {}),
      };
    }
    // Settings saved while it started: it would work with the old ones. A
    // generation's next process waits for this one, which had its URL.
    void process.kill();
    if (gateway) await process.exited.catch(() => undefined);
    return this.start(resume, key, spawned, gateway);
  }
  /** A process for a new session: the spare when it fits, else a new one. */
  private async fresh(
    launch: Omit<ClaudeLaunch, "resume">,
    spawned?: (process: ClaudeProcess) => void,
  ) {
    // A spare's route was fixed when it spawned.
    const spare =
      !launch.protection &&
      !launch.forward &&
      (await this.options.spare?.take(launch));
    if (spare)
      try {
        if (this.disposed) throw new Error("Claude was stopped");
        void this.track(Promise.resolve(spare));
        spawned?.(spare);
        await spare.initialize(launch);
        return spare;
      } catch {
        void spare.kill();
      }
    const process = await ClaudeProcess.spawn(this.spawn, {
      ...launch,
      sessionId: launch.sessionId ?? this.newId(),
    });
    spawned?.(process);
    await process.initialize(launch);
    return process;
  }
  private adopt(key: string, live: Live, seen: number, contextRoot?: string) {
    live.process.conversation = key;
    live.process.onActivity = this.options.onChange;
    // Not a stop: a turn that reports finished work may be about to start.
    live.process.onQuiet = () => {
      if (this.live.get(key) === live) this.touch(key, live);
    };
    const generation = live.forwarded?.generation;
    // Only Claude's own idle report ends the turn's admission; then the
    // process stops, and the next turn resumes in a new one.
    live.process.onIdle = () => {
      live.idled?.();
      if (!live.exclusive) return;
      generation?.seal();
      this.drop(key, live);
    };
    if (generation) void generation.revoked.then(() => this.drop(key, live));
    this.live.set(key, live);
    this.touch(key, live, seen, contextRoot);
    this.options.onChange?.();
    void live.process.exited.then(() => {
      if (this.live.get(key) === live) this.drop(key, live);
    });
  }
  private async answer(
    key: string,
    live: Live,
    text: string,
    activity: TurnPick & ActivityReceipt,
  ) {
    const sent = live.process.send(text, activity);
    // Sending made it busy; a snapshot read when it started is not.
    this.options.onChange?.();
    const settled = await sent;
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (
        live.fingerprint !== this.options.fingerprint(key) &&
        !live.process.busy
      )
        this.drop(key, live);
    }
    return settled;
  }
  /** Saves the session as used now, when it takes in a message or ends a
   * turn, and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number, contextRoot?: string) {
    live.used = this.now();
    this.countdown(key, live);
    const id = live.process.sessionId;
    if (!id) return;
    const saved = this.options.store.get(key);
    const prior = saved?.id === id ? saved : undefined;
    let threads = prior?.threads;
    if (contextRoot && seen !== undefined) {
      const { [contextRoot]: previous = 0, ...rest } = threads ?? {};
      // Forgetting an old watermark only supplies that thread's context again.
      threads = Object.fromEntries(
        Object.entries({
          ...rest,
          [contextRoot]: Math.max(seen, previous),
        }).slice(-SAVED_LIMIT),
      );
    }
    const gateway = live.forwarded?.binding ?? prior?.gateway;
    this.options.store.set(key, {
      id,
      seen: Math.max(seen ?? 0, prior?.seen ?? 0),
      ...(threads ? { threads } : {}),
      ...(gateway ? { gateway } : {}),
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

type Gateway = Readonly<{ session: string; forwarded: Forwarded }>;

/** `work`, or a rejection with `signal`'s reason once it aborts. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
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
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Where a process runs and may work, its model and effort: all a spare is
 * started with. */
type Where = Pick<ClaudeLaunch, "cwd" | "directories" | "model" | "effort">;
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
    // A spare that ran a turn, such as one another Claude session's message
    // starts, fixed its system prompt then; Claude ignores the prompt
    // `initialize` brings it later, so the agent would run without it.
    if (process?.running && !process.started) return process;
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
