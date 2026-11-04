// A pull request the relay follows: its `buzz.github.pull` artifact, written
// only by the relay from GitHub's webhooks, read as the store's own state.
import type { EventData } from "../../features/relay/events";
import { summarizeRollup, type RollupContext } from "./checks";
import { branchLink, type GitHubDetails } from "./data";
import { keyOf, type PullState } from "./pull-states";
import { parseGitHubReference } from "./references";

export const PULL_TYPE = "buzz.github.pull";
const ARTIFACT_KIND = 45010;

const STATES = ["open", "draft", "merged", "closed"] as const;
const CHECK_STATES = ["pending", "success", "failure", "neutral", "none"];
const VERDICTS = ["approved", "changes_requested", "commented", "dismissed"];
const FAILED = new Set([
  "failure",
  "error",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

export type Verdict =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed";

export type RelayPull = Readonly<{
  /** The canonical pull request URL. */
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PullState["state"];
  base?: string | undefined;
  head?: string | undefined;
  headSha?: string | undefined;
  updatedAt?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  changedFiles?: number | undefined;
  checks: Readonly<{
    state: "pending" | "success" | "failure" | "neutral" | "none";
    runs: Readonly<Record<string, string>>;
  }>;
  reviews: Readonly<Record<string, Verdict>>;
  requestedReviewers: readonly string[];
}>;

/** One trusted revision: the pull request, the channel that follows it and the
 * relay's announcement it is rooted on. */
export type PullRecord = Readonly<{
  id: string;
  channel: string;
  root?: string | undefined;
  createdAt: number;
  pull: RelayPull;
}>;

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];
const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

/** The record `event` holds, when the relay itself wrote it and its version 1
 * content is well formed; anything else is no one's pull request. */
export function parseRecord(
  event: EventData,
  relayAuthor: string | undefined,
): PullRecord | undefined {
  const channel = tag(event, "h");
  if (
    !relayAuthor ||
    event.pubkey !== relayAuthor ||
    event.kind !== ARTIFACT_KIND ||
    tag(event, "type") !== PULL_TYPE ||
    !channel
  )
    return undefined;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    body = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (body.version !== 1) return undefined;
  const reference = parseGitHubReference(text(body.url) ?? "");
  const number = count(body.number);
  const title = text(body.title);
  const author = text(body.author);
  const repo = text(body.repo);
  if (
    reference?.kind !== "pull" ||
    !number ||
    !title ||
    !author ||
    !repo ||
    !STATES.includes(body.state as (typeof STATES)[number])
  )
    return undefined;
  const marked = tag(event, "r");
  if (marked && keyOf(marked) !== keyOf(reference.url)) return undefined;
  const checks = body.checks as Record<string, unknown> | null | undefined;
  const runs = checks?.runs as Record<string, unknown> | null | undefined;
  const reviews = body.reviews as Record<string, unknown> | null | undefined;
  const requested = body.requested_reviewers;
  const root = tag(event, "root");
  return {
    id: event.id,
    channel,
    root: root && /^[0-9a-f]{64}$/.test(root) ? root : undefined,
    createdAt: event.created_at,
    pull: {
      url: reference.url,
      repo,
      number,
      title,
      author,
      state: body.state as RelayPull["state"],
      base: text(body.base),
      head: text(body.head),
      headSha: text(body.head_sha),
      updatedAt:
        text(body.updated_at) &&
        Number.isFinite(Date.parse(body.updated_at as string))
          ? (body.updated_at as string)
          : undefined,
      additions: count(body.additions),
      deletions: count(body.deletions),
      changedFiles: count(body.changed_files),
      checks: {
        state: CHECK_STATES.includes(checks?.state as string)
          ? (checks?.state as RelayPull["checks"]["state"])
          : "none",
        runs: Object.fromEntries(
          Object.entries(runs && typeof runs === "object" ? runs : {}).flatMap(
            ([name, conclusion]) =>
              typeof conclusion === "string" ? [[name, conclusion]] : [],
          ),
        ),
      },
      reviews: Object.fromEntries(
        Object.entries(
          reviews && typeof reviews === "object" ? reviews : {},
        ).filter(([, verdict]) => VERDICTS.includes(verdict as string)),
      ) as RelayPull["reviews"],
      requestedReviewers: Array.isArray(requested)
        ? requested.filter((name): name is string => typeof name === "string")
        : [],
    },
  };
}

/** The pull request URL the relay's announcement links, when it does. */
export function announcedUrl(content: string) {
  for (const word of content.split(/\s+/)) {
    const reference = parseGitHubReference(word);
    if (reference?.kind === "pull") return reference.url;
  }
  return undefined;
}

const finished = (conclusion: string) => conclusion !== "pending";

/** The pull request as the store models one read from GitHub; its panel
 * details only when `details`. */
export function pullStateOf(pull: RelayPull, details: boolean): PullState {
  const runs = Object.entries(pull.checks.runs);
  const contexts = runs.map(
    ([name, conclusion]): RollupContext => ({
      __typename: "CheckRun",
      name,
      status: finished(conclusion) ? "COMPLETED" : "IN_PROGRESS",
      conclusion: finished(conclusion)
        ? conclusion === "error"
          ? "failure"
          : conclusion
        : null,
    }),
  );
  return {
    state: pull.state,
    checks:
      pull.checks.state === "success" ||
      pull.checks.state === "failure" ||
      pull.checks.state === "pending"
        ? pull.checks.state
        : undefined,
    source: "relay",
    ...(pull.headSha && {
      head: pull.headSha,
      settled:
        runs.length > 0 &&
        pull.checks.state !== "pending" &&
        runs.every(([, conclusion]) => finished(conclusion)),
      failed: runs
        .filter(([, conclusion]) => FAILED.has(conclusion))
        .map(([name]) => name),
    }),
    ...(details && {
      details: {
        details: detailsOf(pull),
        signedIn: false,
        publicChecks: summarizeRollup(contexts, true),
      },
    }),
  };
}

function detailsOf(pull: RelayPull): GitHubDetails {
  const facts: GitHubDetails["facts"] = [];
  if (pull.head && pull.base)
    facts.push([
      "Branch",
      {
        head: branchLink(
          { label: pull.head, ref: pull.head, repo: { full_name: pull.repo } },
          pull.repo,
        ),
        base: branchLink(
          { label: pull.base, ref: pull.base, repo: { full_name: pull.repo } },
          pull.repo,
        ),
      },
    ]);
  if (pull.changedFiles !== undefined)
    facts.push(["Files changed", pull.changedFiles]);
  if (pull.additions !== undefined && pull.deletions !== undefined)
    facts.push([
      "Changes",
      { additions: pull.additions, deletions: pull.deletions },
    ]);
  return {
    title: pull.title,
    body: "",
    state:
      pull.state === "merged"
        ? "Merged"
        : pull.state === "draft"
          ? "Draft"
          : pull.state,
    author: pull.author,
    authorUrl: /^[a-z0-9-]+$/i.test(pull.author)
      ? `https://github.com/${encodeURIComponent(pull.author)}`
      : undefined,
    headSha: pull.headSha,
    updatedAt: pull.updatedAt,
    facts,
  };
}
