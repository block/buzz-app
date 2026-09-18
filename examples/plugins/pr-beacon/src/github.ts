import type {
  CheckState,
  MergeStateStatus,
  OwnPullRequest,
  PullRequestDetail,
  PullRequestFile,
  PullRequestSummary,
  ReviewDecision,
  SearchResult,
} from "./types";

const API_ROOT = "https://api.github.com";
const MAX_PAGES = 5;
const PAGE_SIZE = 50;

export class GitHubError extends Error {}

function headers(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };
}

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_ROOT}/graphql`, {
    method: "POST",
    signal,
    credentials: "omit",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new GitHubError(
        "GitHub rejected this token. Check it in Settings.",
      );
    throw new GitHubError(
      `GitHub GraphQL request failed (${response.status}).`,
    );
  }
  const payload = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (payload.errors?.length)
    throw new GitHubError(
      payload.errors.map((error) => error.message).join("; "),
    );
  if (!payload.data) throw new GitHubError("GitHub returned no data.");
  return payload.data;
}

type SearchNode = {
  url: string;
  number: number;
  title: string;
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  updatedAt: string;
  repository: { nameWithOwner: string };
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  mergeStateStatus?: MergeStateStatus;
  commits?: {
    nodes: { commit: { statusCheckRollup: { state: CheckState } | null } }[];
  };
};

type SearchResponse = {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: SearchNode[];
  };
};

const SUMMARY_FIELDS = `
  url
  number
  title
  isDraft
  reviewDecision
  updatedAt
  repository { nameWithOwner }
  author { login }
  labels(first: 20) { nodes { name } }
`;

function toSummary(node: SearchNode): PullRequestSummary {
  return {
    url: node.url,
    number: node.number,
    repository: node.repository.nameWithOwner,
    title: node.title,
    author: node.author?.login ?? "",
    isDraft: node.isDraft,
    labels: node.labels.nodes.map((label) => label.name),
    updatedAt: node.updatedAt,
    reviewDecision: node.reviewDecision,
  };
}

async function paginatedSearch(
  token: string,
  query: string,
  fields: string,
  signal?: AbortSignal,
): Promise<{ nodes: SearchNode[]; truncated: boolean }> {
  const document = `
    query($queryString: String!, $after: String) {
      search(query: $queryString, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { ${fields} } }
      }
    }
  `;
  const nodes: SearchNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: SearchResponse = await graphql(
      token,
      document,
      { queryString: query, after },
      signal,
    );
    nodes.push(...data.search.nodes);
    if (!data.search.pageInfo.hasNextPage) return { nodes, truncated: false };
    after = data.search.pageInfo.endCursor;
  }
  return { nodes, truncated: true };
}

export async function fetchViewerLogin(
  token: string,
  signal?: AbortSignal,
): Promise<string> {
  const data = await graphql<{ viewer: { login: string } }>(
    token,
    "query { viewer { login } }",
    {},
    signal,
  );
  return data.viewer.login;
}

export async function fetchReviewRequests(
  token: string,
  signal?: AbortSignal,
): Promise<SearchResult<PullRequestSummary>> {
  const { nodes, truncated } = await paginatedSearch(
    token,
    "is:open is:pr archived:false review-requested:@me",
    SUMMARY_FIELDS,
    signal,
  );
  return { items: nodes.map(toSummary), truncated };
}

export async function fetchOwnPullRequests(
  token: string,
  signal?: AbortSignal,
): Promise<SearchResult<OwnPullRequest>> {
  const fields = `
    ${SUMMARY_FIELDS}
    mergeStateStatus
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  `;
  const { nodes, truncated } = await paginatedSearch(
    token,
    "is:open is:pr archived:false author:@me",
    fields,
    signal,
  );
  const items = nodes.map((node) => ({
    ...toSummary(node),
    mergeStateStatus: node.mergeStateStatus ?? null,
    checkState: node.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
  }));
  return { items, truncated };
}

export async function fetchPullRequestDetail(
  token: string,
  repository: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequestDetail> {
  const response = await fetch(
    `${API_ROOT}/repos/${repository}/pulls/${number}`,
    {
      signal,
      credentials: "omit",
      headers: headers(token),
    },
  );
  if (!response.ok)
    throw new GitHubError(
      `Could not load pull request details (${response.status}).`,
    );
  const data = await response.json();
  return {
    url: data.html_url,
    number: data.number,
    repository,
    title: data.title,
    body: data.body ?? "",
    author: data.user?.login ?? "",
    headSha: data.head.sha,
    baseSha: data.base.sha,
    baseRefName: data.base.ref,
    headRefName: data.head.ref,
  };
}

const COMPARE_FILE_CAP = 300;

// Pinned to the exact base/head commits, not "whatever the PR's diff looks
// like right now" — /pulls/{number}/files always reflects the PR's current
// state, so a push landing between the detail fetch and this one would show
// stale files/patches for a commit the Approve button doesn't match. Uses
// the base commit SHA, not the (mutable) base branch name — the base branch
// can itself move between the detail fetch and this one.
export async function fetchPullRequestFiles(
  token: string,
  repository: string,
  baseSha: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<SearchResult<PullRequestFile>> {
  const response = await fetch(
    `${API_ROOT}/repos/${repository}/compare/${baseSha}...${headSha}`,
    { signal, credentials: "omit", headers: headers(token) },
  );
  if (!response.ok)
    throw new GitHubError(`Could not load changed files (${response.status}).`);
  const data = await response.json();
  const files: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }[] = data.files ?? [];
  return {
    items: files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
    })),
    // GitHub's compare endpoint caps the files array without a follow-up
    // page; treat hitting that cap as an explicit "more files exist" signal
    // rather than presenting it as the complete diff.
    truncated: files.length >= COMPARE_FILE_CAP,
  };
}

// Fetches the pull request's current head SHA directly, independent of any
// cached detail, so callers can detect whether the diff went stale.
export async function fetchCurrentHeadSha(
  token: string,
  repository: string,
  number: number,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    `${API_ROOT}/repos/${repository}/pulls/${number}`,
    {
      signal,
      credentials: "omit",
      headers: headers(token),
    },
  );
  if (!response.ok)
    throw new GitHubError(
      `Could not check the pull request's current state (${response.status}).`,
    );
  const data = await response.json();
  return data.head.sha as string;
}

