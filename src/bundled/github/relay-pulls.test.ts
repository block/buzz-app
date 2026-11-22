// @vitest-environment jsdom
import type { VerifiedEvent } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { HOOK_TYPE } from "./hooks";
import { PULL_TYPE } from "./relay-pull";
import {
  SYNC_LINGER_MS,
  createPullSources,
  createRelayPulls,
} from "./relay-pulls";

const relay = "a".repeat(64);
const mike = "c".repeat(64);
const channel = "11111111-1111-4111-8111-111111111111";
const root = `${"f".repeat(63)}7`;

afterEach(() => vi.useRealTimers());

const head = (
  n: number,
  state = "open",
  extra: Partial<VerifiedEvent> = {},
): VerifiedEvent =>
  ({
    id: String(n).padStart(64, "0"),
    pubkey: mike,
    sig: "",
    created_at: n,
    kind: 45010,
    content: JSON.stringify({
      version: 1,
      url: `https://github.com/block/buzz-app/pull/${n}`,
      repo: "block/buzz-app",
      number: n,
      title: `Pull ${n}`,
      author: "joah",
      state,
    }),
    tags: [
      ["d", `d${n}`],
      ["h", channel],
      ["type", PULL_TYPE],
      ["root", String(n).padStart(64, "f")],
      ["hook", "hook-d"],
    ],
    ...extra,
  }) as VerifiedEvent;

const hook = (author = mike, publisher = author, d = "hook-d"): VerifiedEvent =>
  ({
    id: `${d}`.padEnd(64, "1"),
    pubkey: author,
    sig: "",
    created_at: 1,
    kind: 45010,
    content: JSON.stringify({ version: 1, repo: "block/buzz-app" }),
    tags: [
      ["d", d],
      ["h", channel],
      ["type", HOOK_TYPE],
      ["repo", "block/buzz-app"],
      ["publisher", publisher],
    ],
  }) as VerifiedEvent;

function fakeSession(
  stored: (filter: Record<string, unknown>) => VerifiedEvent[] = () => [],
) {
  const views: {
    filter: unknown;
    status: string;
    events: VerifiedEvent[];
    listeners: Set<() => void>;
    disposed: boolean;
  }[] = [];
  const reads: Record<string, unknown>[] = [];
  const session = {
    relayAuthor: relay,
    snapshotRead: async (filters: Record<string, unknown>[]) => {
      const [filter] = filters;
      if (!filter) return [];
      reads.push(filter);
      return stored(filter);
    },
    artifacts: {
      sync(filter: unknown) {
        const view = {
          filter,
          status: "live",
          events: [] as VerifiedEvent[],
          listeners: new Set<() => void>(),
          disposed: false,
        };
        views.push(view);
        return {
          snapshot: () => ({ status: view.status, events: view.events }),
          subscribe(listener: () => void) {
            view.listeners.add(listener);
            return () => view.listeners.delete(listener);
          },
          dispose() {
            view.disposed = true;
          },
        };
      },
    },
  } as unknown as RelaySession;
  const publish = (
    view: (typeof views)[number],
    events: VerifiedEvent[],
    status = "live",
  ) => {
    view.events = events;
    view.status = status;
    for (const listener of view.listeners) listener();
  };
  return { session, views, reads, publish };
}

it("syncs a watched channel's pull requests and indexes its publishers' cards by announcement", () => {
  const { session, views, publish } = fakeSession();
  const pulls = createRelayPulls(session);
  const changed = vi.fn();
  pulls.subscribe(changed);
  pulls.watch(channel);
  expect(views[0]?.filter).toEqual({
    artifact: "current",
    kinds: [45010],
    "#h": [channel],
    "#type": [PULL_TYPE, HOOK_TYPE],
  });
  const view = views[0];
  if (!view) throw new Error("no view");
  const seven = head(7);
  const followed = hook();
  publish(view, [seven]);
  // A card with no live hook naming its signer is no one's.
  expect(pulls.byRoot(root, mike)).toBeUndefined();
  publish(view, [seven, followed]);
  expect(pulls.byRoot(root, mike)?.pull.title).toBe("Pull 7");
  expect(changed).toHaveBeenCalledOnce();

  const before = pulls.byRoot(root, mike);
  publish(view, [seven, followed]);
  expect(pulls.byRoot(root, mike)).toBe(before);
  expect(changed).toHaveBeenCalledOnce();
  publish(view, [
    { ...head(7, "merged"), id: "e".repeat(64), created_at: 9 },
    followed,
  ]);
  expect(pulls.byRoot(root, mike)?.pull.state).toBe("merged");
  expect(changed).toHaveBeenCalledTimes(2);
});

it("trusts a card only from the publisher of its live hook, and only on that publisher's announcement", () => {
  const { session, views, publish } = fakeSession();
  const pulls = createRelayPulls(session);
  pulls.watch(channel);
  const view = views[0];
  if (!view) throw new Error("no view");
  const mallory = "9".repeat(64);
  const card = (
    author = mike,
    d = "hook-d",
    state: "open" | "merged" = "open",
  ) =>
    ({
      ...head(7, state),
      id: `${author.slice(0, 1)}${state}`.padEnd(64, "2"),
      pubkey: author,
      created_at: 50,
      tags: head(7, state).tags.map((entry) =>
        entry[0] === "d"
          ? ["d", `${d}-card`]
          : entry[0] === "hook"
            ? ["hook", d]
            : entry,
      ),
    }) as VerifiedEvent;

  const own = card();
  const followed = hook();
  publish(view, [own, followed]);
  expect(pulls.byRoot(root, mike)?.publisher).toBe(mike);

  // A hook someone else wrote naming Mike names no publisher.
  publish(view, [own, hook(mallory, mike)]);
  expect(pulls.byRoot(root, mike)).toBeUndefined();

  const forged = card(mallory, "evil", "merged");
  publish(view, [own, followed, forged, hook(mallory, mallory, "evil")]);
  expect(pulls.byRoot(root, mike)?.pull.state).toBe("open");
  expect(pulls.byRoot(root, mallory)?.pull.state).toBe("merged");

  // The relay's signature vouches for nothing here.
  const relayed = {
    ...head(7, "merged"),
    id: "3".repeat(64),
    pubkey: relay,
    created_at: 90,
  };
  publish(view, [own, followed, relayed as VerifiedEvent]);
  expect(pulls.byRoot(root, relay)).toBeUndefined();
  expect(pulls.byRoot(root, mike)?.pull.state).toBe("open");
});

