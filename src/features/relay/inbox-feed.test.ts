import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, message, metadata, roster, signed } from "./testing";
import type { RelayEvent, ReadFilter } from "./events";
import type { LiveCallbacks } from "./live";

// General #e reads return an empty terminal page. The ordinary #p response is
// still explicitly gated by each test; no incidental timer orders admission.
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
    if (filters[0]?.["#e"]) return Promise.resolve([] as RelayEvent[]);
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
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    mentions: [addressed],
    limited: false,
  });
  // The session reconciles authorized history into shared unread evidence, not a shadow store.
  expect(h.session.unread.inbox().items.map((item) => item.messageId)).toEqual([
    addressed.id,
  ]);
  expect(h.session.channels.window("room").rows).toEqual([]);
  expect(h.query).toHaveBeenCalledTimes(2); // addressed #p and exact #e terminal page
  expect(h.query.mock.calls[1]?.[0]).toEqual([
    {
      kinds: [40003, 5, 9005],
      "#e": [addressed.id],
      limit: 500,
    },
  ]);
  expect(h.query.mock.calls[0]?.[0]).toEqual([
    { kinds: [40002, 9], "#p": [h.viewer.pubkey], limit: 50 },
  ]);
});
it("reconciles live addressed updates and drops membership-revoked history before listeners", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const work = h.session.inboxFeed.ensure();
  const mentions = await take(h, 9);
  mentions.resolve([
    message(h.alice, "room", "first", 20, [["p", h.viewer.pubkey]]),
  ]);
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
const rows = (h: ReturnType<typeof setup>) => h.session.unread.inbox().items;
const addressed = (h: ReturnType<typeof setup>, text: string, at: number) =>
  message(h.alice, "room", text, at, [["p", h.viewer.pubkey]]);
it("complete initial roster remains lazy; first demand, invalidation and fresh demand really read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = setup();
  await discover(h);
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((filter) => !!filter["#p"] && filter.kinds?.includes(9)),
    ),
  ).toBe(false);
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  const first = h.session.inboxFeed.ensure();
  const gate = await take(h, 9);
  expect(h.session.inboxFeed.snapshot().status).toBe("loading");
  const issue = addressed(h, "historical mention", 15);
  gate.resolve([issue]);
  await first;
  expect(rows(h).map((row) => row.preview)).toContain("historical mention");
  const addressedReads = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => !!filter["#p"] && filter.kinds?.includes(9)),
    ).length;
  const count = addressedReads();
  expect(count).toBe(1);
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
  (await take(h, 9)).resolve([addressed(h, "reconnected mention", 30)]);
  await vi.waitFor(() =>
    expect(h.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(rows(h).map((row) => row.preview)).toContain("reconnected mention");
});
it("finite completion merges concurrent live chat arrivals and author deletions", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "old", 20),
    live = addressed(h, "live", 30);
  // Establish deletion admission before holding the finite mention read.
  h.live.receive([old]);
  const first = h.session.inboxFeed.ensure();
  const mention = await take(h, 9);
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
    mention.resolve([old]);
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
  await refresh;
  expect(rows(h)).toEqual([]);
});

it("a live deletion arriving before a held finite result suppresses its late row even while loading", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const chat = addressed(h, "late deleted", 20);
  // Establish shared target visibility first; orphan reference-only deletions
  // are deliberately not admitted by the session access owner.
  h.live.receive([chat]);
  const work = h.session.inboxFeed.ensure();
  const mention = await take(h, 9);
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      tags: [["e", chat.id]],
      content: "",
      created_at: 30,
    }),
  ]);
  mention.resolve([chat]);
  await work;
  expect(rows(h)).toEqual([]);
});

it.each([false, true])(
  "disposal erases populated feed content and rejects late completion (pending=%s)",
  async (pending) => {
    const h = setup();
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    const feed = h.session.inboxFeed;
    const mention = addressed(h, "retired mention", 20);
    const initial = feed.ensure();
    (await take(h, 9)).resolve([mention]);
    await initial;
    expect(feed.snapshot()).toMatchObject({
      status: "ready",
      mentions: [mention],
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
    });
    expect(notify).not.toHaveBeenCalled();
  },
);

