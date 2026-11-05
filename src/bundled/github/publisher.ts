// Publishing from this device: for each `buzz.github.hook` that names the
// viewer as its publisher, read the repository's pull requests with `gh` and
// keep the same `buzz.github.pull` cards, announcements and thread replies the
// relay keeps for a webhook (block/buzz `api/github_hooks.rs`), signed by the
// viewer. It runs only while this Buzz is open.
import { invoke, isTauri } from "@tauri-apps/api/core";
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
import type { GitHubCli } from "./gh";
import { HOOK_TYPE, parseHook, type Hook } from "./hooks";
import { PULL_TYPE } from "./relay-pull";

export const POLL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** How soon to try a new announcement's root again: the card can name it only
 * once the relay holds the message. */
const ROOT_RETRY_MS = 5_000;
export const ROOT_ATTEMPTS = 12;
/** One `#h` value short of the relay's 256 values per filter, leaving room
 * for `#type`. */
const MAX_CHANNELS = 255;
const TITLE_BYTES = 512;
const HISTORY_PAGE = 100;
const HISTORY_PAGES = 5;
const DEVICE_KEY = "buzz.github.publisher.device";
const PENDING_KEY = "buzz.github.publisher.pending";
const OWN_KEY = "buzz.github.publisher.own";

/** `buzz.github.pull` content v1, field for field as the relay writes it. */
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
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
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

