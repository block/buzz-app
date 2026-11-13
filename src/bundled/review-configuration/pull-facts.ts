import { GhUnavailable, type GitHubCli } from "../github/gh";
import { repositoryName } from "./configuration";
import type { PullFacts } from "./routing";
export type ReadPull = (
  repository: string,
  pr: number,
  signal: AbortSignal,
) => Promise<PullFacts>;
const MAX_FILES = 3000;
const QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
 repository(owner:$owner,name:$name){pullRequest(number:$pr){
 title headRefOid baseRefOid changedFiles
 labels(first:100){nodes{name} pageInfo{hasNextPage}}
 files(first:100,after:$cursor){nodes{path} pageInfo{hasNextPage endCursor}}
 }}}`;
type Pull = {
  title: string;
  headRefOid: string;
  baseRefOid: string;
  changedFiles: number;
  labels: { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean } };
  files: {
    nodes: { path: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};
function checked(facts: PullFacts): PullFacts {
  if (
    typeof facts.title !== "string" ||
    facts.title.length > 2000 ||
    !/^[0-9a-f]{40,64}$/i.test(facts.head) ||
    !/^[0-9a-f]{40,64}$/i.test(facts.base) ||
    !Number.isSafeInteger(facts.changedFiles) ||
    facts.changedFiles < 0 ||
    facts.changedFiles > MAX_FILES ||
    !Array.isArray(facts.labels) ||
    facts.labels.some(
      (label) => typeof label !== "string" || label.length > 200,
    ) ||
    !Array.isArray(facts.paths) ||
    facts.paths.some(
      (path) => typeof path !== "string" || !path || path.length > 4096,
    )
  )
    throw new Error(
      "GitHub returned incomplete or unsupported PR data. Routing supports up to 3,000 changed files.",
    );
  return facts;
}
export function pullFingerprint(value: PullFacts) {
  return JSON.stringify([
    value.repository,
    value.pr,
    value.title,
    [...value.labels].sort(),
    value.changedFiles,
    value.head,
    value.base,
    [...value.paths].sort(),
  ]);
}
function assertComplete(facts: PullFacts) {
  checked(facts);
  if (
    new Set(facts.paths).size !== facts.changedFiles ||
    facts.paths.length !== facts.changedFiles
  )
    throw new Error(
      "GitHub did not return the complete changed-file list. No review requests were sent.",
    );
  return facts;
}
function stable(a: PullFacts, b: PullFacts) {
  if (
    pullFingerprint({ ...a, paths: [] }) !==
    pullFingerprint({ ...b, paths: [] })
  )
    throw new Error(
      "The PR changed while it was being read. Load it again before routing.",
    );
}
async function graphql(
  gh: GitHubCli,
  repository: string,
  pr: number,
  signal: AbortSignal,
) {
  const [owner, name] = repository.split("/");
  let cursor: string | null = null;
  let first: PullFacts | undefined;
  const paths: string[] = [];
  const cursors = new Set<string>();
  for (let page = 0; page < 30; page++) {
    signal.throwIfAborted();
    const result: { repository: { pullRequest: Pull | null } | null } =
      await gh(QUERY, { owner, name, pr, cursor }, signal);
    const pull = result.repository?.pullRequest;
    if (!pull)
      throw new Error("This PR is unavailable to your GitHub account.");
    if (pull.labels.pageInfo.hasNextPage)
      throw new Error(
        "This PR has more than 100 labels. Routing requires a complete label list.",
      );
    const facts = checked({
      repository,
      pr,
      title: pull.title,
      head: pull.headRefOid,
      base: pull.baseRefOid,
      changedFiles: pull.changedFiles,
      labels: pull.labels.nodes.map((item) => item.name),
      paths: pull.files.nodes.map((item) => item.path),
    });
    if (first) stable(first, facts);
    else first = facts;
    paths.push(...facts.paths);
    if (!pull.files.pageInfo.hasNextPage)
      return assertComplete({ ...first, paths });
    cursor = pull.files.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("GitHub returned an invalid file-page cursor.");
    cursors.add(cursor);
  }
  throw new Error("This PR exceeds the routing file limit.");
}
async function publicRead(repository: string, pr: number, signal: AbortSignal) {
  const endpoint = `https://api.github.com/repos/${repository}/pulls/${pr}`;
  const metadata = async (): Promise<PullFacts> => {
    const pull = await publicJson(endpoint, signal);
    return checked({
      repository,
      pr,
      title: pull.title,
      head: pull.head?.sha,
      base: pull.base?.sha,
      changedFiles: pull.changed_files,
      labels: pull.labels?.map((label: { name: string }) => label.name),
      paths: [],
    });
  };
  const first = await metadata();
  const paths: string[] = [];
  for (let page = 1; page <= Math.ceil(first.changedFiles / 100); page++) {
    const files = await publicJson(
      `${endpoint}/files?per_page=100&page=${page}`,
      signal,
    );
    if (!Array.isArray(files))
      throw new Error("GitHub returned an invalid file list.");
    paths.push(...files.map((file: { filename: string }) => file.filename));
  }
  stable(first, await metadata());
  return assertComplete({ ...first, paths });
}
export function createPullReader(gh?: GitHubCli): ReadPull {
  return async (input, pr, signal) => {
    const repository = repositoryName(input);
    if (!Number.isSafeInteger(pr) || pr < 1)
      throw new Error("Invalid PR number.");
    signal.throwIfAborted();
    if (gh) {
      try {
        return await graphql(gh, repository, pr, signal);
      } catch (error) {
        if (!(error instanceof GhUnavailable) || signal.aborted) throw error;
      }
    }
    return publicRead(repository, pr, signal);
  };
}

