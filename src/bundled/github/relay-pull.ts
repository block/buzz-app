// A pull request a channel follows: its `github.pull` artifact, written by
// the publisher its hook names.
import type { EventData } from "../../features/relay/events";
import type { Hook } from "./hooks";
import { keyOf, type PullState } from "./pull-states";
import { parseGitHubReference } from "./references";

export const PULL_TYPE = "github.pull";
const ARTIFACT_KIND = 45010;

const STATES = ["open", "draft", "merged", "closed"] as const;
const CHECK_STATES = ["pending", "success", "failure", "neutral", "none"];
const VERDICTS = ["approved", "changes_requested", "commented", "dismissed"];

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
 * announcement it is rooted on. */
export type PullRecord = Readonly<{
  id: string;
  channel: string;
  root?: string | undefined;
  /** The hook it was written for. */
  hook?: string | undefined;
  /** Who wrote it: the hook's publisher, once trusted. */
  publisher?: string | undefined;
  createdAt: number;
  pull: RelayPull;
}>;

/** The live hook `d` in `channel`, as the channel holds it. */
export type HookOf = (channel: string, d: string) => Hook | undefined;

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];
const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

/** The record `event` holds, when its version 1 content is well formed and
 * the publisher of the live hook it names wrote it, for that hook's
 * repository; anything else is no one's pull request. */
export function parseRecord(
  event: EventData,
  hookOf: HookOf,
): PullRecord | undefined {
  const card = parseCard(event);
  return card && trust(card, event.pubkey, hookOf);
}

/** `card` as `author` vouches for it, or undefined unless `author` publishes
 * the live hook it names. */
export function trust(
  card: PullRecord,
  author: string,
  hookOf: HookOf,
): PullRecord | undefined {
  const hook = card.hook ? hookOf(card.channel, card.hook) : undefined;
  const repository = parseGitHubReference(card.pull.url)?.repository;
  if (
    !hook ||
    hook.publisher !== author ||
    card.pull.repo.toLowerCase() !== hook.repo ||
    repository?.toLowerCase() !== hook.repo
  )
    return undefined;
  return { ...card, publisher: author };
}

/** The well formed version 1 pull request `event` holds, whoever wrote it. */
export function parseCard(event: EventData): PullRecord | undefined {
  const channel = tag(event, "h");
  if (
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
    hook: tag(event, "hook"),
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

const ANNOUNCEMENT = /^#([1-9]\d*) · [^\n]*\n(\S+)$/;

/** The pull request URL on the last line of an announcement, which is
 * exactly "#123 · title" and then that URL, as publishers post one; a URL
 * anywhere else, as in a title, names nothing. */
export function announcementUrl(content: string) {
  const [, number, link] = ANNOUNCEMENT.exec(content) ?? [];
  const reference = link ? parseGitHubReference(link) : undefined;
  return reference?.kind === "pull" && reference.label === `#${number}`
    ? reference.url
    : undefined;
}

export const isAnnouncement = (content: string) => !!announcementUrl(content);
