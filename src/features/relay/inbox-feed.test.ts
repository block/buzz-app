import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, message, metadata, roster, signed } from "./testing";
import type { RelayEvent, ReadFilter } from "./events";
import { mergeInboxItems } from "../../bundled/inbox/items";
import type { LiveCallbacks } from "./live";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair();
  let live!: LiveCallbacks;
  const calls: {
    filters: readonly ReadFilter[];
    pending: ReturnType<typeof deferred<RelayEvent[]>>;
  }[] = [];
  const query = vi.fn((filters: readonly ReadFilter[]) => {
    const pending = deferred<RelayEvent[]>();
    calls.push({ filters, pending });
    return pending.promise;
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const admit = (members: string[], at = 10) =>
    live.receive([
      roster(relay, "room", members, at),
      metadata(relay, "room", "Room", at),
    ]);
  return { ...owner, viewer, alice, relay, admit, calls, live, query };
}
async function take(h: ReturnType<typeof setup>, kind: number) {
  await vi.waitFor(() =>
    expect(h.calls.some((call) => call.filters[0]?.kinds?.includes(kind))).toBe(
      true,
    ),
  );
  const index = h.calls.findIndex((call) =>
    call.filters[0]?.kinds?.includes(kind),
  );
  const call = h.calls.splice(index, 1)[0];
  if (!call) throw new Error("Missing expected feed query");
  return call.pending;
}
it("reads addressed history independently of the retained unread window, never a fake complete archive", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const addressed = message(h.alice, "room", "older mention", 20, [
    ["p", h.viewer.pubkey],
  ]);
  const other = message(h.alice, "room", "not addressed", 21);
  const work = h.session.inboxFeed.ensure();
  const mentions = await take(h, 9);
  expect(mentions.promise).toBeDefined();
  mentions.resolve([addressed, other]);
  const actions = await take(h, 46010);
  actions.resolve([]);
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    mentions: [addressed],
    needsAction: [],
    limited: false,
  });
  // The session reconciles authorized history into shared unread evidence, not a shadow store.
  expect(h.session.unread.inbox().items.map((item) => item.messageId)).toEqual([
    addressed.id,
  ]);
  expect(h.session.channels.window("room").rows).toEqual([]);
});
it("reconciles live addressed updates and drops membership-revoked history before listeners", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const work = h.session.inboxFeed.ensure();
  const mentions = await take(h, 9);
  mentions.resolve([
    message(h.alice, "room", "first", 20, [["p", h.viewer.pubkey]]),
  ]);
  (await take(h, 46010)).resolve([]);
  await work;
  const updates: number[] = [];
  h.session.inboxFeed.subscribe(() =>
    updates.push(h.session.inboxFeed.snapshot().mentions.length),
  );
  h.live.receive([
    message(h.alice, "room", "later", 22, [["p", h.viewer.pubkey]]),
  ]);
  expect(h.session.inboxFeed.snapshot().mentions).toHaveLength(2);
  h.admit([h.alice.pubkey], 30);
  expect(h.session.inboxFeed.snapshot().mentions).toEqual([]);
  expect(updates.at(-1)).toBe(0);
});
it("cache clear fences late completions; fresh demand recovers", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey]);
  const work = h.session.inboxFeed.ensure();
  const mentions = await take(h, 9);
  await h.clearCache();
  mentions.resolve([
    message(h.alice, "room", "old", 20, [["p", h.viewer.pubkey]]),
  ]);
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "idle",
    mentions: [],
  });
  expect(h.query).toHaveBeenCalledTimes(1);
  const again = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([]);
  (await take(h, 46010)).resolve([]);
  await again;
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
});
it("surfaces read denial without treating it as empty, then retries", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey]);
  const work = h.session.inboxFeed.ensure();
  (await take(h, 9)).reject(new Error("restricted: feed unavailable"));
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "error",
    error: "restricted: feed unavailable",
  });
  const again = h.session.inboxFeed.refresh();
  (await take(h, 9)).resolve([]);
  (await take(h, 46010)).resolve([]);
  await again;
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
});

