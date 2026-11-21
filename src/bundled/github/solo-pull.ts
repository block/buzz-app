// A Solo chat's pull requests: one link artifact per chat, kept as a NIP-AR
// artifact in the chat so every device and agent in it sees the same ones,
// with their states from the app's shared pull request states while shown.
import {
  ARTIFACT_KIND,
  uuidv5,
} from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { PublishRejected } from "../../features/relay/outbox";
import { refusal } from "../../features/agents/agent-config-artifacts";
import type { PullState, PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";

export const SOLO_PULL_TYPE = "buzz.solo.pr";
/** How soon shown chats whose links could not be read try again. */
export const SOLO_REFRESH_MS = 60_000;
/** Links change rarely and only by hand, so shown chats read them again when
 * the window comes back, at most this often. */
const LINKS_AGAIN_MS = 5 * 60_000;
/** Chats per link read. Each has one link artifact, so a read of 500, the
 * session reader's cap, leaves room for concurrent revisions. */
const CHANNELS_PER_READ = 100;
const LINKS_PER_READ = 500;
/** Current revisions a write reads, so it sees a forked head the chat shows. */
const HEADS_PER_WRITE = 20;

/** One of a chat's linked pull requests, and its state once read. */
export type SoloPull = Readonly<{
  url: string;
  state?: PullState | undefined;
  /** It could not be read. */
  failed?: boolean | undefined;
}>;

const tag = (event: EventData, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];

const pullUrl = (url: unknown) => {
  const reference =
    typeof url === "string" ? parseGitHubReference(url) : undefined;
  return reference?.kind === "pull" ? reference.url : undefined;
};

/** The pull requests a current revision links, in the order linked: none once
 * unlinked, or undefined when it is not a Solo pull request link. Version 1
 * holds one `url`; version 2 keeps `url` as its first for older readers. */
export function linksOf(event: EventData): readonly string[] | undefined {
  if (event.kind !== ARTIFACT_KIND || tag(event, "type") !== SOLO_PULL_TYPE)
    return undefined;
  try {
    const { url, urls } = JSON.parse(event.content) as {
      url?: unknown;
      urls?: unknown;
    };
    if (Array.isArray(urls))
      return [
        ...new Set(urls.map(pullUrl).filter((item): item is string => !!item)),
      ];
    if (url === null) return [];
    const one = pullUrl(url);
    return one ? [one] : undefined;
  } catch {
    return undefined;
  }
}

/** Each chat's link artifact `d`, worked out once. */
const linkIds = new Map<string, Promise<string>>();
const linkId = (channel: string) => {
  let id = linkIds.get(channel);
  if (!id) {
    id = uuidv5(channel, SOLO_PULL_TYPE);
    linkIds.set(channel, id);
  }
  return id;
};

/** The head a chat shows, from its current revisions: where heads fork, the
 * first that links any pull request, else the first link revision. Reads and
 * writes both start from it, so a change applies to what is shown. */
function shownHead(heads: readonly EventData[]) {
  return (
    heads.find((head) => linksOf(head)?.length) ??
    heads.find((head) => linksOf(head))
  );
}

async function readLinks(
  session: RelaySession,
  channels: readonly string[],
  signal: AbortSignal,
) {
  const read = session.snapshotRead;
  const links = new Map<string, readonly string[]>();
  if (!read) return links;
  for (let at = 0; at < channels.length; at += CHANNELS_PER_READ) {
    const page = channels.slice(at, at + CHANNELS_PER_READ);
    // Only the chats' link artifacts, not their other artifacts.
    const ids = await Promise.all(page.map(linkId));
    const events = await read(
      [
        {
          kinds: [ARTIFACT_KIND],
          "#h": page,
          "#d": ids,
          artifact: "current",
          limit: LINKS_PER_READ,
        },
      ],
      { signal },
    );
    for (const channel of page) {
      const head = shownHead(
        events.filter((event) => tag(event, "h") === channel),
      );
      links.set(channel, (head && linksOf(head)) ?? []);
    }
  }
  return links;
}

/** Each chat's link change in progress, so this app's changes apply in turn. */
const writing = new Map<string, Promise<unknown>>();

/** Changes the Solo chat `channel`'s linked pull requests, as the signed-in
 * person: `change` gets the ones its current revision links, so changes from
 * other devices are kept. This app's changes to one chat apply one after
 * another; a revision another device saved first is read again once. Answers
 * the ones now linked. */
export function writeLinks(
  session: RelaySession,
  channel: string,
  change: (current: readonly string[]) => readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  // The time limit starts when this change's turn comes, not while it waits.
  const write = () => {
    const bounded = signal ?? AbortSignal.timeout(20_000);
    return writeOnce(session, channel, change, bounded).catch(
      (error: unknown) => {
        if (conflicted(error))
          return writeOnce(session, channel, change, bounded);
        throw error;
      },
    );
  };
  const done = (writing.get(channel) ?? Promise.resolve()).then(write, write);
  const settled = done.catch(() => {});
  writing.set(channel, settled);
  void settled.then(() => {
    if (writing.get(channel) === settled) writing.delete(channel);
  });
  return done;
}

/** Whether the relay refused a revision because another saved first. */
const conflicted = (error: unknown) =>
  error instanceof Error &&
  refusal(
    (error instanceof PublishRejected ? error.reason : undefined) ??
      error.message,
  ) === "conflict";

async function writeOnce(
  session: RelaySession,
  channel: string,
  change: (current: readonly string[]) => readonly string[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const read = session.snapshotRead;
  const writer = session.configArtifactWriter;
  if (!read || !writer)
    throw new Error("This community connection can't save pull request links.");
  const d = await linkId(channel);
  const head = shownHead(
    await read(
      [
        {
          kinds: [ARTIFACT_KIND],
          "#h": [channel],
          "#d": [d],
          artifact: "current",
          limit: HEADS_PER_WRITE,
        },
      ],
      { signal },
    ),
  );
  const current = (head && linksOf(head)) ?? [];
  const urls = [...new Set(change(current))];
  if (
    head &&
    urls.length === current.length &&
    urls.every((url, at) => url === current[at])
  )
    return urls;
  if (!head && !urls.length) return urls;
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ version: 2, url: urls[0] ?? null, urls }),
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", SOLO_PULL_TYPE],
        ["title", "Pull request"],
        ["op", head ? "update" : "create"],
        ...(head ? [["prev", head.id]] : []),
      ],
    },
    signal,
  );
  await writer.publish(event, signal);
  return urls;
}

