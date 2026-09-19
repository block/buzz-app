export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

export type CheckState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | null;

// GitHub's own computed "would this merge cleanly right now" status. CLEAN is
// the only value that supports a "ready to merge" label; everything else
// (including UNKNOWN, which GitHub reports while it's still computing) stays
// unresolved rather than being treated as ready.
export type MergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE"
  | null;

export type PullRequestSummary = {
  url: string;
  number: number;
  repository: string;
  title: string;
  author: string;
  isDraft: boolean;
  labels: string[];
  updatedAt: string;
  reviewDecision: ReviewDecision;
};

export type OwnPullRequest = PullRequestSummary & {
  mergeStateStatus: MergeStateStatus;
  checkState: CheckState;
};

export type OwnPullRequestStatus =
  | "draft"
  | "needs-response"
  | "ready-to-merge"
  | "failing-checks"
  | "awaiting-review"
  | "unknown";

export type SearchResult<Item> = {
  items: Item[];
  truncated: boolean;
};

export type PullRequestDetail = {
  url: string;
  number: number;
  repository: string;
  title: string;
  body: string;
  author: string;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  headRefName: string;
};

export type PullRequestFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
};
