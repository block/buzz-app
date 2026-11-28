// Publishing from this device: for each `github.hook` that names the
// viewer as its publisher, read the repository's pull requests with `gh` and
// keep their `github.pull` cards, announcements and thread replies, signed by
// the viewer. It runs only while this Buzz is open.
import {
  ARTIFACT_KIND,
  deliver,
  type SnapshotRead,
} from "../../features/agents/agent-config-artifacts";
import { ARTIFACT_REVISION_KIND } from "../../features/relay/artifact-sync";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { RelayWriter } from "../../features/relay/transport";
import { GitHubError, type GitHubCli } from "./gh";
import { HOOK_TYPE, parseHook, type Hook } from "./hooks";
import { keyOf } from "./pull-states";
import { PULL_TYPE, announcementUrl } from "./relay-pull";
import { parseGitHubReference } from "./references";

export const POLL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** How widely each hook's first poll is spread, so clients that reconnect
 * together don't all read at once. */
export const START_SPREAD_MS = 30_000;
/** How soon to try a new announcement's root again: the card can name it only
 * once the relay holds the message. */
const ROOT_RETRY_MS = 5_000;
export const ROOT_ATTEMPTS = 12;
/** How long an announcement this device claimed but has no ID for may still
 * be on its way from the outbox, before it is posted again. */
export const ANNOUNCE_GRACE_S = 120;
/** How long another device's unrooted claim holds before this one takes it. */
export const ABANDONED_CLAIM_S = 600;
/** Pull requests with open cards that left the newest pull requests, read by
 * number each round, the longest unread first. */
export const RECONCILE = 50;
/** One `#h` value short of the relay's 256 values per filter, leaving room
 * for `#type`; more channels take more filters. */
export const MAX_CHANNELS = 255;
const TITLE_BYTES = 512;
const HISTORY_PAGE = 100;
const HISTORY_PAGES = 5;
/** `#d` values per head read, within the relay's 256 values per filter. */
const HEADS_PER_READ = 200;
/** Kind 9: a channel message. */
const MESSAGE_KIND = 9;
/** How far before its claim an announcement may say it was posted. */
const CLOCK_SKEW_S = 60;
/** How many of this identity's messages since a claim to look through. */
const ANNOUNCEMENTS = 50;
const DEVICE_KEY = "buzz.github.publisher.device";
const PENDING_KEY = "buzz.github.publisher.pending";
const OWN_KEY = "buzz.github.publisher.own";
const OPEN_KEY = "buzz.github.publisher.open";

/** `github.pull` content v1, field for field. */
export type Pull = {
  version: 1;
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: "open" | "draft" | "merged" | "closed";
  base: string;
  head: string;
  head_sha: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  checks: { state: string; runs: Record<string, string> };
  reviews: Record<string, string>;
  requested_reviewers: string[];
};

/** Who changed the pull request's state, when GitHub says. */
export type Actors = Readonly<{
  merged?: string | undefined;
  closed?: string | undefined;
  reopened?: string | undefined;
}>;

export type Read = Readonly<{ pull: Pull; actors: Actors }>;

/** What one round read from GitHub, and when that read started, in ms. */
export type Reads = Readonly<{ reads: readonly Read[]; readAt: number }>;

const FIELDS = `
fragment pull on PullRequest {
  url number title isDraft state updatedAt
  author { login }
  mergedBy { login }
  baseRefName headRefName headRefOid
  additions deletions changedFiles
  reviewRequests(first: 20) { nodes { requestedReviewer {
    __typename
    ... on User { login }
    ... on Bot { login }
    ... on Mannequin { login }
    ... on Team { slug }
  } } }
  latestOpinionatedReviews(first: 50) { nodes { state author { login } } }
  latestReviews(first: 50) { nodes { state author { login } } }
  timelineItems(last: 1, itemTypes: [CLOSED_EVENT, REOPENED_EVENT]) { nodes {
    __typename
    ... on ClosedEvent { actor { login } }
    ... on ReopenedEvent { actor { login } }
  } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }
}`;