it("reads each shown announcement's cards once when the channel's sync fails for good", async () => {
  const { session, views, reads, publish } = fakeSession((filter) =>
    (filter["#root"] as string[] | undefined)?.[0] === root
      ? [head(7)]
      : (filter["#d"] as string[] | undefined)?.[0] === "hook-d"
        ? [hook()]
        : [],
  );
  const pulls = createRelayPulls(session);
  pulls.watch(channel, root);
  const view = views[0];
  if (!view) throw new Error("no view");
  expect(reads).toEqual([]);
  publish(view, [], "error");
  await vi.waitFor(() => expect(pulls.byRoot(root, mike)?.pull.number).toBe(7));
  expect(reads).toEqual([
    {
      kinds: [45010],
      "#h": [channel],
      "#type": [PULL_TYPE],
      "#root": [root],
      artifact: "current",
      limit: 100,
    },
    {
      kinds: [45010],
      "#h": [channel],
      "#type": [HOOK_TYPE],
      "#d": ["hook-d"],
      artifact: "current",
      limit: 1,
    },
  ]);
  publish(view, [], "error");
  pulls.watch(channel, root);
  expect(reads).toHaveLength(2);
});

it("ends a fallback read's trust once the sync recovers without the hook", async () => {
  const { session, views, publish } = fakeSession((filter) =>
    (filter["#root"] as string[] | undefined)?.[0] === root
      ? [head(7)]
      : (filter["#d"] as string[] | undefined)?.[0] === "hook-d"
        ? [hook()]
        : [],
  );
  const pulls = createRelayPulls(session);
  pulls.watch(channel, root);
  const view = views[0];
  if (!view) throw new Error("no view");
  publish(view, [], "error");
  await vi.waitFor(() => expect(pulls.byRoot(root, mike)?.pull.number).toBe(7));
  // Unfollowed: the recovered sync holds the card but no hook.
  publish(view, [head(7)], "live");
  expect(pulls.byRoot(root, mike)).toBeUndefined();
});

it("drops a fallback read that lands after the sync recovers", async () => {
  let land: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    land = resolve;
  });
  const card = head(7);
  const { session, views, publish } = fakeSession((filter) =>
    (filter["#root"] as string[] | undefined)?.[0] === root
      ? [card]
      : (filter["#d"] as string[] | undefined)?.[0] === "hook-d"
        ? [hook()]
        : [],
  );
  const read = session.snapshotRead as NonNullable<typeof session.snapshotRead>;
  (session as { snapshotRead: typeof read }).snapshotRead = async (...args) => {
    await gate;
    return read(...args);
  };
  const pulls = createRelayPulls(session);
  pulls.watch(channel, root);
  const view = views[0];
  if (!view) throw new Error("no view");
  publish(view, [], "error");
  publish(view, [card], "live");
  land?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pulls.byRoot(root, mike)).toBeUndefined();
});

it("keeps a channel's sync a while after its last reader, and one sync for all readers", () => {
  vi.useFakeTimers();
  const { session, views, publish } = fakeSession();
  const pulls = createRelayPulls(session);
  const stopA = pulls.watch(channel);
  const stopB = pulls.watch(channel);
  expect(views).toHaveLength(1);
  const view = views[0];
  if (!view) throw new Error("no view");
  publish(view, [head(7), hook()]);
  expect(pulls.byRoot(root, mike)).toBeDefined();
  stopA();
  stopA();
  stopB();
  vi.advanceTimersByTime(SYNC_LINGER_MS - 1);
  expect(view.disposed).toBe(false);
  const stopC = pulls.watch(channel);
  vi.advanceTimersByTime(SYNC_LINGER_MS);
  expect(view.disposed).toBe(false);
  stopC();
  vi.advanceTimersByTime(SYNC_LINGER_MS);
  expect(view.disposed).toBe(true);
  expect(pulls.byRoot(root, mike)).toBeUndefined();
});

it("offers the selected community's cards, and none while no community is ready", () => {
  const { session, views, publish } = fakeSession();
  let ready = true;
  const listeners = new Set<() => void>();
  const data = {
    snapshot: () => ({ status: ready ? "ready" : "connecting", session }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  const sources = createPullSources(data);
  const changed = vi.fn();
  const stop = sources.subscribe(changed);
  sources.selected()?.watch(channel);
  const view = views[0];
  if (!view) throw new Error("no view");
  publish(view, [head(7), hook()]);
  expect(changed).toHaveBeenCalledOnce();
  expect(sources.selected()?.byRoot(root, mike)?.pull.state).toBe("open");
  ready = false;
  expect(sources.selected()).toBeUndefined();
  stop();
  expect(listeners.size).toBe(0);
  sources.dispose();
  expect(view.disposed).toBe(true);
});