export async function publicJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This PR is private or unavailable. Use the desktop app with gh signed in for private PRs."
        : response.status === 403 || response.status === 429
          ? "GitHub's public API limit was reached. Try later or use the desktop app with gh signed in."
          : `GitHub could not load this PR (${response.status}).`,
    );
  return response.json();
}

export type PullStatus = "Open" | "Draft" | "Closed" | "Merged";
export type ReadPullStatus = (
  repository: string,
  pr: number,
  signal: AbortSignal,
) => Promise<PullStatus>;
const STATUS_QUERY = `query($owner:String!,$name:String!,$pr:Int!){
 repository(owner:$owner,name:$name){pullRequest(number:$pr){state isDraft}}
}`;
function status(state: unknown, draft: unknown): PullStatus {
  if (
    typeof state !== "string" ||
    !["OPEN", "CLOSED", "MERGED"].includes(state) ||
    typeof draft !== "boolean"
  )
    throw new Error("GitHub returned an unknown PR status.");
  return state === "MERGED"
    ? "Merged"
    : state === "CLOSED"
      ? "Closed"
      : draft
        ? "Draft"
        : "Open";
}

/** One metadata read, without fetching routing labels or changed files. */
export function createPullStatusReader(gh?: GitHubCli): ReadPullStatus {
  return async (input, pr, signal) => {
    const repository = repositoryName(input);
    if (!Number.isSafeInteger(pr) || pr < 1)
      throw new Error("Invalid PR number.");
    signal.throwIfAborted();
    if (gh) {
      try {
        const [owner, name] = repository.split("/");
        const result = await gh<{
          repository: {
            pullRequest: { state: string; isDraft: boolean } | null;
          } | null;
        }>(STATUS_QUERY, { owner, name, pr }, signal);
        const pull = result.repository?.pullRequest;
        if (!pull)
          throw new Error("This PR is unavailable to your GitHub account.");
        return status(pull.state, pull.isDraft);
      } catch (error) {
        if (!(error instanceof GhUnavailable) || signal.aborted) throw error;
      }
    }
    const pull = await publicJson(
      `https://api.github.com/repos/${repository}/pulls/${pr}`,
      signal,
    );
    if (
      typeof pull.merged !== "boolean" ||
      !["open", "closed"].includes(pull.state)
    )
      throw new Error("GitHub returned an unknown PR status.");
    return status(
      pull.merged ? "MERGED" : pull.state.toUpperCase(),
      pull.draft,
    );
  };
}
