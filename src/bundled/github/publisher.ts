// Publishing from this device: for each `buzz.github.hook` that names the
// viewer as its publisher, read the repository's pull requests with `gh` and
// keep the same `buzz.github.pull` cards, announcements and thread replies the
// relay keeps for a webhook (block/buzz `api/github_hooks.rs`), signed by the
// viewer. It runs only while this Buzz is open.
import {
  ARTIFACT_KIND,
  deliver,
  readHead,
} from "../../features/agents/agent-config-artifacts";
import { ARTIFACT_REVISION_KIND } from "../../features/relay/artifact-sync";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { GitHubCli } from "./gh";
import { HOOK_TYPE, parseHook, type Hook } from "./hooks";
import { PULL_TYPE } from "./relay-pull";

export const POLL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** How soon to try a new announcement's root again: the card can name it only
 * once the relay holds the message. */
const ROOT_RETRY_MS = 5_000;
const ROOT_ATTEMPTS = 12;
const MAX_CHANNELS = 256;
const TITLE_BYTES = 512;

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

/** What the card holds now, as this device sees it. */
export type Card = Readonly<{
  pull?: Pull | undefined;
  root?: string | undefined;
  /** The viewer wrote the head; anyone else's head is put back. */
  ours: boolean;
}>;

export type Step = Readonly<{
  /** The card's next content, when it must be written. */
  write?: Pull | undefined;
  /** Post the announcement and root the card on it. */
  announce: boolean;
  replies: readonly string[];
}>;

export const serialize = (pull: Pull) => JSON.stringify(pull);

/** What one pull request needs. A card starts only for an open pull request
 * that changed after the hook was made, so following a repository does not
 * post its backlog. */
export function plan(
  card: Card | undefined,
  read: Read,
  hookCreatedAt: number,
): Step {
  const { pull, actors } = read;
  if (!card) {
    const updated = Date.parse(pull.updated_at) / 1000;
    const fresh =
      (pull.state === "open" || pull.state === "draft") &&
      Number.isFinite(updated) &&
      updated > hookCreatedAt;
    return fresh
      ? { write: pull, announce: true, replies: [] }
      : { announce: false, replies: [] };
  }
  const prev = card.ours ? card.pull : undefined;
  const changed = !prev || serialize(prev) !== serialize(pull);
  const transition = prev && transitionReply(prev.state, pull.state, actors);
  return {
    ...((changed || !card.ours) && { write: pull }),
    announce: !card.root,
    replies:
      prev && changed && card.root
        ? [...(transition ? [transition] : []), ...reviewReplies(prev, pull)]
        : [],
  };
}

/** The card's `d`: one per pull request per hook per channel, the same on
 * every device. A UUIDv8 of the first 16 bytes of the SHA-256. */
export async function pullId(channel: string, hook: string, url: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `buzz-github-device-pull-v1\0${channel}\0${hook}\0${url}`,
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

/** The card's tags, in the relay's order. */
export function cardTags(
  d: string,
  channel: string,
  hook: string,
  pull: Pull,
  op: "create" | "update" | "restore",
  prev: string | undefined,
  root: string | undefined,
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
    ...(root ? [["root", root]] : []),
    ...(prev ? [["prev", prev]] : []),
  ];
}

function parsePull(content: string): Pull | undefined {
  try {
    const body: unknown = JSON.parse(content);
    return body && typeof body === "object" && (body as Pull).version === 1
      ? (body as Pull)
      : undefined;
  } catch {
    return undefined;
  }
}

class Conflict extends Error {}

type Target = Readonly<{ channel: string; hook: Hook }>;