function runsOf(node: Node) {
  const [commit] = nodes(node.commits);
  const rollup = (commit?.commit as Node | undefined)?.statusCheckRollup as
    | Node
    | null
    | undefined;
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

/** GitHub's own rule, as the relay keeps it: a reviewer's latest approval or
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
  const runs = runsOf(node);
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
      checks: { state: checksState(runs), runs },
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

/** Every pull request a repository answer holds, once each. */
export function readPulls(data: unknown, repo: string): Read[] {
  const repository = (data as { repository?: Node | null } | null | undefined)
    ?.repository;
  if (!repository) return [];
  const seen = new Set<string>();
  return [...nodes(repository.open), ...nodes(repository.done)].flatMap(
    (node) => {
      const read = readPull(node, repo);
      if (!read || seen.has(read.pull.url)) return [];
      seen.add(read.pull.url);
      return [read];
    },
  );
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

/** Whether `read` changes `prev`, the card as this publisher last wrote it,
 * and the thread replies the relay would post for that change. */
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

const bytesOf = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/** The card's `d`: a UUIDv8 of an HMAC under the hook's card key, which only
 * the publisher's identity can derive, so no one else can claim it first. */
export async function pullId(hookKey: string, channel: string, url: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytesOf(hookKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${channel}\0${url}`),
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

/** The card's tags, in the relay's order. `claim` marks an announcement this
 * device is about to post, until the card is rooted on it. */
export function cardTags(
  d: string,
  channel: string,
  hook: string,
  pull: Pull,
  op: Op,
  prev: string | undefined,
  root: string | undefined,
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
    ...(claim ? [["announcing", claim]] : []),
    ...(root ? [["root", root]] : []),
    ...(prev ? [["prev", prev]] : []),
  ];
}

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
  /** The hook's card key, hex. */
  hookKey(hook: string): Promise<string>;
}>;

/** One round's result for a hook: whether to come back soon, and what to
 * tell the person about it. */
export type Outcome = Readonly<{ again: boolean; problems: string[] }>;

/** The cards this identity publishes, kept as the relay keeps its own: from
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
  const hookKeys = new Map<string, Promise<string>>();
  let device = storage.getItem(DEVICE_KEY);
  if (!device) {
    device = crypto.randomUUID();
    storage.setItem(DEVICE_KEY, device);
  }
  const claim = device;

  const pendingKey = (key: string) =>
    `${PENDING_KEY}:${deps.scope}:${key.replace("\0", ":")}`;
  const pending = (key: string) => storage.getItem(pendingKey(key)) ?? "";
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

  const hookKey = (hook: string) => {
    let key = hookKeys.get(hook);
    if (!key) {
      key = deps.hookKey(hook);
      hookKeys.set(hook, key);
      key.catch(() => hookKeys.delete(hook));
    }
    return key;
  };

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
          claimed,
        ),
      },
      signal,
    );
    const delivery = await deliver(deps.writer, event, signal);
    if (delivery.status === "accepted") {
      written.set(key, event);
      storage.setItem(ownKey(key), JSON.stringify(event));
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
    const { target, d, key, read, signal } = step;
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
    if (pending(key)) storage.removeItem(pendingKey(key));
    const prev = parsePull(own);
    const { changed, replies } = changes(prev, read);
    if (changed || head.id !== own.id) {
      const result = await write(target, d, key, read.pull, head, root, signal);
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
    const { target, d, key, read, signal } = step;
    const posted = pending(key);
    if (posted) return rootOn(step, head, posted, retry);
    const holder = own && tag(own, "announcing");
    if (holder && holder !== claim)
      return `${label(step)}'s announcement is waiting on another device.`;
    let base = head;
    if (!holder) {
      const result = await write(
        target,
        d,
        key,
        read.pull,
        head,
        undefined,
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
    storage.setItem(pendingKey(key), id);
    return rootOn(step, base, id, true);
  }

  /** Roots the card on its posted announcement, which the relay accepts only
   * once it holds the message. */
  async function rootOn(
    step: Step,
    base: EventData | undefined,
    id: string,
    retry: boolean,
  ): Promise<Result> {
    const { target, d, key, read, signal } = step;
    let result: "accepted" | "conflict" | Error;
    try {
      result = await write(target, d, key, read.pull, base, id, signal);
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
  async function keep(
    target: Target,
    read: Read,
    d: string,
    head: EventData | undefined,
    signal: AbortSignal,
  ): Promise<Result> {
    const key = `${target.channel}\0${d}`;
    const problem = retired.get(key);
    if (problem) return problem;
    if (busy.has(key)) return undefined;
    busy.add(key);
    const step = { target, d, key, read, signal };
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
      reads: readonly Read[],
      signal: AbortSignal,
    ): Promise<Outcome> {
      const cardKey = await hookKey(target.hook.d);
      const ds = await Promise.all(
        reads.map((read) => pullId(cardKey, target.channel, read.pull.url)),
      );
      // Only this publisher can name these cards, so no one else's artifacts
      // can crowd this read the way they can a channel-wide sync.
      const heads = await headsOf([...new Set(ds)], signal);
      let again = false;
      const problems: string[] = [];
      for (const [index, read] of reads.entries()) {
        signal.throwIfAborted();
        const d = ds[index] ?? "";
        try {
          const result = await keep(target, read, d, heads.get(d), signal);
          if (result === "again") again = true;
          else if (result) problems.push(result);
        } catch (error) {
          if (signal.aborted) throw error;
          problems.push(`#${read.pull.number}: ${reason(error)}`);
        }
      }
      return { again, problems };
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
  let hookView: { key: string; view: View; stop(): void } | undefined;
  const polls = new Map<string, { target: Target; stop(): void }>();

  const open = (filter: object, listener: () => void) => {
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
    const report = (problem: string | undefined) =>
      status.set(target.channel, target.hook.d, problem);
    const tick = async () => {
      if (signal.aborted) return;
      let next: number;
      try {
        const [owner, name] = target.hook.repo.split("/");
        const data = await gh(QUERY, { owner, name }, signal);
        const outcome = await cards.round(
          target,
          readPulls(data, target.hook.repo),
          signal,
        );
        if (signal.aborted) return;
        report(outcome.problems.join(" ") || undefined);
        next = outcome.again ? ROOT_RETRY_MS : POLL_MS;
        delay = POLL_MS;
      } catch (error) {
        if (signal.aborted) return;
        report(`${target.hook.repo} couldn't be read: ${reason(error)}`);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        next = delay;
      }
      if (!signal.aborted) timer = setTimeout(() => void tick(), next);
    };
    timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped.abort();
      clearTimeout(timer);
      report(undefined);
    };
  }

  const hooksChanged = () => {
    const snapshot = hookView?.view.snapshot();
    // A loading or reconnecting view says nothing about which hooks are gone.
    if (snapshot?.status === "loading" || snapshot?.status === "stale") return;
    if (snapshot)
      status.setAll(
        snapshot.status === "live"
          ? undefined
          : stoppedBy(snapshot.status, snapshot.error),
      );
    const targets: Target[] = [];
    if (snapshot?.status === "live")
      for (const event of snapshot.events) {
        const hook = parseHook(event);
        const channel = tag(event, "h");
        if (hook && channel && hook.publisher === deps.viewer)
          targets.push({ channel, hook });
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
      .sort()
      .slice(0, MAX_CHANNELS);
    const key = ids.join(",");
    if (hookView && hookView.key === key) return;
    close(hookView);
    hookView = undefined;
    if (ids.length) {
      const held = open(
        {
          artifact: "current",
          kinds: [ARTIFACT_REVISION_KIND],
          "#h": ids,
          "#type": [HOOK_TYPE],
        },
        hooksChanged,
      );
      if (held) hookView = { key, ...held };
    }
    status.setAll(ids.length && !hookView ? stoppedBy("error") : undefined);
    hooksChanged();
  };

  const stopChannels = session.channels.subscribeList(channelsChanged);
  channelsChanged();
  return () => {
    lifetime.abort();
    stopChannels();
    for (const held of polls.values()) held.stop();
    polls.clear();
    close(hookView);
    status.setAll(undefined);
  };
}

const stoppedBy = (status: string, error?: string) =>
  status === "unsupported"
    ? "Publishing from this device needs a relay that keeps artifacts in sync."
    : `Publishing from this device stopped: the channels' hooks couldn't be read${error ? ` (${error})` : ""}.`;

/** The viewer's card key for one hook, from the identity the desktop app
 * holds; the browser has none, so it can't publish. */
export type CardKey = (community: string, hook: string) => Promise<string>;
export const nativeCardKey: CardKey | undefined = isTauri()
  ? (community, hook) =>
      invoke<string>("relay_github_card_key", { community, hook })
  : undefined;

/** Publishes from this device for whichever community is selected, where
 * this device has `gh` and an identity that can derive card keys. */
export function startPublisher(
  relay: RelayData,
  gh: GitHubCli | undefined,
  status: PublisherStatus,
  cardKey: CardKey | undefined = nativeCardKey,
  storage?: Deps["storage"],
): () => void {
  if (!gh || !cardKey) return () => {};
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
    const { origin, scope } = snapshot;
    if (!viewer || !writer || !read || !origin || !scope) return;
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
          hookKey: (hook) => cardKey(origin, hook),
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
