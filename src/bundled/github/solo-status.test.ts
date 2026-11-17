import { expect, it } from "vitest";
import type { PullChecklist } from "./pull";
import { soloSignals } from "./solo-status";

import { approvedPull } from "./solo-pull.fixtures";

it("shows independent checks, approval, discussion and conservative readiness", () => {
  expect(soloSignals(approvedPull())).toEqual([
    { kind: "checks", label: "Checks passed", tone: "success" },
    { kind: "review", label: "Review approved", tone: "success" },
    {
      kind: "discussion",
      label: "No unresolved review threads",
      tone: "success",
    },
    { kind: "ready", label: "Ready to merge on GitHub", tone: "success" },
  ]);
});

it.each([
  [
    "draft",
    (pull: ReturnType<typeof approvedPull>) => ({
      ...pull,
      state: { ...pull.state, state: "draft" as const },
    }),
  ],
  [
    "failed read",
    (pull: ReturnType<typeof approvedPull>) => ({ ...pull, failed: true }),
  ],
  [
    "stale read",
    (pull: ReturnType<typeof approvedPull>) => ({ ...pull, stale: true }),
  ],
  [
    "public read",
    (pull: ReturnType<typeof approvedPull>) => ({
      ...pull,
      state: {
        ...pull.state,
        details: { ...pull.state.details, signedIn: false },
      },
    }),
  ],
  ["unknown", (pull: ReturnType<typeof approvedPull>) => ({ url: pull.url })],
] as const)("never shows %s as ready", (_name, change) => {
  expect(
    soloSignals(change(approvedPull())).find(
      (signal) => signal.kind === "ready",
    )?.tone,
  ).not.toBe("success");
});

it.each([
  {
    review: {
      decision: "REVIEW_REQUIRED",
      approved: [],
      changes: [],
      waiting: [],
      complete: true,
    },
  },
  {
    review: {
      decision: "CHANGES_REQUESTED",
      approved: [],
      changes: ["reviewer"],
      waiting: [],
      complete: true,
    },
  },
  {
    review: {
      decision: null,
      approved: [],
      changes: [],
      waiting: [],
      complete: true,
    },
  },
  {
    review: {
      decision: "APPROVED",
      approved: ["reviewer"],
      changes: [],
      waiting: ["other"],
      complete: true,
    },
  },
  {
    review: {
      decision: "APPROVED",
      approved: ["reviewer"],
      changes: [],
      waiting: [],
      complete: false,
    },
  },
  { merge: "BLOCKED" },
  { merge: "BEHIND" },
  { merge: "UNKNOWN" },
  { merge: "HAS_HOOKS" },
  { unresolved: 1 },
  { moreThreads: true },
  { queued: true },
  { head: "old-head" },
] satisfies Partial<PullChecklist>[])(
  "does not confuse passing checks with ready: %j",
  (delta) => {
    const pull = approvedPull();
    const state = {
      ...pull.state,
      details: {
        ...pull.state.details,
        checklist: { ...pull.state.details.checklist, ...delta },
      },
    };
    expect(
      soloSignals({ ...pull, state }).find((signal) => signal.kind === "ready")
        ?.tone,
    ).not.toBe("success");
  },
);

it.each(["pending", "failure", undefined] as const)(
  "requires settled passing checks, not %s",
  (checks) => {
    const pull = approvedPull();
    expect(
      soloSignals({ ...pull, state: { ...pull.state, checks } }).find(
        (signal) => signal.kind === "ready",
      )?.tone,
    ).not.toBe("success");
    expect(
      soloSignals({ ...pull, state: { ...pull.state, settled: false } }).find(
        (signal) => signal.kind === "ready",
      )?.tone,
    ).not.toBe("success");
  },
);

it("does not carry mutable merge signals past merged or closed", () => {
  for (const state of ["merged", "closed"] as const)
    expect(
      soloSignals({
        ...approvedPull(),
        state: { ...approvedPull().state, state },
      }),
    ).toEqual([]);
});

it("shows conflicts and unresolved discussion distinctly from changes requested", () => {
  const pull = approvedPull();
  const state = {
    ...pull.state,
    conflicts: true,
    details: {
      ...pull.state.details,
      checklist: {
        ...pull.state.details.checklist,
        unresolved: 2,
        merge: "DIRTY",
      },
    },
  };
  const signals = soloSignals({ ...pull, state });
  expect(signals).toContainEqual({
    kind: "conflicts",
    label: "Merge conflicts",
    tone: "failure",
  });
  expect(signals).toContainEqual({
    kind: "discussion",
    label: "2 unresolved review threads",
    tone: "pending",
  });
});

it("does not show ready when conflict evidence contradicts the checklist", () => {
  const pull = approvedPull();
  expect(
    soloSignals({ ...pull, state: { ...pull.state, conflicts: true } }).find(
      (signal) => signal.kind === "ready",
    )?.tone,
  ).not.toBe("success");
});

it("does not paint passing-but-incomplete checks green", () => {
  const pull = approvedPull();
  expect(
    soloSignals({ ...pull, state: { ...pull.state, settled: false } }).find(
      (signal) => signal.kind === "checks",
    ),
  ).toMatchObject({ tone: "pending", label: "Checks running" });
  expect(
    soloSignals({ ...pull, state: { ...pull.state, settled: false } }).at(-1)
      ?.tone,
  ).toBe("unknown");
});
