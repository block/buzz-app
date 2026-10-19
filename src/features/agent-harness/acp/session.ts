import type { HostMcpServer } from "../../host/service";
import type { AcpProcess } from "./process";
import { errorMessage, stepLabel } from "./steps";
import type { ActivityReceipt, Choice, Settled } from "./types";

/** The most of a turn's text kept, to post when it answers nowhere in Buzz. */
const WRITTEN_LIMIT = 20_000;

type Waiter = (settled: Settled) => void;

/** One conversation's ACP session. Messages sent while a turn runs are
 * steered into it, when the harness can steer; one that arrives as the turn
 * ends, or asks for another model, runs as the next turn. */
export class AcpSession {
  /** The conversation it serves. */
  conversation: string | undefined;
  /** The harness's id for the running turn, which a steer must name. */
  private runId: string | undefined;
  /** Steers waiting for the running turn's id, which the harness sends just
   * after the turn starts. */
  private runWaiters: ((runId: string | undefined) => void)[] = [];
  /** A `session/prompt` is in flight. */
  private prompting = false;
  private steering = 0;
  /** Turns to run, each with the model it was asked for, if any. */
  private readonly queue: { text: string; model?: string }[] = [];
  /** The model the running turn runs on; empty is its provider's default. */
  private model = "";
  /** Messages sent and not yet answered. */
  private pending = 0;
  private waiters: Waiter[] = [];
  /** The waiter that posts the burst's error or text: the latest message
   * acknowledged, else the latest sent. */
  private owner: Waiter | undefined;
  private readonly active = new Map<string, ActivityReceipt>();
  private lastStep = "";
  private lastError: string | undefined;
  /** Whether this work answered in Buzz, and what the harness wrote meanwhile: a
   * provider failure comes back as text, and text is never posted. */
  private acted = false;
  private written = "";
  private closed = false;

  constructor(
    private readonly acp: AcpProcess,
    readonly id: string,
    /** Serves this session's Buzz tools; closed with it. */
    readonly server?: HostMcpServer,
    private readonly choice?: () => Choice,
    /** The provider, model and thinking level it runs on, as chosen here. */
    public chosen: Choice = { provider: "", model: "" },
    /** Instructions that lead its first prompt, for a harness that takes no
     * system prompt. */
    private preamble = "",
  ) {}

  get busy() {
    return this.pending > 0;
  }
  get open() {
    return !this.closed;
  }
  /** The thinking level it was put on; empty while it runs on the harness's own. */
  get effort() {
    return this.chosen.effort ?? "";
  }

  /** Sends one user message, whose turn runs on `model` of the provider when
   * given. Resolves when it, and anything sent after it, has been answered,
   * or a final `send` ended the work. */
  send(
    text: string,
    activity: ActivityReceipt = {},
    model?: string,
  ): Promise<Settled> {
    if (this.closed)
      return Promise.resolve({ ok: false, error: "The session was closed" });
    this.pending++;
    let waiter!: Waiter;
    const settled = new Promise<Settled>((resolve) => {
      waiter = resolve;
      this.waiters.push(resolve);
    });
    // A steer cannot change the model, and must not pass a queued turn.
    if (
      this.prompting &&
      this.acp.hooks.steering &&
      !this.queue.length &&
      (!model || model === this.model)
    )
      void this.steer(text, activity, waiter, model);
    else {
      this.queue.push({ text, ...(model ? { model } : {}) });
      this.acknowledge(activity, waiter);
      void this.pump();
    }
    return settled;
  }

  /** A final `send` succeeded: the work counts as done at once, unless
   * another message is still waiting for its answer. The harness may still end
   * its turn with one more model call, whose text nobody posts. */
  finished() {
    if (this.pending === 1 && !this.queue.length && !this.steering)
      this.settle({ ok: true });
  }

  /** A Buzz tool that answers, such as `send`, succeeded. */
  answered() {
    this.acted = true;
  }