/** One session's publishing: its hooks, their cards, and a poll per hook. */
function publish(session: RelaySession, gh: GitHubCli, viewer: string) {
  const lifetime = new AbortController();
  const writer = session.configArtifactWriter;
  const read = session.snapshotRead;
  type View = ReturnType<RelaySession["artifacts"]["sync"]>;
  let hookView: { key: string; view: View; stop(): void } | undefined;
  let cardView: { key: string; view: View; stop(): void } | undefined;
  const polls = new Map<string, { target: Target; stop(): void }>();
  const written = new Map<string, EventData>();
  const roots = new Map<string, { id: string; attempts: number }>();

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

  const heads = () => {
    const map = new Map<string, EventData>();
    for (const event of cardView?.view.snapshot().events ?? []) {
      const d = tag(event, "d");
      if (d) map.set(`${tag(event, "h")}\0${d}`, event);
    }
    return map;
  };

  async function sign(
    target: Target,
    d: string,
    pull: Pull,
    latest: EventData | undefined,
    root: string | undefined,
  ): Promise<EventData> {
    if (!writer) throw new Error("This community can't hold cards.");
    const op = !latest
      ? "create"
      : tag(latest, "op") === "delete"
        ? "restore"
        : "update";
    const event = await writer.sign(
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
          latest?.id,
          root ?? (latest && tag(latest, "root")),
        ),
      },
      lifetime.signal,
    );
    const delivery = await deliver(writer, event, lifetime.signal);
    if (delivery.status === "accepted") {
      written.set(`${target.channel}\0${d}`, event);
      return event;
    }
    if (delivery.status === "refused" && delivery.refusal === "conflict")
      throw new Conflict(delivery.message);
    throw new Error(delivery.message);
  }

  const cardOf = (head: EventData | undefined): Card | undefined =>
    head && {
      pull: tag(head, "op") === "delete" ? undefined : parsePull(head.content),
      root: tag(head, "root"),
      ours: head.pubkey === viewer,
    };

  /** The newer of what sync holds and what this device last wrote. */
  const current = (
    key: string,
    synced: EventData | undefined,
  ): EventData | undefined => {
    const mine = written.get(key);
    if (!mine || synced?.id === mine.id) return synced;
    return !synced || mine.created_at >= synced.created_at ? mine : synced;
  };

  async function once(target: Target) {
    const [owner, name] = target.hook.repo.split("/");
    const data = await gh(QUERY, { owner, name }, lifetime.signal);
    const synced = heads();
    let again = false;
    for (const pull of readPulls(data, target.hook.repo)) {
      lifetime.signal.throwIfAborted();
      const d = await pullId(target.channel, target.hook.d, pull.pull.url);
      const key = `${target.channel}\0${d}`;
      let head: EventData | undefined = current(key, synced.get(key));
      let step = plan(cardOf(head), pull, target.hook.createdAt);
      // Sync leaves out a deleted card, and may not have another device's
      // newest yet: only the head itself says whether to start one.
      if (!head && step.write && read) {
        head = await readHead(read, target.channel, d, lifetime.signal);
        if (head) step = plan(cardOf(head), pull, target.hook.createdAt);
      }
      let latest = head;
      try {
        if (step.write)
          latest = await sign(target, d, step.write, latest, undefined);
        if (step.announce && latest) {
          let pending = roots.get(key);
          if (!pending) {
            pending = {
              id: session.messages.send(
                target.channel,
                announcement(pull.pull),
              ),
              attempts: 0,
            };
            roots.set(key, pending);
          }
          try {
            await sign(target, d, pull.pull, latest, pending.id);
            roots.delete(key);
          } catch (error) {
            if (error instanceof Conflict) throw error;
            if (++pending.attempts >= ROOT_ATTEMPTS) roots.delete(key);
            again = true;
          }
        }
        const root = head && tag(head, "root");
        if (root)
          for (const reply of step.replies)
            session.messages.reply(target.channel, root, reply);
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    return again;
  }

  function poll(target: Target) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const status = cardView?.view.snapshot().status;
      let next = POLL_MS;
      if (status === "live" || status === "stale") {
        try {
          next = (await once(target)) ? ROOT_RETRY_MS : POLL_MS;
          delay = POLL_MS;
        } catch {
          if (stopped || lifetime.signal.aborted) return;
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
          next = delay;
        }
      } else next = ROOT_RETRY_MS;
      if (!stopped) timer = setTimeout(() => void tick(), next);
    };
    timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  const syncCards = (targets: Target[]) => {
    const channels = [...new Set(targets.map((t) => t.channel))].sort();
    const ds = [...new Set(targets.map((t) => t.hook.d))].sort();
    const key = `${channels.join(",")}|${ds.join(",")}`;
    if (cardView?.key === key) return;
    close(cardView);
    cardView = undefined;
    if (!targets.length) return;
    const held = open(
      {
        artifact: "current",
        kinds: [ARTIFACT_REVISION_KIND],
        "#h": channels,
        "#type": [PULL_TYPE],
        "#hook": ds,
      },
      () => {},
    );
    if (held) cardView = { key, ...held };
  };

  const hooksChanged = () => {
    const targets: Target[] = [];
    for (const event of hookView?.view.snapshot().events ?? []) {
      const hook = parseHook(event);
      const channel = tag(event, "h");
      if (hook && channel && hook.publisher === viewer)
        targets.push({ channel, hook });
    }
    syncCards(targets);
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
          !!channel.members?.includes(viewer),
      )
      .map((channel) => channel.id)
      .sort()
      .slice(0, MAX_CHANNELS);
    const key = ids.join(",");
    if (hookView?.key === key) return;
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
    close(cardView);
  };
}

/** Publishes from this device for whichever community is selected. */
export function startPublisher(
  relay: RelayData,
  gh: GitHubCli | undefined,
): () => void {
  if (!gh) return () => {};
  let active: { session: RelaySession; stop(): void } | undefined;
  const update = () => {
    const snapshot = relay.snapshot();
    const session = snapshot.status === "ready" ? snapshot.session : undefined;
    if (active?.session === session) return;
    active?.stop();
    active = undefined;
    const viewer = session?.viewer;
    if (session && viewer && session.configArtifactWriter)
      active = { session, stop: publish(session, gh, viewer) };
  };
  update();
  const stop = relay.subscribe(update);
  return () => {
    stop();
    active?.stop();
    active = undefined;
  };
}