/** Adds `url` to the chat's linked pull requests. */
export const linkPull = (url: string) => (current: readonly string[]) => [
  ...current,
  url,
];
/** Removes `url`, or every pull request without one. */
export const unlinkPull = (url?: string) => (current: readonly string[]) =>
  url === undefined ? [] : current.filter((item) => item !== url);

export type SoloPulls = Readonly<{
  /** Keeps `channel`'s links and pull requests current while subscribed. */
  watch(channel: string, listener: () => void): () => void;
  /** Its linked pull requests in the order linked; undefined when none. */
  get(channel: string): readonly SoloPull[] | undefined;
  /** Shows links this device just wrote, without reading them back. */
  linked(channel: string, urls: readonly string[]): void;
}>;

/** One session's Solo pull requests, with their states from `states`.
 *
 * Links are read once per shown chat, batched for rows that appear together,
 * and again when the window comes back after a while; never on a timer. A
 * shown chat's linked pull request is watched in `states` while shown. */
export function createSoloPulls(
  session: RelaySession,
  states: PullStates,
): SoloPulls {
  const listeners = new Map<string, Set<() => void>>();
  const links = new Map<string, readonly string[]>();
  /** Shown chats whose link is still to be read. */
  const unread = new Set<string>();
  /** Each shown chat's subscriptions to its linked pull requests' states. */
  const watching = new Map<string, () => void>();
  let linksReadAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let scheduled = false;
  /** What `get` answered since the last change, so it answers the same. */
  const views = new Map<string, readonly SoloPull[] | undefined>();
  const notify = (channel: string) => {
    views.delete(channel);
    for (const listener of listeners.get(channel) ?? []) listener();
  };
  /** Watches the pull requests `channel` links now, while the chat is shown.
   * The store may have moved on while the chat was not: `get` reads afresh. */
  const follow = (channel: string) => {
    watching.get(channel)?.();
    watching.delete(channel);
    views.delete(channel);
    const urls = links.get(channel) ?? [];
    if (urls.length && listeners.has(channel)) {
      const stops = urls.map((url) => states.watch(url, () => notify(channel)));
      watching.set(channel, () => {
        for (const stop of stops) stop();
      });
    }
  };
  /** Tries again in a while, while a shown chat's link is still unread. */
  const later = () => {
    clearTimeout(timer);
    timer = undefined;
    if (![...unread].some((channel) => listeners.has(channel))) return;
    timer = setTimeout(
      () => (document.visibilityState === "visible" ? void refresh() : later()),
      SOLO_REFRESH_MS,
    );
  };
  /** Reads the links still unread. */
  async function refresh() {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    clearTimeout(timer);
    timer = undefined;
    const signal = AbortSignal.any([
      current.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      const channels = [...unread].filter((channel) => listeners.has(channel));
      if (!channels.length) return;
      const read = await readLinks(session, channels, signal);
      // A refresh that was stopped or replaced changes nothing.
      if (current.signal.aborted) return;
      for (const [channel, urls] of read) {
        links.set(channel, urls);
        unread.delete(channel);
        follow(channel);
        notify(channel);
      }
    } catch {
      // Keep what is shown; the next refresh tries again.
    } finally {
      if (controller === current) {
        controller = undefined;
        if (listeners.size) later();
      }
    }
  }
  /** Reads soon, once for every row that starts watching together. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (listeners.size) void refresh();
    });
  }
  /** Back in the window after a while: shown chats read their links again. */
  const returned = () => {
    if (
      document.visibilityState !== "visible" ||
      Date.now() - linksReadAt < LINKS_AGAIN_MS
    )
      return;
    linksReadAt = Date.now();
    for (const channel of listeners.keys()) unread.add(channel);
    schedule();
  };
  return {
    watch(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        if (!listeners.size) {
          linksReadAt = Date.now();
          document.addEventListener("visibilitychange", returned);
        }
        listeners.set(channel, set);
        if (links.has(channel)) follow(channel);
        else {
          unread.add(channel);
          schedule();
        }
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size) return;
        listeners.delete(channel);
        watching.get(channel)?.();
        watching.delete(channel);
        if (listeners.size) return;
        document.removeEventListener("visibilitychange", returned);
        clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        controller = undefined;
      };
    },
    get(channel) {
      if (!views.has(channel)) {
        const urls = links.get(channel) ?? [];
        views.set(
          channel,
          urls.length
            ? urls.map((url) => {
                const state = states.get(url);
                return state === "failed"
                  ? { url, failed: true }
                  : { url, state };
              })
            : undefined,
        );
      }
      return views.get(channel);
    },
    linked(channel, urls) {
      links.set(channel, urls);
      unread.delete(channel);
      follow(channel);
      notify(channel);
    },
  };
}
