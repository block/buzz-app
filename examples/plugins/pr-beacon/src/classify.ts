import type {
  OwnPullRequest,
  OwnPullRequestStatus,
  PullRequestSummary,
} from "./types";

export function isVIP(login: string, vipLogins: string[]): boolean {
  return vipLogins.some(
    (candidate) => candidate.toLowerCase() === login.toLowerCase(),
  );
}

export function matchesWatchedLabel(
  labels: string[],
  watchedLabels: string[],
): boolean {
  if (watchedLabels.length === 0) return false;
  const watched = new Set(watchedLabels.map((label) => label.toLowerCase()));
  return labels.some((label) => watched.has(label.toLowerCase()));
}

// A review request is "highlighted" (lights the icon) when it's from a VIP
// or carries a watched label; everything else is an ordinary request.
export function isHighlighted(
  pullRequest: PullRequestSummary,
  vipLogins: string[],
  watchedLabels: string[],
): boolean {
  return (
    isVIP(pullRequest.author, vipLogins) ||
    matchesWatchedLabel(pullRequest.labels, watchedLabels)
  );
}

// Partitions every open authored pull request into exactly one status, using
// only evidence GitHub's API actually reports. This does NOT reproduce PR
// Beacon's full parity (branch protection rules, merge queue position, and
// human-vs-bot review distinction aren't visible here) — "ready-to-merge"
// means "approved, checks passing, and GitHub's own mergeStateStatus is
// CLEAN", not a guarantee the merge button will succeed. Anything short of
// that evidence stays "unknown" rather than being guessed as ready.
export function classifyOwnPullRequest(
  pullRequest: OwnPullRequest,
): OwnPullRequestStatus {
  if (pullRequest.isDraft) return "draft";
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED")
    return "needs-response";
  if (pullRequest.reviewDecision === "APPROVED") {
    if (
      pullRequest.checkState === "FAILURE" ||
      pullRequest.checkState === "ERROR"
    )
      return "failing-checks";
    if (
      pullRequest.checkState === "SUCCESS" &&
      pullRequest.mergeStateStatus === "CLEAN"
    )
      return "ready-to-merge";
    return "unknown";
  }
  if (
    pullRequest.reviewDecision === "REVIEW_REQUIRED" ||
    pullRequest.reviewDecision === null
  )
    return "awaiting-review";
  return "unknown";
}