async function discover(h: ReturnType<typeof setup>) {
  h.session.channels.ensureList();
  (await take(h, 39002)).resolve([
    roster(h.relay, "room", [h.viewer.pubkey, h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10),
  ]);
  await vi.waitFor(() =>
    expect(h.session.channels.list().status).toBe("ready"),
  );
}
const rows = (h: ReturnType<typeof setup>) =>
  mergeInboxItems(
    h.session.unread.inbox().items,
    h.session.inboxFeed.snapshot(),
    h.session.channels.list().channels,
    h.session,
  );
const project = (h: ReturnType<typeof setup>, text: string, at: number) =>
  signed(h.alice, {
    kind: 1621,
    content: text,
    created_at: at,
    tags: [
      ["a", `30617:${h.alice.pubkey}:repo`],
      ["p", h.viewer.pubkey],
    ],
  });
it("complete initial roster remains lazy; first demand, invalidation and fresh demand really read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = setup();
  await discover(h);
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(46010)),
    ),
  ).toBe(false);
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  const first = h.session.inboxFeed.ensure();
  const gate = await take(h, 9);
  expect(h.session.inboxFeed.snapshot().status).toBe("loading");
  const issue = project(h, "historical issue", 15);
  gate.resolve([issue]);
  (await take(h, 46010)).resolve([]);
  await first;
  expect(rows(h).map((row) => row.preview)).toContain("historical issue");
  const addressedReads = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some(
        (filter) =>
          !!filter["#p"] &&
          (filter.kinds?.includes(9) || filter.kinds?.includes(46010)),
      ),
    ).length;
  const count = addressedReads();
  expect(count).toBe(2);
  h.admit([h.alice.pubkey], 30);
  expect(h.session.inboxFeed.snapshot().mentions).toEqual([]);
  // Admission/listeners run synchronously; drain microtasks and the existing
  // zero-delay scheduling boundary before granting any fresh Inbox demand.
  await vi.advanceTimersByTimeAsync(0);
  expect(addressedReads()).toBe(count);
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  const next = h.session.inboxFeed.ensure();
  const fresh = await take(h, 9);
  expect(addressedReads()).toBe(count + 1);
  fresh.resolve([issue]);
  (await take(h, 46010)).resolve([]);
  await next;
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
});
it("reconnect recovers demanded feed but never starts an unopened feed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = setup();
  await discover(h);
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  h.live.state({ status: "connected", routes: [] });
  h.live.established();
  await vi.advanceTimersByTimeAsync(0);
  // Complete the roster and the existing zero-delay reconnect callback explicitly.
  (await take(h, 39002)).resolve([
    roster(h.relay, "room", [h.viewer.pubkey, h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10),
  ]);
  await vi.waitFor(() =>
    expect(h.session.channels.list().status).toBe("ready"),
  );
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  const first = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([]);
  (await take(h, 46010)).resolve([]);
  await first;
  h.live.state({ status: "retrying", routes: [] });
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  h.live.state({ status: "connected", routes: [] });
  h.live.established();
  await vi.advanceTimersByTimeAsync(0);
  (await take(h, 39002)).resolve([
    roster(h.relay, "room", [h.viewer.pubkey, h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10),
  ]);
  (await take(h, 9)).resolve([project(h, "reconnected issue", 30)]);
  (await take(h, 46010)).resolve([]);
  await vi.waitFor(() =>
    expect(h.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(rows(h).map((row) => row.preview)).toContain("reconnected issue");
});
it("finite completion merges concurrent live project arrivals and author deletions", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = project(h, "old", 20),
    live = project(h, "live", 30);
  const first = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([old]);
  const approval = await take(h, 46010);
  try {
    h.live.receive([live]);
    expect(rows(h).map((row) => row.preview)).toContain("live");
    h.live.receive([
      signed(h.alice, {
        kind: 5,
        tags: [["e", old.id]],
        content: "",
        created_at: 31,
      }),
    ]);
  } finally {
    approval.resolve([]);
  }
  await first;
  expect(rows(h).map((row) => row.preview)).toEqual(["live"]);
  const again = h.session.inboxFeed.refresh();
  const stale = await take(h, 9);
  h.admit([h.alice.pubkey], 40);
  stale.resolve([old, live]);
  await again;
  expect(rows(h)).toEqual([]);
});
it("channel feed history uses the shared fold: own/deleted rows stay absent and unresolved roots never duplicate", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.viewer, "room", "root", 15);
  const reply = message(h.alice, "room", "reply", 20, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const own = message(h.viewer, "room", "own addressed", 21, [
    ["p", h.viewer.pubkey],
  ]);
  const work = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([reply, own]);
  (await take(h, 46010)).resolve([]);
  await work;
  expect(rows(h).map((row) => row.id)).toEqual([`room:${reply.id}`]);
  h.live.receive([root]);
  expect(rows(h).map((row) => row.id)).toEqual([`room:${root.id}`]);
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      tags: [
        ["h", "room"],
        ["e", reply.id],
      ],
      content: "",
      created_at: 30,
    }),
  ]);
  expect(rows(h)).toEqual([]);
  const refresh = h.session.inboxFeed.refresh();
  (await take(h, 9)).resolve([reply, own]);
  (await take(h, 46010)).resolve([]);
  await refresh;
  expect(rows(h)).toEqual([]);
});

it("a live deletion arriving before a held finite result suppresses its late row even while loading", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const issue = project(h, "late deleted", 20);
  // Establish shared target visibility first; orphan reference-only deletions
  // are deliberately not admitted by the session access owner.
  h.live.receive([issue]);
  const work = h.session.inboxFeed.ensure();
  const mention = await take(h, 9);
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      tags: [["e", issue.id]],
      content: "",
      created_at: 30,
    }),
  ]);
  mention.resolve([issue]);
  const approval = await take(h, 46010);
  try {
    expect(rows(h)).toEqual([]);
  } finally {
    approval.resolve([]);
  }
  await work;
  expect(rows(h)).toEqual([]);
});

it.each([false, true])(
  "disposal erases populated feed content and rejects late completion (pending=%s)",
  async (pending) => {
    const h = setup();
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    const feed = h.session.inboxFeed;
    const mention = project(h, "retired issue", 20);
    const approval = signed(h.alice, {
      kind: 46010,
      content: "Approval",
      created_at: 21,
      tags: [["p", h.viewer.pubkey]],
    });
    const initial = feed.ensure();
    (await take(h, 9)).resolve([mention]);
    (await take(h, 46010)).resolve([approval]);
    await initial;
    expect(feed.snapshot()).toMatchObject({
      status: "ready",
      mentions: [mention],
      needsAction: [approval],
    });
    const work = pending ? feed.refresh() : undefined;
    const held = pending ? await take(h, 9) : undefined;
    const notify = vi.fn();
    feed.subscribe(notify);
    try {
      h.dispose();
      expect(feed.snapshot()).toMatchObject({
        status: "idle",
        mentions: [],
        needsAction: [],
        limited: false,
      });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      held?.resolve([mention]);
      await work;
    }
    expect(feed.snapshot()).toMatchObject({
      status: "idle",
      mentions: [],
      needsAction: [],
    });
    expect(notify).not.toHaveBeenCalled();
  },
);