it("reprojects retained chat candidates after joining from an empty admitted snapshot without another feed read", async () => {
  const h = setup();
  h.live.receive([
    roster(h.relay, "room", [h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10, [["public"]]),
  ]);
  const chat = addressed(h, "Addressed chat", 20);
  const work = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([chat]);
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    mentions: [],
  });
  expect(rows(h)).toEqual([]);
  const reads = h.query.mock.calls.length;
  h.admit([h.viewer.pubkey, h.alice.pubkey], 30);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    mentions: [chat],
  });
  // Unread never admitted the pre-membership chat. Its existing admission owner
  // needs fresh evidence; the feed snapshot must not create an alternate row.
  expect(rows(h)).toEqual([]);
  await h.session.inboxFeed.ensure();
  expect(h.query).toHaveBeenCalledTimes(reads);
  h.live.receive([chat]);
  expect(rows(h).map((row) => row.messageId)).toEqual([chat.id]);
});
it("excludes nonchat and approval events from finite/live feed rows and coalesces one bounded chat request", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const chat = addressed(h, "Chat mention", 20);
  const nonchat = [
    1, 45001, 45003, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 46010, 46011,
    46012,
  ].map((kind) =>
    signed(h.alice, {
      kind,
      content: `Excluded ${kind}`,
      created_at: 21,
      tags: [
        ["h", "room"],
        ["p", h.viewer.pubkey],
        ["a", `30617:${h.alice.pubkey}:repo`],
      ],
    }),
  );
  const first = h.session.inboxFeed.ensure(),
    second = h.session.inboxFeed.refresh();
  (await take(h, 9)).resolve([chat, ...nonchat]);
  await Promise.all([first, second]);
  expect(h.query).toHaveBeenCalledTimes(2); // one coalesced #p, one #e closure
  expect(h.session.inboxFeed.snapshot().mentions).toEqual([chat]);
  const before = h.session.unread.inbox();
  h.live.receive(nonchat);
  expect(h.session.unread.inbox()).toBe(before);
  expect(rows(h).map((row) => row.messageId)).toEqual([chat.id]);
  expect(h.session.inboxFeed.snapshot().mentions).toEqual([chat]);
});

it("first verified admission marks exact target incomplete before unread subscribers see original", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "OLD BODY", 20);
  const sequence: {
    preview: string | undefined;
    status: string;
    incomplete: readonly string[];
  }[] = [];
  const observe = () =>
    sequence.push({
      preview: rows(h)[0]?.preview,
      status: h.session.inboxFeed.snapshot().status,
      incomplete: h.session.inboxFeed.snapshot().incomplete,
    });
  const stop = h.session.unread.subscribeInbox(observe);
  const stopFeed = h.session.inboxFeed.subscribe(observe);
  try {
    const work = h.session.inboxFeed.ensure();
    (await take(h, 9)).resolve([old]);
    await work;
    expect(sequence.filter(({ preview }) => preview === "OLD BODY")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "loading",
          incomplete: [old.id],
        }),
      ]),
    );
    expect(
      sequence.filter(
        ({ preview, incomplete, status }) =>
          preview === "OLD BODY" &&
          !incomplete.includes(old.id) &&
          status !== "ready",
      ),
    ).toEqual([]);
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    });
  } finally {
    stop();
    stopFeed();
  }
});

it("settles a signed old addressed edit after 500 newer ordinary rows without opening detail or live replay", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "OLD BODY", 20);
  const edit = signed(h.alice, {
    kind: 40003,
    created_at: 21,
    content: "CURRENT BODY",
    tags: [
      ["h", "room"],
      ["e", old.id],
    ],
  });
  const newer = Array.from({ length: 500 }, (_, i) =>
    message(h.alice, "room", `ordinary ${i}`, 100 + i),
  );
  const addressedQuery = deferred<RelayEvent[]>();
  const filters: ReadFilter[] = [];
  h.query.mockImplementation(async ([filter]) => {
    if (!filter) return [];
    filters.push(filter);
    if (filter["#p"]) return addressedQuery.promise;
    if (filter["#h"]) return newer;
    if (filter["#e"]?.includes(old.id)) {
      // General #e, not include_aux on #p, returns author edits of exact IDs.
      return filter.until === undefined ? [edit] : [];
    }
    if (filter["#e"]?.includes(edit.id)) return [];
    return [];
  });
  const unread = h.session.unread.ensure();
  await unread;
  expect(rows(h)).toEqual([]);
  const work = h.session.inboxFeed.ensure();
  await vi.waitFor(() =>
    expect(filters.some((filter) => !!filter["#p"])).toBe(true),
  );
  addressedQuery.resolve([old]);
  await work;
  expect(rows(h).map((item) => item.preview)).toEqual(["CURRENT BODY"]);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(filters.filter((filter) => filter["#e"])).toEqual([
    { kinds: [40003, 5, 9005], "#e": [old.id], limit: 500 },
    {
      kinds: [40003, 5, 9005],
      "#e": [old.id],
      limit: 500,
      until: 21,
      before_id: edit.id,
    },
    { kinds: [5, 9005], "#e": [edit.id], limit: 500 },
  ]);
  expect(filters.find((filter) => filter["#p"])).toEqual({
    kinds: [40002, 9],
    "#p": [h.viewer.pubkey],
    limit: 50,
  });
  expect(h.session.channels.window("room").rows).toEqual([]);
});