export const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...pull } }
    done: pullRequests(states: [CLOSED, MERGED], first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...pull } }
  }
}
${FIELDS}`;

/** Reads pull requests `numbers` by number, as `p<number>`. */
export const numbersQuery = (numbers: readonly number[]) =>
  `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${numbers.map((number) => `    p${number}: pullRequest(number: ${number}) { ...pull }`).join("\n")}
  }
}
${FIELDS}`;

type Login = { login?: unknown } | null | undefined;
type Node = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
const login = (value: unknown) => text((value as Login)?.login);
const nodes = (value: unknown): Node[] => {
  const list = (value as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(list)
    ? list.filter((item): item is Node => !!item && typeof item === "object")
    : [];
};
const sorted = (entries: [string, string][]) =>
  Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The relay's rule for a head's checks as a whole. */
export function checksState(runs: Record<string, string>) {
  const results = Object.values(runs);
  if (!results.length) return "none";
  let pending = false;
  for (const result of results) {
    if (
      [
        "failure",
        "error",
        "cancelled",
        "timed_out",
        "action_required",
        "startup_failure",
      ].includes(result)
    )
      return "failure";
    if (!["success", "neutral", "skipped"].includes(result)) pending = true;
  }
  return pending ? "pending" : "success";
}

const rollupOf = (node: Node) =>
  (nodes(node.commits)[0]?.commit as Node | undefined)?.statusCheckRollup as
    | Node
    | null
    | undefined;

/** GitHub's state for every check on the head, not only those read. */
function rollupState(rollup: Node | null | undefined) {
  switch (rollup?.state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return undefined;
  }
}

function runsOf(rollup: Node | null | undefined) {
  const runs: [string, string][] = [];
  for (const context of nodes(rollup?.contexts)) {
    if (context.__typename === "CheckRun") {
      const name = text(context.name);
      if (!name) continue;
      runs.push([
        name,
        context.status === "COMPLETED"
          ? text(context.conclusion).toLowerCase() || "neutral"
          : "pending",
      ]);
    } else if (context.__typename === "StatusContext") {
      const name = text(context.context);
      if (!name) continue;
      const state = text(context.state).toLowerCase();
      runs.push([
        name,
        ["success", "failure", "error"].includes(state) ? state : "pending",
      ]);
    }
  }
  return sorted(runs);
}

/** GitHub's own rule: a reviewer's latest approval or
 * change request stands until they submit another or it is dismissed. */
function reviewsOf(node: Node) {
  const reviews = new Map<string, string>();
  for (const review of nodes(node.latestReviews)) {
    const name = login(review.author);
    const state = text(review.state).toLowerCase();
    if (name && ["commented", "dismissed"].includes(state))
      reviews.set(name, state);
  }
  for (const review of nodes(node.latestOpinionatedReviews)) {
    const name = login(review.author);
    const state = text(review.state).toLowerCase();
    if (name && ["approved", "changes_requested", "dismissed"].includes(state))
      reviews.set(name, state);
  }
  return sorted([...reviews]);
}

function requestedOf(node: Node) {
  const people: string[] = [];
  const teams: string[] = [];
  for (const request of nodes(node.reviewRequests)) {
    const reviewer = request.requestedReviewer as Node | null | undefined;
    if (!reviewer) continue;
    if (reviewer.__typename === "Team") {
      const slug = text(reviewer.slug);
      if (slug) teams.push(`team:${slug}`);
    } else {
      const name = text(reviewer.login);
      if (name) people.push(name);
    }
  }
  return [...people, ...teams];
}

/** One pull request GitHub's GraphQL answered, as the card holds it. */
export function readPull(node: Node, repo: string): Read | undefined {
  const url = text(node.url);
  const number = count(node.number);
  if (!url || !number) return undefined;
  const state =
    node.state === "MERGED"
      ? "merged"
      : node.state === "CLOSED"
        ? "closed"
        : node.isDraft === true
          ? "draft"
          : "open";
  const rollup = rollupOf(node);
  const runs = runsOf(rollup);
  const [event] = nodes(node.timelineItems);
  const actor = login(event?.actor);
  return {
    pull: {
      version: 1,
      url,
      repo,
      number,
      title: text(node.title),
      author: login(node.author),
      state,
      base: text(node.baseRefName),
      head: text(node.headRefName),
      head_sha: text(node.headRefOid),
      updated_at: text(node.updatedAt),
      additions: count(node.additions),
      deletions: count(node.deletions),
      changed_files: count(node.changedFiles),
      checks: { state: rollupState(rollup) ?? checksState(runs), runs },
      reviews: reviewsOf(node),
      requested_reviewers: requestedOf(node),
    },
    actors: {
      merged: login(node.mergedBy) || undefined,
      ...(event?.__typename === "ClosedEvent" && actor && { closed: actor }),
      ...(event?.__typename === "ReopenedEvent" &&
        actor && { reopened: actor }),
    },
  };
}

/** Every pull request a repository answer holds, once each: its newest,
 * then any read by number. */
export function readPulls(data: unknown, repo: string): Read[] {
  const repository = (data as { repository?: Node | null } | null | undefined)
    ?.repository;
  if (!repository) return [];
  const seen = new Set<string>();
  const numbered = Object.entries(repository).flatMap(([alias, node]) =>
    /^p\d+$/.test(alias) && node && typeof node === "object"
      ? [node as Node]
      : [],
  );
  return [
    ...nodes(repository.open),
    ...nodes(repository.done),
    ...numbered,
  ].flatMap((node) => {
    const read = readPull(node, repo);
    if (!read || seen.has(read.pull.url)) return [];
    seen.add(read.pull.url);
    return [read];
  });
}

/** A login or title in posted text, unable to resolve as a mention. */
const plain = (value: string) => value.replaceAll("@", "@⁠");

export const announcement = (pull: Pull) =>
  `#${pull.number} · ${plain(pull.title)}\n${pull.url}`;

function transitionReply(prev: string, next: string, actors: Actors) {
  const by = (actor: string | undefined) =>
    actor ? ` by ${plain(actor)}` : "";
  if (next === "merged" && prev !== "merged")
    return `Merged${by(actors.merged)}`;
  if (next === "closed" && prev !== "closed" && prev !== "merged")
    return `Closed${by(actors.closed)}`;
  if (prev === "closed" && (next === "open" || next === "draft"))
    return `Reopened${by(actors.reopened)}`;
  if (prev === "draft" && next === "open") return "Ready for review";
  return undefined;
}

