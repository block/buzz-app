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
const channel = "11111111-1111-4111-8111-111111111111";
const url = "https://github.com/block/buzz-app/pull/7";

afterEach(() => vi.useRealTimers());

const head = (
  n: number,
  state = "open",
  extra: Partial<VerifiedEvent> = {},
): VerifiedEvent =>
  ({
    id: String(n).padStart(64, "0"),
    pubkey: relay,
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
    ],
    ...extra,
  }) as VerifiedEvent;

function fakeSession() {
  const views: {
    filter: unknown;
    events: VerifiedEvent[];
    listeners: Set<() => void>;
    disposed: boolean;
  }[] = [];
  const session = {
    relayAuthor: relay,
    artifacts: {
      sync(filter: unknown) {
        const view = {
          filter,
          events: [] as VerifiedEvent[],
          listeners: new Set<() => void>(),
          disposed: false,
        };
        views.push(view);
        return {
          snapshot: () => ({ status: "live", events: view.events }),
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
  const publish = (view: (typeof views)[number], events: VerifiedEvent[]) => {
    view.events = events;
    for (const listener of view.listeners) listener();
  };
  return { session, views, publish };
}

it("syncs a watched channel's pull requests and indexes the relay's own by URL and root", () => {
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
  expect(pulls.byUrl(url.toLowerCase())).toBeUndefined();
  const forged = head(8, "merged", { pubkey: "9".repeat(64) });
  const view = views[0];
  if (!view) throw new Error("no view");
  const seven = head(7);
  publish(view, [seven, forged]);
  expect(pulls.byUrl(url.toLowerCase())?.pull.title).toBe("Pull 7");
  expect(pulls.byRoot(`${"f".repeat(63)}7`, relay)?.pull.number).toBe(7);
  expect(pulls.byUrl("https://github.com/block/buzz-app/pull/8")).toBe(
    undefined,
  );
  expect(changed).toHaveBeenCalledOnce();

  const before = pulls.byUrl(url.toLowerCase());
  publish(view, [seven, forged]);
  expect(pulls.byUrl(url.toLowerCase())).toBe(before);
  expect(changed).toHaveBeenCalledOnce();
  publish(view, [{ ...head(7, "merged"), id: "e".repeat(64), created_at: 9 }]);
  expect(pulls.byUrl(url.toLowerCase())?.pull.state).toBe("merged");
  expect(changed).toHaveBeenCalledTimes(2);
});

it("trusts a publisher's card only on its own announcement, never for the pull request elsewhere", () => {
  const { session, views, publish } = fakeSession();
  const pulls = createRelayPulls(session);
  const changed = vi.fn();
  pulls.subscribe(changed);
  pulls.watch(channel);
  const view = views[0];
  if (!view) throw new Error("no view");
  const mike = "c".repeat(64);
  const mallory = "9".repeat(64);
  const root = `${"f".repeat(63)}7`;
  const hook = (author = mike, publisher = mike, d = "hook-d"): VerifiedEvent =>
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
      tags: [
        ...head(7, state).tags.map((entry) =>
          entry[0] === "d" ? ["d", `${d}-card`] : entry,
        ),
        ["hook", d],
      ],
    }) as VerifiedEvent;

  const own = card();
  const followed = hook();
  publish(view, [own]);
  expect(pulls.byRoot(root, mike)).toBeUndefined();
  publish(view, [own, followed]);
  expect(pulls.byRoot(root, mike)?.publisher).toBe(mike);
  expect(pulls.byUrl(url.toLowerCase())).toBeUndefined();
  const calls = changed.mock.calls.length;
  publish(view, [own, followed]);
  expect(changed).toHaveBeenCalledTimes(calls);

  publish(view, [own, hook(mallory, mike)]);
  expect(pulls.byRoot(root, mike)).toBeUndefined();

  const forged = card(mallory, "evil", "merged");
  publish(view, [own, followed, forged, hook(mallory, mallory, "evil")]);
  expect(pulls.byRoot(root, mike)?.pull.state).toBe("open");
  expect(pulls.byRoot(root, mallory)?.pull.state).toBe("merged");
  expect(pulls.byUrl(url.toLowerCase())).toBeUndefined();

  const relayed = { ...head(7, "merged"), id: "3".repeat(64), created_at: 9 };
  publish(view, [own, followed, forged, relayed as VerifiedEvent]);
  expect(pulls.byUrl(url.toLowerCase())?.pull.state).toBe("merged");
  expect(pulls.byUrl(url.toLowerCase())?.publisher).toBeUndefined();
  expect(pulls.byRoot(root, relay)?.publisher).toBeUndefined();
  expect(pulls.byRoot(root, mike)?.publisher).toBe(mike);
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
  publish(view, [head(7)]);
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
  expect(pulls.byUrl(url.toLowerCase())).toBeUndefined();
});

it("offers the selected community's pull requests as the state store's source", () => {
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
  expect(sources.get(url.toLowerCase(), false)).toBeUndefined();
  sources.selected()?.watch(channel);
  const view = views[0];
  if (!view) throw new Error("no view");
  publish(view, [head(7)]);
  expect(changed).toHaveBeenCalledOnce();
  expect(sources.get(url.toLowerCase(), false)).toMatchObject({
    state: "open",
    source: "relay",
  });
  expect(sources.get(url.toLowerCase(), true)?.details).toBeDefined();
  ready = false;
  expect(sources.get(url.toLowerCase(), false)).toBeUndefined();
  stop();
  expect(listeners.size).toBe(0);
  sources.dispose();
  expect(view.disposed).toBe(true);
});
