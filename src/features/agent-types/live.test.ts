import { expect, it } from "vitest";
import {
  applyRunEvent,
  createLiveRuns,
  noLive,
  STEP_LIMIT,
  STEP_TEXT_LIMIT,
  type LiveStepView,
} from "./live";

const place = {
  agent: { id: "bot-1", pubkey: "c".repeat(64), name: "Echo" },
  channelId: "c1",
  threadRootId: "9".repeat(64),
};

it("folds steps, streamed text and results in order", () => {
  let steps: readonly LiveStepView[] = [];
  for (const event of [
    { t: "step", id: 1, kind: "read", label: "src/a.ts" },
    { t: "step", id: 2, kind: "message" },
    { t: "text", id: 2, text: "Hel" },
    { t: "end", id: 1 },
    { t: "text", id: 2, text: "lo" },
    { t: "end", id: 2, published: "f".repeat(64) },
    { t: "step", id: 3, kind: "command" },
    { t: "end", id: 3, error: "exit 1" },
  ] as const)
    steps = applyRunEvent(steps, event);
  expect(steps).toEqual([
    { id: 1, kind: "read", label: "src/a.ts", text: "", state: "done" },
    {
      id: 2,
      kind: "message",
      text: "Hello",
      state: "done",
      published: "f".repeat(64),
    },
    { id: 3, kind: "command", text: "", state: "error", error: "exit 1" },
  ]);
});

it("ignores records for a finished or unknown step, and anything past a limit", () => {
  let steps = applyRunEvent([], { t: "step", id: 1, kind: "thinking" });
  steps = applyRunEvent(steps, { t: "end", id: 1 });
  for (const event of [
    { t: "text", id: 1, text: "late" },
    { t: "end", id: 1, error: "late" },
    { t: "text", id: 7, text: "unknown" },
    { t: "step", id: 1, kind: "read" },
    { t: "step", id: 2, kind: "dance" },
  ] as const)
    expect(applyRunEvent(steps, event as never)).toBe(steps);

  let long = applyRunEvent([], { t: "step", id: 1, kind: "message" });
  long = applyRunEvent(long, {
    t: "text",
    id: 1,
    text: "x".repeat(STEP_TEXT_LIMIT + 5),
  });
  expect(long[0]?.text.length).toBe(STEP_TEXT_LIMIT);
  expect(applyRunEvent(long, { t: "text", id: 1, text: "more" })).toBe(long);

  let many: readonly LiveStepView[] = [];
  for (let id = 1; id <= STEP_LIMIT + 3; id++)
    many = applyRunEvent(many, { t: "step", id, kind: "tool" });
  expect(many.length).toBe(STEP_LIMIT);
});

it("keeps a run only while it is open and batches a burst into one notification", () => {
  const flushes: (() => void)[] = [];
  const runs = createLiveRuns((flush) => flushes.push(flush));
  let notified = 0;
  runs.subscribe(() => notified++);
  const first = runs.open(place);
  const second = runs.open({ ...place, threadRootId: "8".repeat(64) });
  const reply = first.live.step({ kind: "message" });
  for (const word of ["a", "b", "c"]) reply.append(word);
  expect(flushes.length).toBe(1);
  flushes.shift()?.();
  expect(notified).toBe(1);
  const [one, two] = runs.snapshot();
  expect(one?.steps[0]?.text).toBe("abc");
  expect(two?.steps).toEqual([]);

  reply.finish();
  reply.finish({ error: "twice" });
  reply.append("late");
  // The other run's view is the same object, so its rows need not render again.
  expect(runs.snapshot()[1]).toBe(two);
  expect(runs.snapshot()[0]?.steps[0]).toMatchObject({
    text: "abc",
    state: "done",
  });

  first.close();
  first.close();
  expect(runs.snapshot()).toEqual([two]);
  // A step handle kept past the run does nothing, and neither does a new step.
  reply.append("gone");
  first.live.step({ kind: "tool" }).append("gone");
  second.close();
  expect(runs.snapshot()).toEqual([]);
});

it("accepts every call when there is nowhere to show the run", () => {
  const step = noLive.step({ kind: "command", label: "ls" });
  step.append("text");
  step.finish({ error: "failed" });
});