function reviewReplies(prev: Pull, next: Pull) {
  return Object.entries(next.reviews).flatMap(([name, state]) =>
    prev.reviews[name] === state
      ? []
      : state === "approved"
        ? [`${plain(name)} approved`]
        : state === "changes_requested"
          ? [`${plain(name)} requested changes`]
          : [],
  );
}

export const serialize = (pull: Pull) => JSON.stringify(pull);

/** Whether a pull request may start a card: open, and changed since the hook
 * was made, so following a repository does not post its backlog. */
export function isFresh(pull: Pull, hookCreatedAt: number) {
  const updated = Date.parse(pull.updated_at) / 1000;
  return (
    (pull.state === "open" || pull.state === "draft") &&
    Number.isFinite(updated) &&
    updated > hookCreatedAt
  );
}

/** Whether `next`, read at `readAt`, is older than `prev`, the card as this
 * identity last wrote it from a read at `prevReadAt`: GitHub's update time
 * orders them, and when it is the same, as for checks, when each was read. */
export function isStale(
  prev: Pull,
  prevReadAt: number | undefined,
  next: Pull,
  readAt: number,
) {
  const before = Date.parse(prev.updated_at);
  const after = Date.parse(next.updated_at);
  if (Number.isFinite(before) && Number.isFinite(after) && before !== after)
    return after < before;
  return prevReadAt !== undefined && readAt < prevReadAt;
}

/** Whether `read` changes `prev`, the card as this publisher last wrote it,
 * and the thread replies to post for that change. */
export function changes(prev: Pull | undefined, read: Read) {
  const { pull, actors } = read;
  const changed = !prev || serialize(prev) !== serialize(pull);
  const transition = prev && transitionReply(prev.state, pull.state, actors);
  return {
    changed,
    replies:
      prev && changed
        ? [...(transition ? [transition] : []), ...reviewReplies(prev, pull)]
        : [],
  };
}

/** The card's `d`: a UUIDv8 of the hook, channel and pull request, so every
 * device of the publisher names the same card. Anyone who can write in the
 * channel could take it first, as they could delete the hook; the card is
 * then not kept, and says so. */
export async function pullId(hook: string, channel: string, url: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `buzz-github-pull-v1\0${hook}\0${channel}\0${url}`,
      ),
    ),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function truncate(value: string, bytes: number) {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= bytes) return value;
  let out = "";
  for (const char of value) {
    if (encoder.encode(out + char).length > bytes) break;
    out += char;
  }
  return out;
}

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

export type Op = "create" | "update" | "restore" | "move";

/** The card's tags. `readAt` is when its state was read from GitHub, and
 * `claim` marks an announcement this device is about to post, until the card
 * is rooted on it. */
export function cardTags(
  d: string,
  channel: string,
  hook: string,
  pull: Pull,
  op: Op,
  prev: string | undefined,
  root: string | undefined,
  readAt: number,
  claim?: string,
) {
  return [
    ["ar", "1"],
    ["d", d],
    ["h", channel],
    ["type", PULL_TYPE],
    ["title", truncate(`#${pull.number} · ${pull.title}`, TITLE_BYTES)],
    ["op", op],
    ["r", pull.url],
    ["repo", pull.repo],
    ["hook", hook],
    ["sha", pull.head_sha],
    ["state", pull.state],
    ["source", "github"],
    ["status", pull.state],
    ["read_at", String(readAt)],
    ...(claim ? [["announcing", claim]] : []),
    ...(root ? [["root", root]] : []),
    ...(prev ? [["prev", prev]] : []),
  ];
}