export type ApprovalOutcome = "approved" | "stale";

export class ApprovalAborted extends Error {}

// Refuses to approve a commit the reviewer didn't actually look at: refetches
// the head SHA first and aborts if it moved since the diff was viewed. Never
// retried automatically — the caller decides whether to refresh and retry.
// Rechecks the signal immediately before the mutating POST, not just at
// fetch call sites: the preflight GET may resolve after the caller stopped
// caring (e.g. the view unmounted) without the environment's fetch actually
// honoring the abort, and a real approval must never fire in that case.
export async function approvePullRequest(
  token: string,
  repository: string,
  number: number,
  reviewedHeadSha: string,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  const currentSha = await fetchCurrentHeadSha(
    token,
    repository,
    number,
    signal,
  );
  if (signal?.aborted) throw new ApprovalAborted("Approval cancelled.");
  if (currentSha !== reviewedHeadSha) return "stale";
  const response = await fetch(
    `${API_ROOT}/repos/${repository}/pulls/${number}/reviews`,
    {
      method: "POST",
      signal,
      credentials: "omit",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ commit_id: currentSha, event: "APPROVE" }),
    },
  );
  if (response.ok) return "approved";
  throw new GitHubError(
    `GitHub did not accept the approval (${response.status}).`,
  );
}

const REVIEW_PAGE_CAP = 5;

export type ApprovalCheck = {
  found: boolean;
  // true when the review list may hold more pages this call didn't reach:
  // found=false is then inconclusive, not a confirmed absence — callers must
  // not treat it as safe to retry the approval.
  truncated: boolean;
};

// Called when an approval POST's outcome is uncertain (network error,
// timeout) before letting the user retry, so a successful-but-unconfirmed
// approval is never submitted twice. Paginates through all reviews rather
// than trusting the first 100: a PR with more reviews than that could have
// the matching approval on a page a single request would miss, which would
// otherwise report a false "not approved" and green-light a duplicate.
export async function hasApprovalForSha(
  token: string,
  repository: string,
  number: number,
  login: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<ApprovalCheck> {
  for (let page = 1; page <= REVIEW_PAGE_CAP; page++) {
    const response = await fetch(
      `${API_ROOT}/repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`,
      { signal, credentials: "omit", headers: headers(token) },
    );
    if (!response.ok)
      throw new GitHubError(
        `Could not confirm the approval (${response.status}).`,
      );
    const reviews: {
      user?: { login: string };
      state: string;
      commit_id: string;
    }[] = await response.json();
    if (
      reviews.some(
        (review) =>
          review.user?.login === login &&
          review.state === "APPROVED" &&
          review.commit_id === headSha,
      )
    )
      return { found: true, truncated: false };
    if (reviews.length < 100) return { found: false, truncated: false };
  }
  return { found: false, truncated: true };
}
