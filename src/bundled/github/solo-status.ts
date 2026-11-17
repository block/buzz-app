import type { SoloPull } from "./solo-pull";

type Signal = Readonly<{
  kind: "checks" | "review" | "discussion" | "conflicts" | "ready";
  label: string;
  tone: "unknown" | "success" | "pending" | "failure";
}>;

/** GitHub's merge eligibility is display information, never merge authority. */
export function soloSignals(pull: SoloPull): readonly Signal[] {
  const state = pull.state;
  if (state?.state === "merged" || state?.state === "closed") return [];
  const trusted = !pull.failed && !pull.stale && state?.details?.signedIn;
  const checklist = trusted ? state.details?.checklist : undefined;
  const checks = trusted
    ? state.checks === "success" && state.settled !== true
      ? "pending"
      : state.checks
    : undefined;
  const review = checklist?.review;
  const reviewTone =
    review?.decision === "CHANGES_REQUESTED"
      ? "failure"
      : review?.decision === "APPROVED"
        ? "success"
        : review
          ? "pending"
          : "unknown";
  const ready =
    state?.state === "open" &&
    !!checklist &&
    checklist.head === state.head &&
    !state.conflicts &&
    checklist.merge === "CLEAN" &&
    !checklist.queued &&
    checks === "success" &&
    state.settled === true &&
    review?.decision === "APPROVED" &&
    review.complete === true &&
    !review.waiting.length &&
    !review.changes.length &&
    checklist.unresolved === 0 &&
    !checklist.moreThreads;
  return [
    {
      kind: "checks",
      label:
        checks === "success"
          ? "Checks passed"
          : checks === "failure"
            ? "Checks failing"
            : checks === "pending"
              ? "Checks running"
              : "Checks unknown",
      tone: checks ?? "unknown",
    },
    {
      kind: "review",
      label:
        reviewTone === "success"
          ? `Review approved${review?.waiting.length ? "; more review requested" : ""}`
          : reviewTone === "failure"
            ? "Changes requested"
            : review
              ? "Review pending"
              : "Review unknown",
      tone: reviewTone,
    },
    {
      kind: "discussion",
      label: !checklist
        ? "Discussion unknown"
        : checklist.unresolved
          ? `${checklist.unresolved} unresolved review thread${checklist.unresolved === 1 ? "" : "s"}${checklist.moreThreads ? "; more unread" : ""}`
          : checklist.moreThreads
            ? "Older review threads unread"
            : "No unresolved review threads",
      tone:
        !checklist || checklist.moreThreads
          ? "unknown"
          : checklist.unresolved
            ? "pending"
            : "success",
    },
    ...(trusted && state.conflicts
      ? [
          {
            kind: "conflicts",
            label: "Merge conflicts",
            tone: "failure",
          } as const,
        ]
      : []),
    {
      kind: "ready",
      label: ready
        ? checklist.queueRequired
          ? "Ready for GitHub merge queue"
          : "Ready to merge on GitHub"
        : pull.failed
          ? "GitHub read failed; readiness unknown"
          : pull.stale
            ? "GitHub state out of date; readiness unknown"
            : checklist?.queued
              ? "In GitHub merge queue"
              : checklist
                ? "Not ready to merge on GitHub"
                : "Merge readiness unknown",
      tone: ready ? "success" : "unknown",
    },
  ];
}