const readAtOf = (event: EventData) => {
  const value = Number(tag(event, "read_at"));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

function parsePull(event: EventData): Pull | undefined {
  try {
    const body: unknown = JSON.parse(event.content);
    return body && typeof body === "object" && (body as Pull).version === 1
      ? (body as Pull)
      : undefined;
  } catch {
    return undefined;
  }
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The relay refused to restore or move a card back, as it may for a
 * moderator's redaction or a channel this identity can no longer write. */
class Unrepairable extends Error {}

export type Target = Readonly<{ channel: string; hook: Hook }>;

export type Deps = Readonly<{
  viewer: string;
  /** The community, as local storage keys name it. */
  scope: string;
  writer: RelayWriter;
  read: SnapshotRead;
  messages: Pick<RelaySession["messages"], "send" | "reply">;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** In [0, 1): spreads first polls and retries across clients. */
  random?: () => number;
}>;

/** One round's result for a hook: whether to come back soon, what to tell
 * the person about it, which pull requests read already had cards, and which
 * cards now hold their read. */
export type Outcome = Readonly<{
  again: boolean;
  problems: string[];
  carded: ReadonlySet<string>;
  settled: ReadonlySet<string>;
}>;

/** The cards this identity publishes, each kept from
 * this publisher's latest revision of each, whatever anyone else wrote on top.
 * NIP-AR lets any channel writer update any artifact, so another writer's head
 * is only ever repaired, never believed. */
export function createCards(deps: Deps) {
  const { viewer, storage } = deps;
  /** This device's latest accepted revision of each card, until a read has it. */
  const written = new Map<string, EventData>();
  const retired = new Map<string, string>();
  const busy = new Set<string>();
  const rootTries = new Map<string, number>();
  /** Each announcement posted but not yet rooted on, held here as well, since
   * storage can refuse it while the outbox still delivers the message. */
  const posted = new Map<string, string>();
  /** Storage is a backup: a write it refuses is held only here. */
  const keep = (name: string, value: string) => {
    try {
      storage.setItem(name, value);
    } catch {
      // Held in memory; a restart recovers it from the channel.
    }
  };
  let device = storage.getItem(DEVICE_KEY);
  if (!device) {
    device = crypto.randomUUID();
    keep(DEVICE_KEY, device);
  }
  const claim = device;

  const pendingKey = (key: string) =>
    `${PENDING_KEY}:${deps.scope}:${key.replace("\0", ":")}`;
  const pending = (key: string) =>
    posted.get(key) ?? storage.getItem(pendingKey(key)) ?? "";
  const settle = (key: string) => {
    posted.delete(key);
    try {
      storage.removeItem(pendingKey(key));
    } catch {
      // Rooted: the card names the announcement now.
    }
  };
  /** This identity's latest accepted revision of each card, kept for when
   * enough revisions bury it past the history this reads. */
  const ownKey = (key: string) =>
    `${OWN_KEY}:${deps.scope}:${key.replace("\0", ":")}`;
  const stored = (key: string, d: string): EventData | undefined => {
    try {
      const event: unknown = JSON.parse(storage.getItem(ownKey(key)) ?? "");
      return event &&
        typeof event === "object" &&
        (event as EventData).pubkey === viewer &&
        Array.isArray((event as EventData).tags) &&
        tag(event as EventData, "d") === d
        ? (event as EventData)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const openKey = (target: Target) =>
    `${OPEN_KEY}:${deps.scope}:${target.channel}:${target.hook.d}`;

  /** The head a read found, or what this device last wrote when the read
   * holds an older revision of this identity's. Another writer's head is
   * always the head: its `created_at` is whatever that writer chose. */
  const latest = (key: string, head: EventData | undefined) => {
    const mine = written.get(key);
    if (!head || !mine || head.pubkey !== viewer || head.id === mine.id) {
      if (head && head.id === mine?.id) written.delete(key);
      return head;
    }
    return head.created_at > mine.created_at ? head : mine;
  };

  /** The heads of `ds` wherever they are, deletions included, from the
   * writer's view. */
  async function headsOf(ds: readonly string[], signal: AbortSignal) {
    const found = new Map<string, EventData>();
    if (!ds.length) return found;
    const events = await deps.read(
      [
        {
          kinds: [ARTIFACT_KIND],
          "#d": [...ds],
          artifact: "head",
          limit: ds.length,
        },
      ],
      { signal },
    );
    for (const event of events) {
      const d = tag(event, "d");
      if (d && ds.includes(d)) found.set(d, event);
    }
    return found;
  }
  const headOf = async (d: string, signal: AbortSignal) =>
    (await headsOf([d], signal)).get(d);

  /** This identity's latest revision of `d`, under whatever came after it. */
  async function ownOf(
    channel: string,
    d: string,
    key: string,
    signal: AbortSignal,
  ) {
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const events = await deps.read(
        [
          {
            kinds: [ARTIFACT_KIND],
            "#h": [channel],
            "#d": [d],
            artifact: "history",
            limit: HISTORY_PAGE,
            offset: page * HISTORY_PAGE,
          },
        ],
        { signal },
      );
      const own = events.find(
        (event) => event.pubkey === viewer && tag(event, "d") === d,
      );
      if (own) return own;
      if (events.length < HISTORY_PAGE) break;
    }
    return stored(key, d);
  }

  async function write(
    target: Target,
    d: string,
    key: string,
    pull: Pull,
    base: EventData | undefined,
    root: string | undefined,
    readAt: number,
    signal: AbortSignal,
    claimed?: string,
  ): Promise<"accepted" | "conflict"> {
    const op: Op = !base
      ? "create"
      : tag(base, "op") === "delete"
        ? "restore"
        : tag(base, "h") !== target.channel
          ? "move"
          : "update";
    const event = await deps.writer.sign(
      {
        kind: ARTIFACT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: serialize(pull),
        tags: cardTags(
          d,
          target.channel,
          target.hook.d,
          pull,
          op,
          base?.id,
          root,
          readAt,
          claimed,
        ),
      },
      signal,
    );
    const delivery = await deliver(deps.writer, event, signal);
    if (delivery.status === "accepted") {
      written.set(key, event);
      keep(ownKey(key), JSON.stringify(event));
      return "accepted";
    }
    if (delivery.status === "refused" && delivery.refusal === "conflict") {
      written.delete(key);
      return "conflict";
    }
    if (
      delivery.status === "refused" &&
      (delivery.refusal === "permission" || delivery.refusal === "invalid") &&
      (op === "restore" || op === "move")
    )
      throw new Unrepairable(delivery.message);
    throw new Error(delivery.message);
  }

  type Result = "again" | string | undefined;
  type Step = Readonly<{
    target: Target;
    d: string;
    key: string;
    read: Read;
    readAt: number;
    signal: AbortSignal;
  }>;
  const label = (step: Step) => `#${step.read.pull.number}`;
  const retire = (step: Step, problem: string) => {
    retired.set(step.key, problem);
    return problem;
  };

  /** `retry` is false after a conflict, which reads the head again. */
  async function update(
    step: Step,
    hint: EventData | undefined,
    retry: boolean,
  ): Promise<Result> {
    const { target, d, key, read, readAt, signal } = step;
    const head = retry ? hint : await headOf(d, signal);
    // A head this identity can't read was redacted or moved out of reach.
    if (!head) {
      if (pending(key) || stored(key, d))
        return retire(
          step,
          `${label(step)}'s card is gone from this channel, so it is no longer kept.`,
        );
      return isFresh(read.pull, target.hook.createdAt)
        ? announce(step, undefined, undefined, retry)
        : undefined;
    }
    const deleted = tag(head, "op") === "delete";
    if (deleted && tag(head, "h") !== target.channel)
      return retire(
        step,
        `${label(step)}'s card was moved and deleted, so it is no longer kept.`,
      );
    const own =
      head.pubkey === viewer && !deleted && tag(head, "h") === target.channel
        ? head
        : await ownOf(target.channel, d, key, signal);
    if (!own)
      return `${label(step)}'s card is in use by someone else, so it is not kept.`;
    const root = tag(own, "root");
    if (!root) return announce(step, head, own, retry);
    if (pending(key)) settle(key);
    const prev = parsePull(own);
    // A read older than this identity's card, as another of its devices
    // wrote it, changes nothing; that device already did.
    if (prev && isStale(prev, readAtOf(own), read.pull, readAt))
      return undefined;
    const { changed, replies } = changes(prev, read);
    if (changed || head.id !== own.id) {
      const result = await write(
        target,
        d,
        key,
        read.pull,
        head,
        root,
        readAt,
        signal,
      );
      if (result === "conflict")
        return retry ? update(step, undefined, false) : undefined;
    }
    for (const text of replies) {
      signal.throwIfAborted();
      deps.messages.reply(target.channel, root, text);
    }
    return undefined;
  }

  /** Posts the card's announcement once: a card revision claims it first, so
   * of any devices or polls racing, only the one whose claim lands posts, and
   * the posted message's ID outlives a restart until the card is rooted. */
  async function announce(
    step: Step,
    head: EventData | undefined,
    own: EventData | undefined,
    retry: boolean,
  ): Promise<Result> {
    const { target, d, key, read, readAt, signal } = step;
    const sent = pending(key);
    if (sent) return rootOn(step, head, sent, retry);
    const holder = own && tag(own, "announcing");
    if (holder && own && holder !== claim) {
      if (Date.now() / 1000 - own.created_at < ABANDONED_CLAIM_S)
        return `${label(step)}'s announcement is waiting on another device.`;
      const found = await announced(target.channel, read.pull, own, signal);
      if (found) {
        posted.set(key, found);
        return rootOn(step, head, found, retry);
      }
    }
    let base = head;
    if (holder && own && holder === claim) {
      // This device claimed it and lost the posted ID, or never posted.
      const found = await announced(target.channel, read.pull, own, signal);
      if (found) {
        posted.set(key, found);
        return rootOn(step, head, found, retry);
      }
      if (Date.now() / 1000 - own.created_at < ANNOUNCE_GRACE_S)
        return undefined;
    } else {
      const result = await write(
        target,
        d,
        key,
        read.pull,
        head,
        undefined,
        readAt,
        signal,
        claim,
      );
      if (result === "conflict") {
        if (!retry) return "again";
        if (head) return update(step, undefined, false);
        return (await headOf(d, signal))
          ? update(step, undefined, false)
          : retire(
              step,
              `${label(step)}'s card ID is taken by an artifact this channel doesn't hold, so it is not kept.`,
            );
      }
      base = written.get(key);
    }
    signal.throwIfAborted();
    const id = deps.messages.send(target.channel, announcement(read.pull));
    posted.set(key, id);
    keep(pendingKey(key), id);
    return rootOn(step, base, id, true);
  }

  /** The pull requests of `target`'s repository this identity announced in
   * its channel, by URL, from its newest messages there. */
  async function ownAnnouncements(target: Target, signal: AbortSignal) {
    const found = new Map<string, number>();
    let until: number | undefined;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const messages = await deps.read(
        [
          {
            kinds: [MESSAGE_KIND],
            "#h": [target.channel],
            authors: [viewer],
            limit: HISTORY_PAGE,
            ...(until === undefined ? {} : { until }),
          },
        ],
        { signal },
      );
      for (const message of messages) {
        if (message.pubkey !== viewer || tag(message, "h") !== target.channel)
          continue;
        const reference = parseGitHubReference(
          announcementUrl(message.content) ?? "",
        );
        const link = message.content.split("\n").at(-1)?.trim();
        if (
          reference?.repository.toLowerCase() !== target.hook.repo ||
          !link ||
          keyOf(link) !== keyOf(reference.url)
        )
          continue;
        const number = Number(reference.label.slice(1));
        if (Number.isInteger(number) && number > 0) found.set(link, number);
      }
      if (messages.length < HISTORY_PAGE) break;
      const oldest = Math.min(...messages.map((event) => event.created_at));
      if (until !== undefined && oldest >= until) break;
      until = oldest - 1;
    }
    return found;
  }

  /** This identity's announcement of `pull` in `channel` since `claimed`
   * claimed it, as the relay holds it. */
  async function announced(
    channel: string,
    pull: Pull,
    claimed: EventData,
    signal: AbortSignal,
  ) {
    const messages = await deps.read(
      [
        {
          kinds: [MESSAGE_KIND],
          "#h": [channel],
          authors: [viewer],
          since: claimed.created_at - CLOCK_SKEW_S,
          limit: ANNOUNCEMENTS,
        },
      ],
      { signal },
    );
    const url = keyOf(pull.url);
    return messages.find(
      (message) =>
        message.pubkey === viewer &&
        tag(message, "h") === channel &&
        !!url &&
        keyOf(announcementUrl(message.content) ?? "") === url,
    )?.id;
  }

  /** Roots the card on its posted announcement, which the relay accepts only
   * once it holds the message. */
  async function rootOn(
    step: Step,
    base: EventData | undefined,
    id: string,
    retry: boolean,
  ): Promise<Result> {
    const { target, d, key, read, readAt, signal } = step;
    let result: "accepted" | "conflict" | Error;
    try {
      result = await write(target, d, key, read.pull, base, id, readAt, signal);
    } catch (error) {
      if (signal.aborted || error instanceof Unrepairable) throw error;
      result = error instanceof Error ? error : new Error(String(error));
    }
    if (result === "accepted") {
      rootTries.delete(key);
      return undefined;
    }
    if (result === "conflict")
      return retry ? update(step, undefined, false) : "again";
    const tries = (rootTries.get(key) ?? 0) + 1;
    rootTries.set(key, tries);
    return tries < ROOT_ATTEMPTS
      ? "again"
      : `${label(step)}'s announcement hasn't reached the channel yet.`;
  }

  /** Keeps one pull request's card from its `head`, as a read just found
   * it. Each card is kept by one call at a time. */
  async function keepCard(
    target: Target,
    read: Read,
    readAt: number,
    d: string,
    head: EventData | undefined,
    signal: AbortSignal,
  ): Promise<Result> {
    const key = `${target.channel}\0${d}`;
    const problem = retired.get(key);
    if (problem) return problem;
    if (busy.has(key)) return "again";
    busy.add(key);
    const step = { target, d, key, read, readAt, signal };
    try {
      return await update(step, latest(key, head), true);
    } catch (error) {
      if (!(error instanceof Unrepairable) || signal.aborted) throw error;
      return retire(
        step,
        `${label(step)}'s card was deleted or moved, and the relay won't put it back (${error.message}), so it is no longer kept.`,
      );
    } finally {
      busy.delete(key);
    }
  }

  return {
    /** Keeps every card `reads` names for `target`; one pull request's
     * failure is only that pull request's. */
    async round(
      target: Target,
      { reads, readAt }: Reads,
      signal: AbortSignal,
    ): Promise<Outcome> {
      const ds = await Promise.all(
        reads.map((read) =>
          pullId(target.hook.d, target.channel, read.pull.url),
        ),
      );
      // Each card has its own `d`, so no one else's artifacts can crowd this
      // read the way they can a channel-wide sync.
      const heads = await headsOf([...new Set(ds)], signal);
      let again = false;
      const problems: string[] = [];
      const carded = new Set<string>();
      const settled = new Set<string>();
      for (const [index, read] of reads.entries()) {
        signal.throwIfAborted();
        const d = ds[index] ?? "";
        if (heads.has(d)) carded.add(read.pull.url);
        try {
          const result = await keepCard(
            target,
            read,
            readAt,
            d,
            heads.get(d),
            signal,
          );
          if (result === "again") again = true;
          else if (result) problems.push(result);
          else settled.add(read.pull.url);
        } catch (error) {
          if (signal.aborted) throw error;
          problems.push(`#${read.pull.number}: ${reason(error)}`);
        }
      }
      return { again, problems, carded, settled };
    },

    /** The open pull requests this identity keeps cards for under
     * `target`'s hook, by URL: those this device last knew of, and those the
     * relay holds, including cards whose head someone else wrote on top. */
    async openCards(target: Target, signal: AbortSignal) {
      const found = new Map<string, number>();
      try {
        const known: unknown = JSON.parse(
          storage.getItem(openKey(target)) ?? "[]",
        );
        if (Array.isArray(known))
          for (const entry of known)
            if (
              Array.isArray(entry) &&
              typeof entry[0] === "string" &&
              Number.isInteger(entry[1]) &&
              entry[1] > 0
            )
              found.set(entry[0], entry[1]);
      } catch {
        // Nothing kept; the relay's answer stands alone.
      }
      for (let page = 0; page < HISTORY_PAGES; page++) {
        const events = await deps.read(
          [
            {
              kinds: [ARTIFACT_KIND],
              "#h": [target.channel],
              "#type": [PULL_TYPE],
              "#hook": [target.hook.d],
              "#state": ["open", "draft"],
              artifact: "current",
              limit: HISTORY_PAGE,
              offset: page * HISTORY_PAGE,
            },
          ],
          { signal },
        );
        for (const event of events) {
          const pull = parsePull(event);
          if (
            !pull ||
            tag(event, "h") !== target.channel ||
            tag(event, "hook") !== target.hook.d ||
            tag(event, "op") === "delete" ||
            pull.repo !== target.hook.repo ||
            pull.number <= 0
          )
            continue;
          // Another writer's head is no word on the pull request's state,
          // only on which card it is, and only when the ID is this hook's.
          if (event.pubkey === viewer) {
            if (pull.state === "open" || pull.state === "draft")
              found.set(pull.url, pull.number);
          } else if (
            tag(event, "d") ===
            (await pullId(target.hook.d, target.channel, pull.url))
          )
            found.set(pull.url, pull.number);
        }
        if (events.length < HISTORY_PAGE) break;
      }
      // Its own announcements name every card it started, whoever wrote the
      // head since and whatever that head says, so a device that never saw a
      // card still finds it.
      const announced = await ownAnnouncements(target, signal);
      const urls = [...announced.keys()].filter((url) => !found.has(url));
      const ds = await Promise.all(
        urls.map((url) => pullId(target.hook.d, target.channel, url)),
      );
      for (let start = 0; start < ds.length; start += HEADS_PER_READ) {
        const heads = await headsOf(
          ds.slice(start, start + HEADS_PER_READ),
          signal,
        );
        for (const [index, d] of ds.entries()) {
          if (index < start || index >= start + HEADS_PER_READ) continue;
          const head = heads.get(d);
          const url = urls[index];
          const number = url && announced.get(url);
          if (!head || !url || !number) continue;
          const state = parsePull(head)?.state;
          if (
            head.pubkey === viewer &&
            tag(head, "op") !== "delete" &&
            state !== "open" &&
            state !== "draft"
          )
            continue;
          found.set(url, number);
        }
      }
      return found;
    },

    /** Keeps `open` for the next start, so a card someone else's head hides
     * from the relay's answer is still read. */
    rememberOpen(target: Target, open: ReadonlyMap<string, number>) {
      keep(
        openKey(target),
        JSON.stringify([...open].slice(-HISTORY_PAGE * HISTORY_PAGES)),
      );
    },
  };
}

/** What each hook this device publishes needs the person to know. */
export type PublisherStatus = Readonly<{
  /** The hook's problem, else one that stops every hook. */
  get(channel: string, hook: string): string | undefined;
  set(channel: string, hook: string, problem: string | undefined): void;
  setAll(problem: string | undefined): void;
  /** Changes whenever any hook's status does. */
  version(): number;
  subscribe(listener: () => void): () => void;
}>;

export function createPublisherStatus(): PublisherStatus {
  const problems = new Map<string, string>();
  const listeners = new Set<() => void>();
  let all: string | undefined;
  let version = 0;
  const changed = () => {
    version++;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (channel, hook) => problems.get(`${channel}\0${hook}`) ?? all,
    set(channel, hook, problem) {
      const key = `${channel}\0${hook}`;
      if (problems.get(key) === problem) return;
      if (problem) problems.set(key, problem);
      else problems.delete(key);
      changed();
    },
    setAll(problem) {
      if (all === problem) return;
      all = problem;
      changed();
    },
    version: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type View = ReturnType<RelaySession["artifacts"]["sync"]>;

/** One session's publishing: its hooks, their cards, and a poll per hook. */
function publish(
  session: RelaySession,
  gh: GitHubCli,
  deps: Deps,
  status: PublisherStatus,
) {
  const lifetime = new AbortController();
  const cards = createCards(deps);
  const random = deps.random ?? Math.random;
  /** One sync per `MAX_CHANNELS` channels, by their sorted IDs. */
  let hookViews = new Map<string, { view: View; stop(): void } | undefined>();
  const polls = new Map<string, { target: Target; stop(): void }>();

  const sync = (filter: object, listener: () => void) => {
    try {
      const view = session.artifacts.sync(filter);
      return { view, stop: view.subscribe(listener) };
    } catch {
      return undefined;
    }
  };
  const close = (held: { view: View; stop(): void } | undefined) => {
    held?.stop();
    held?.view.dispose();
  };

  function poll(target: Target) {
    const stopped = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, stopped.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    /** Pull requests with open cards, by URL, so one that leaves the newest
     * is still read until its card closes; undefined until the relay says. */
    let open: Map<string, number> | undefined;
    const report = (problem: string | undefined) =>
      status.set(target.channel, target.hook.d, problem);
    const tick = async () => {
      if (signal.aborted) return;
      let next: number;
      try {
        const [owner, name] = target.hook.repo.split("/");
        open ??= await cards.openCards(target, signal);
        const readAt = Date.now();
        const reads = readPulls(
          await gh(QUERY, { owner, name }, signal),
          target.hook.repo,
        );
        const seen = new Set(reads.map((read) => read.pull.url));
        const missing = [...open].filter(([url]) => !seen.has(url));
        const asked = missing.slice(0, RECONCILE);
        if (asked.length) {
          let answer: unknown;
          try {
            answer = await gh(
              numbersQuery(asked.map(([, number]) => number)),
              { owner, name },
              signal,
            );
          } catch (error) {
            // A pull request GitHub can't find fails only its own alias.
            if (!(error instanceof GitHubError) || error.data === undefined)
              throw error;
            answer = error.data;
          }
          const found = readPulls(answer, target.hook.repo);
          const got = new Set(found.map((read) => read.pull.url));
          // Asked for longest ago go last next time; one GitHub no longer
          // has is no one's to keep.
          for (const [url, number] of asked) {
            open.delete(url);
            if (got.has(url)) open.set(url, number);
          }
          reads.push(...found.filter((read) => !seen.has(read.pull.url)));
        }
        const outcome = await cards.round(target, { reads, readAt }, signal);
        if (signal.aborted) return;
        for (const { pull } of reads)
          if (pull.state === "merged" || pull.state === "closed") {
            if (outcome.settled.has(pull.url)) open.delete(pull.url);
          } else if (outcome.carded.has(pull.url) && !open.has(pull.url))
            open.set(pull.url, pull.number);
        cards.rememberOpen(target, open);
        report(outcome.problems.join(" ") || undefined);
        next = outcome.again ? ROOT_RETRY_MS : POLL_MS;
        delay = POLL_MS;
      } catch (error) {
        if (signal.aborted) return;
        report(`${target.hook.repo} couldn't be read: ${reason(error)}`);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        next = delay / 2 + (random() * delay) / 2;
      }
      if (!signal.aborted) timer = setTimeout(() => void tick(), next);
    };
    timer = setTimeout(() => void tick(), random() * START_SPREAD_MS);
    return () => {
      stopped.abort();
      clearTimeout(timer);
      report(undefined);
    };
  }

  const hooksChanged = () => {
    const snapshots = [...hookViews.values()].map((held) =>
      held?.view.snapshot(),
    );
    // A loading or reconnecting view says nothing about which hooks are gone.
    if (
      snapshots.some(
        (snapshot) =>
          snapshot?.status === "loading" || snapshot?.status === "stale",
      )
    )
      return;
    const failed = snapshots.findIndex(
      (snapshot) => snapshot?.status !== "live",
    );
    const failure = snapshots[failed];
    status.setAll(
      failed < 0
        ? undefined
        : stoppedBy(failure?.status ?? "error", failure?.error),
    );
    const targets: Target[] = [];
    for (const snapshot of snapshots) {
      if (snapshot?.status !== "live") continue;
      for (const event of snapshot.events) {
        const hook = parseHook(event);
        const channel = tag(event, "h");
        if (hook && channel && hook.publisher === deps.viewer)
          targets.push({ channel, hook });
      }
    }
    const keys = new Set<string>();
    for (const target of targets) {
      const key = `${target.channel}\0${target.hook.d}`;
      keys.add(key);
      const held = polls.get(key);
      if (held) {
        if (held.target.hook.head === target.hook.head) continue;
        held.stop();
      }
      polls.set(key, { target, stop: poll(target) });
    }
    for (const [key, held] of polls)
      if (!keys.has(key)) {
        held.stop();
        polls.delete(key);
      }
  };

  const channelsChanged = () => {
    const ids = session.channels
      .list()
      .channels.filter(
        (channel) =>
          (channel.channelType === "stream" ||
            channel.channelType === "forum") &&
          !channel.cached &&
          !channel.archived &&
          !!channel.members?.includes(deps.viewer),
      )
      .map((channel) => channel.id)
      .sort();
    const next = new Map<string, { view: View; stop(): void } | undefined>();
    for (let start = 0; start < ids.length; start += MAX_CHANNELS) {
      const chunk = ids.slice(start, start + MAX_CHANNELS);
      const key = chunk.join(",");
      next.set(
        key,
        hookViews.get(key) ??
          sync(
            {
              artifact: "current",
              kinds: [ARTIFACT_REVISION_KIND],
              "#h": chunk,
              "#type": [HOOK_TYPE],
            },
            hooksChanged,
          ),
      );
    }
    const unchanged =
      next.size === hookViews.size &&
      [...next.keys()].every((key) => hookViews.has(key));
    for (const [key, held] of hookViews) if (!next.has(key)) close(held);
    hookViews = next;
    if (!unchanged) hooksChanged();
  };

  const stopChannels = session.channels.subscribeList(channelsChanged);
  channelsChanged();
  return () => {
    lifetime.abort();
    stopChannels();
    for (const held of polls.values()) held.stop();
    polls.clear();
    for (const held of hookViews.values()) close(held);
    hookViews.clear();
    status.setAll(undefined);
  };
}

const stoppedBy = (status: string, error?: string) =>
  status === "unsupported"
    ? "Publishing from this device needs a relay that keeps artifacts in sync."
    : `Publishing from this device stopped: the channels' hooks couldn't be read${error ? ` (${error})` : ""}.`;

/** Publishes from this device for whichever community is selected, where
 * this device has `gh`. */
export function startPublisher(
  relay: RelayData,
  gh: GitHubCli | undefined,
  status: PublisherStatus,
  storage?: Deps["storage"],
  random: () => number = Math.random,
): () => void {
  if (!gh) return () => {};
  const kept = storage ?? localStorage;
  let active: { session: RelaySession; stop(): void } | undefined;
  const update = () => {
    const snapshot = relay.snapshot();
    const session = snapshot.status === "ready" ? snapshot.session : undefined;
    if (active?.session === session) return;
    active?.stop();
    active = undefined;
    if (snapshot.status !== "ready" || !session) return;
    const viewer = session.viewer;
    const writer = session.configArtifactWriter;
    const read = session.snapshotRead;
    const { scope } = snapshot;
    if (!viewer || !writer || !read || !scope) return;
    active = {
      session,
      stop: publish(
        session,
        gh,
        {
          viewer,
          scope,
          writer,
          read,
          messages: session.messages,
          storage: kept,
          random,
        },
        status,
      ),
    };
  };
  update();
  const stop = relay.subscribe(update);
  return () => {
    stop();
    active?.stop();
    active = undefined;
  };
}
