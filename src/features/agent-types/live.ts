// Runs in progress, shown only in the window that is running them. A run reports
// steps and streamed text here; nothing in this file reaches the relay. What other
// people see is whatever the run publishes as the agent.

export const STEP_KINDS = [
  "thinking",
  "message",
  "command",
  "read",
  "write",
  "search",
  "tool",
] as const;
/** Picks the row's icon and wording, both host-owned. */
export type StepKind = (typeof STEP_KINDS)[number];
export type StepResult = Readonly<{
  /** Marks the step failed and is shown on its row. */
  error?: string;
  /** For a `message` step: the id of the event the run published with this text.
   * The row then leaves the live view, because the real message is in the timeline. */
  published?: string;
}>;
export type LiveStep = Readonly<{
  /** Streamed text, for `thinking` and `message` steps. */
  append(text: string): void;
  /** Running to done, or to failed with `error`. Later calls are ignored. */
  finish(result?: StepResult): void;
}>;
/** A run's local view. Calls never throw and do nothing once the run has ended. */
export type AgentRunLive = Readonly<{
  /** Opens a running step. `label` adds specifics such as `pnpm test` or a path. */
  step(init: Readonly<{ kind: StepKind; label?: string }>): LiveStep;
}>;
/** The plain records a run's view is built from, in order. They are JSON so the
 * same stream could be sent somewhere other than this window later. */
export type RunEvent =
  | Readonly<{ t: "step"; id: number; kind: StepKind; label?: string }>
  | Readonly<{ t: "text"; id: number; text: string }>
  | Readonly<{ t: "end"; id: number; error?: string; published?: string }>;

export type LiveStepView = Readonly<{
  id: number;
  kind: StepKind;
  label?: string;
  text: string;
  state: "running" | "done" | "error";
  error?: string;
  published?: string;
}>;
export type LiveRunView = Readonly<{
  /** Unique among the runs this window has started. */
  id: number;
  agent: Readonly<{ id: string; pubkey: string; name: string }>;
  channelId: string;
  /** The delivered event. */
  eventId: string;
  /** The thread the delivered event belongs to, or that a reply to it starts: the
   * event's own id when it is not in a thread. */
  threadRootId: string;
  steps: readonly LiveStepView[];
}>;
export type LiveRuns = Readonly<{
  snapshot(): readonly LiveRunView[];
  subscribe(listener: () => void): () => void;
}>;

export const STEP_LIMIT = 512;
export const STEP_TEXT_LIMIT = 256 * 1024;
const LABEL_LIMIT = 512;
const none: readonly LiveRunView[] = Object.freeze([]);
const noSteps: readonly LiveStepView[] = Object.freeze([]);
const inert: LiveStep = Object.freeze({ append() {}, finish() {} });
/** The view for a delivery that has no channel to show it in. */
export const noLive: AgentRunLive = Object.freeze({ step: () => inert });

const short = (value: unknown, limit: number) =>
  typeof value === "string" && value ? value.slice(0, limit) : undefined;

/** Folds one record into a run's steps. Records that name no open step, or that
 * would pass a limit, change nothing. */
export function applyRunEvent(
  steps: readonly LiveStepView[],
  event: RunEvent,
): readonly LiveStepView[] {
  if (event.t === "step") {
    if (
      steps.length >= STEP_LIMIT ||
      !STEP_KINDS.includes(event.kind) ||
      steps.some((step) => step.id === event.id)
    )
      return steps;
    const label = short(event.label, LABEL_LIMIT);
    return Object.freeze([
      ...steps,
      Object.freeze({
        id: event.id,
        kind: event.kind,
        ...(label ? { label } : {}),
        text: "",
        state: "running" as const,
      }),
    ]);
  }
  const index = steps.findIndex((step) => step.id === event.id);
  const step = steps[index];
  if (step?.state !== "running") return steps;
  let next: LiveStepView;
  if (event.t === "text") {
    const text =
      typeof event.text === "string"
        ? event.text.slice(0, STEP_TEXT_LIMIT - step.text.length)
        : "";
    if (!text) return steps;
    next = { ...step, text: step.text + text };
  } else {
    const error = short(event.error, LABEL_LIMIT);
    const published = short(event.published, 64);
    next = {
      ...step,
      state: error ? "error" : "done",
      ...(error ? { error } : {}),
      ...(published ? { published } : {}),
    };
  }
  const copy = [...steps];
  copy[index] = Object.freeze(next);
  return Object.freeze(copy);
}

const frame = (flush: () => void) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
};

/** Holds the runs in progress in memory. `schedule` batches a burst of streamed
 * text into one notification; by default that is once per animation frame. */
export function createLiveRuns(schedule: (flush: () => void) => void = frame) {
  let runs = none;
  let nextRun = 1;
  let scheduled = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      for (const listener of listeners) listener();
    });
  };
  const change = (
    id: number,
    update: (run: LiveRunView) => LiveRunView | undefined,
  ) => {
    const next = runs.flatMap((run) => {
      if (run.id !== id) return [run];
      const updated = update(run);
      return updated ? [updated] : [];
    });
    if (next.length === runs.length && next.every((run, i) => run === runs[i]))
      return;
    runs = next.length ? Object.freeze(next) : none;
    notify();
  };
  return {
    snapshot: () => runs,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Starts a run's view. `close` removes it; the view is not kept afterwards. */
    open(place: Omit<LiveRunView, "id" | "steps">) {
      const id = nextRun++;
      let nextStep = 1;
      let open = true;
      runs = Object.freeze([
        ...runs,
        Object.freeze({ ...place, id, steps: noSteps }),
      ]);
      notify();
      const record = (event: RunEvent) => {
        if (!open) return;
        change(id, (run) => {
          const steps = applyRunEvent(run.steps, event);
          return steps === run.steps ? run : Object.freeze({ ...run, steps });
        });
      };
      const live: AgentRunLive = Object.freeze({
        step(init) {
          const step = nextStep++;
          record({
            t: "step",
            id: step,
            kind: init?.kind,
            ...(init?.label ? { label: init.label } : {}),
          });
          return Object.freeze({
            append: (text: string) => record({ t: "text", id: step, text }),
            finish: (result?: StepResult) =>
              record({
                t: "end",
                id: step,
                ...(result?.error ? { error: result.error } : {}),
                ...(result?.published ? { published: result.published } : {}),
              }),
          });
        },
      });
      return {
        live,
        close() {
          if (!open) return;
          open = false;
          change(id, () => undefined);
        },
      };
    },
  };
}