it("keeps exact incomplete evidence across held edit and deletion reads, failed retry and recovery", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "OLD BODY", 20);
  const edit = signed(h.alice, {
    kind: 40003,
    created_at: 21,
    content: "CURRENT BODY",
    tags: [
      ["h", "room"],
      ["e", old.id],
    ],
  });
  const hold = deferred<RelayEvent[]>();
  let editReads = 0;
  const tombstone = deferred<RelayEvent[]>();
  const retry = deferred<RelayEvent[]>();
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [old];
    if (filter?.["#e"]?.includes(old.id)) {
      if (filter.until !== undefined) return [];
      editReads++;
      return editReads === 1 ? hold.promise : retry.promise;
    }
    if (filter?.["#e"]?.includes(edit.id)) return tombstone.promise;
    return [];
  });
  const feed = h.session.inboxFeed;
  const work = feed.ensure();
  try {
    await vi.waitFor(() => expect(editReads).toBe(1));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [old.id],
    });
    expect(rows(h)[0]?.preview).toBe("OLD BODY"); // PR4 must show placeholder instead
    hold.resolve([edit]);
    await vi.waitFor(() => expect(rows(h)[0]?.preview).toBe("CURRENT BODY"));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [old.id],
    });
    tombstone.reject(new Error("edit tombstones unavailable"));
    await work;
    expect(feed.snapshot()).toMatchObject({
      status: "error",
      incomplete: [old.id],
      error: "edit tombstones unavailable",
    });
    const next = feed.refresh();
    await vi.waitFor(() => expect(editReads).toBe(2));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [old.id],
    });
    retry.resolve([]); // existing admitted edit remains usable
    await next;
    expect(rows(h)[0]?.preview).toBe("CURRENT BODY");
    expect(feed.snapshot()).toMatchObject({ status: "ready", incomplete: [] });
  } finally {
    hold.resolve([]);
    retry.resolve([]);
    tombstone.resolve([]);
  }
});

it("tombstones a stored edit, then restores its original target body only after closure settles", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "original", 20);
  const edit = signed(h.alice, {
    kind: 40003,
    created_at: 21,
    content: "superseded",
    tags: [
      ["h", "room"],
      ["e", target.id],
    ],
  });
  const deletion = signed(h.alice, {
    kind: 5,
    created_at: 22,
    content: "",
    tags: [["e", edit.id]],
  });
  let release!: (events: RelayEvent[]) => void;
  const held = new Promise<RelayEvent[]>((resolve) => {
    release = resolve;
  });
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [target];
    if (filter?.["#e"]?.includes(target.id))
      return filter.until === undefined ? [edit] : [];
    if (filter?.["#e"]?.includes(edit.id))
      return filter.until === undefined ? held : [];
    return [];
  });
  const work = h.session.inboxFeed.ensure();
  try {
    await vi.waitFor(() => expect(rows(h)[0]?.preview).toBe("superseded"));
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [target.id],
    });
    release([deletion]);
    await work;
    expect(rows(h)[0]?.preview).toBe("original");
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    });
  } finally {
    release([]);
  }
});

it("access removal while pre-admission subscriber runs cannot admit the pending target", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "must not appear", 20);
  const stop = h.session.inboxFeed.subscribe(() => {
    if (h.session.inboxFeed.snapshot().incomplete.includes(target.id))
      h.admit([h.alice.pubkey], 30);
  });
  try {
    const work = h.session.inboxFeed.ensure();
    (await take(h, 9)).resolve([target]);
    await work;
    expect(rows(h)).toEqual([]);
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "idle",
      incomplete: [],
    });
    expect(h.query.mock.calls.some(([filters]) => filters[0]?.["#e"])).toBe(
      false,
    );
  } finally {
    stop();
  }
});

it("a cache reset fences an old pending edit read and its late result", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "old", 20);
  let release!: (events: RelayEvent[]) => void;
  const held = new Promise<RelayEvent[]>((resolve) => {
    release = resolve;
  });
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [target];
    if (filter?.["#e"]) return held;
    return [];
  });
  const work = h.session.inboxFeed.ensure();
  try {
    await vi.waitFor(() =>
      expect(h.session.inboxFeed.snapshot().incomplete).toEqual([target.id]),
    );
    expect(h.session.inboxFeed.snapshot().status).toBe("loading");
    await h.clearCache();
    release([
      signed(h.alice, {
        kind: 40003,
        content: "late",
        created_at: 21,
        tags: [
          ["h", "room"],
          ["e", target.id],
        ],
      }),
    ]);
    await work;
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "idle",
      incomplete: [],
      mentions: [],
    });
    expect(rows(h)).toEqual([]);
  } finally {
    release([]);
  }
});