  /** Called by the process with each `session/update` for this session. */
  update(update: Record<string, unknown>) {
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" && !this.acted) {
      const content = update.content as { text?: unknown } | undefined;
      if (typeof content?.text === "string")
        this.written = (this.written + content.text).slice(0, WRITTEN_LIMIT);
    }
    // `undefined` from the hook means no run is active: keep it.
    const { steering } = this.acp.hooks;
    const runId = steering ? steering.runId(update) : null;
    if (runId !== null) {
      this.runId = runId;
      if (runId) this.ranAs(runId);
      return;
    }
    const step = stepLabel(update);
    if (!step) return;
    const label = `${step.tool}\u0000${step.target ?? ""}`;
    if (label === this.lastStep) return;
    this.lastStep = label;
    for (const receipt of this.active.values())
      receipt.step?.(step.tool, step.target);
  }

  /** Ends the session's work with `error`; nothing more is sent to it. */
  fail(error: string) {
    this.closed = true;
    this.queue.length = 0;
    this.settle({ ok: false, error });
  }

  private async steer(
    text: string,
    activity: ActivityReceipt,
    waiter: Waiter,
    model?: string,
  ) {
    this.steering++;
    try {
      const runId =
        this.runId ??
        (this.prompting
          ? await new Promise<string | undefined>((resolve) =>
              this.runWaiters.push(resolve),
            )
          : undefined);
      const { steering } = this.acp.hooks;
      if (runId && steering) {
        try {
          await steering.steer(this.acp, this.id, runId, text);
          this.acknowledge(activity, waiter);
          return;
        } catch {
          // The turn ended, or another took its place: run it as the next.
        }
      }
      this.queue.push({ text, ...(model ? { model } : {}) });
      this.acknowledge(activity, waiter);
    } finally {
      this.steering--;
      // Runs the next turn, or ends work whose turn ended during the steer.
      void this.pump();
    }
  }

  private async pump() {
    if (this.prompting) return;
    this.prompting = true;
    try {
      while (this.queue.length && !this.closed) {
        const { text, model } = this.queue.shift() ?? { text: "" };
        try {
          await this.select(model);
          const lead = this.preamble;
          const { stopReason } = (await this.acp.request("session/prompt", {
            sessionId: this.id,
            prompt: [
              { type: "text", text: lead ? `${lead}\n\n${text}` : text },
            ],
          })) as { stopReason?: string };
          // A rejected prompt never reached the model: the next one leads.
          this.preamble = "";
          if (stopReason === "refusal")
            this.lastError = `${this.acp.hooks.label} refused the request`;
        } catch (error) {
          this.lastError = errorMessage(error);
        }
      }
    } finally {
      this.prompting = false;
      this.runId = undefined;
      this.ranAs(undefined);
    }
    if (!this.steering && !this.closed) this.done();
  }

  /** Puts the session on the provider and model chosen now, or `model` of
   * that provider. A steer joins the running turn, so a change waits for the
   * next. */
  private async select(model?: string) {
    const chosen = this.choice?.();
    if (!chosen) return;
    const want = model ? { ...chosen, model } : chosen;
    this.model = want.model;
    await this.acp.hooks.select?.(this.acp, this, want);
  }

  private ranAs(runId: string | undefined) {
    for (const resolve of this.runWaiters.splice(0)) resolve(runId);
  }
  private acknowledge(activity: ActivityReceipt, waiter: Waiter) {
    if (this.waiters.includes(waiter)) this.owner = waiter;
    // Watches and timers have no message activity: they must not hide a mention.
    if (!activity.step) return;
    const scope = activity.activityScope ?? "conversation";
    this.active.get(scope)?.superseded?.();
    this.active.set(scope, activity);
    this.lastStep = "";
    activity.acknowledged?.();
  }
  private done() {
    // Work that wrote text and never answered in Buzz answered only the
    // harness: a model that forgot `send`, or one that cannot reach its provider.
    const text = this.acted ? "" : this.written.trim();
    const error = this.lastError;
    this.settle({
      ...(error ? { ok: false, error } : { ok: true }),
      ...(text ? { text } : {}),
    });
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.active.clear();
    this.lastError = undefined;
    this.acted = false;
    this.written = "";
    const owner = this.owner ?? this.waiters.at(-1);
    this.owner = undefined;
    for (const resolve of this.waiters.splice(0))
      resolve(resolve === owner ? settled : { ok: settled.ok });
  }
}