it("pending exact group member survives verified root regrouping and representative changes", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.viewer, "room", "my root", 15);
  const reply = message(h.alice, "room", "old reply", 20, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  let release!: (events: RelayEvent[]) => void;
  const held = new Promise<RelayEvent[]>((resolve) => {
    release = resolve;
  });
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [reply];
    if (filter?.["#e"]) return held;
    return [];
  });
  const work = h.session.inboxFeed.ensure();
  try {
    await vi.waitFor(() =>
      expect(h.session.inboxFeed.snapshot().incomplete).toEqual([reply.id]),
    );
    expect(rows(h)[0]).toMatchObject({
      id: `room:${reply.id}`,
      messageIds: [reply.id],
    });
    h.live.receive([root]);
    expect(rows(h)[0]).toMatchObject({
      id: `room:${root.id}`,
      messageId: reply.id,
      messageIds: [reply.id],
    });
    expect(
      rows(h)[0]?.messageIds.some((id) =>
        h.session.inboxFeed.snapshot().incomplete.includes(id),
      ),
    ).toBe(true);
  } finally {
    release([]);
    await work;
  }
});

it("a synchronous loading subscriber clears demand without stranding a stale work promise", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  let once = true;
  const feed = h.session.inboxFeed;
  const stop = feed.subscribe(() => {
    if (once && feed.snapshot().status === "loading") {
      once = false;
      feed.clear();
    }
  });
  try {
    const cancelled = feed.ensure();
    // Explicitly settle the fixture's aborted request, without a test timeout.
    (await take(h, 9)).resolve([]);
    await cancelled;
    expect(feed.snapshot()).toMatchObject({ status: "idle", incomplete: [] });
    const fresh = feed.ensure();
    (await take(h, 9)).resolve([]);
    await fresh;
    expect(feed.snapshot().status).toBe("ready");
  } finally {
    stop();
  }
});

it("retry verifies an old incomplete target even if a new addressed page excludes it", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "old", 20);
  const newer = Array.from({ length: 50 }, (_, i) =>
    addressed(h, `new ${i}`, 100 + i),
  );
  let attempt = 0;
  const exactReads: readonly string[][] = [];
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return ++attempt === 1 ? [old] : newer;
    if (filter?.["#e"] && filter.until === undefined) {
      (exactReads as string[][]).push([...filter["#e"]]);
      if (attempt === 1) throw new Error("overlays unavailable");
    }
    return [];
  });
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "error",
    incomplete: [old.id],
  });
  await h.session.inboxFeed.refresh();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(exactReads[1]).toContain(old.id);
  expect(exactReads[1]).toHaveLength(51);
});

it("an excessive edit page remains retryable instead of clearing incomplete evidence", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "original", 20);
  const edits = Array.from({ length: 500 }, (_, i) =>
    signed(h.alice, {
      kind: 40003,
      created_at: 30 + i,
      content: `revision ${i}`,
      tags: [
        ["h", "room"],
        ["e", target.id],
      ],
    }),
  );
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [target];
    if (filter?.["#e"]?.includes(target.id)) return edits;
    return [];
  });
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "error",
    incomplete: [target.id],
  });
  expect(h.session.inboxFeed.snapshot().error).toMatch(
    /did not advance|read budget/,
  );
  expect(h.session.inboxFeed.snapshot().status).not.toBe("ready");
});

it("ordinary live receive after cache clearing does not throw from the finite callback fence", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  await h.clearCache();
  expect(() => h.live.receive([addressed(h, "ordinary", 20)])).not.toThrow();
});

it("a reentrant feed clear during exact pre-admission never publishes the old body", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "never publish", 20);
  const feed = h.session.inboxFeed;
  const observed: string[] = [];
  const stopUnread = h.session.unread.subscribeInbox(() => {
    observed.push(...rows(h).map((row) => row.preview));
  });
  const stop = feed.subscribe(() => {
    if (feed.snapshot().incomplete.includes(target.id)) feed.clear();
  });
  try {
    const work = feed.ensure();
    (await take(h, 9)).resolve([target]);
    await work;
    expect(observed).not.toContain("never publish");
    expect(rows(h)).toEqual([]);
    expect(feed.snapshot()).toMatchObject({ status: "idle", incomplete: [] });
  } finally {
    stop();
    stopUnread();
  }
});
