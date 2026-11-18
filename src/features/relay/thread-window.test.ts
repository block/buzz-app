import { createHash } from "node:crypto";
import { assert, afterEach, describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { connectBrokerTransport } from "./transport";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { keypair, message, roster, signed } from "./testing";
import {
  type ThreadCursor,
  threadAuthority,
  threadBinding,
  verifyThreadWindows,
} from "./thread-window";
import { createThreadView, type ThreadResume } from "./threads";

const channel = "00000000-0000-0000-0000-000000000000";
const origin = "https://relay.example:8443";
const relay = keypair(),
  viewer = keypair(),
  author = keypair();
const root = message(author, channel, "root", 1);
const reply = (n: number) =>
  message(author, channel, `reply ${n}`, 10 + Math.floor(n / 3), [
    ["e", root.id, "", "reply"],
  ]);
// Independent encoder: do not sign fixture bounds with the client's implementation.
function bounds(
  filter: ReadFilter,
  cursor: { created_at: number; id: string } | null = null,
  patch: Record<string, unknown> = {},
  key = relay,
) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "tw",
        1,
        "older",
        "relay.example:8443",
        viewer.pubkey,
        channel,
        root.id,
        filter.limit,
        filter.depth_limit ?? 100,
        [...new Set(filter.kinds)].sort((a, b) => a - b),
        filter.until === undefined ? null : [filter.until, filter.before_id],
        filter.include_aux ?? false,
      ]),
    )
    .digest("hex");
  return signed(key, {
    kind: 39007,
    tags: [
      ["d", `tw:1:${digest}`],
      ["h", channel],
      ["e", root.id],
    ],
    content: JSON.stringify({
      version: 1,
      direction: "older",
      has_more: cursor !== null,
      next_cursor: cursor,
      ...patch,
    }),
  });
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.unstubAllGlobals();
});
async function setup(
  answer: (
    filter: ReadFilter,
  ) => readonly RelayEvent[] | Promise<readonly RelayEvent[]>,
) {
  const requests: ReadFilter[][] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/session"))
      return Response.json({
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        relayUrl: origin,
      });
    const filters = JSON.parse(options?.body as string) as ReadFilter[];
    requests.push(filters);
    return Response.json((await Promise.all(filters.map(answer))).flat());
  });
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectBrokerTransport();
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  cleanup.push(owner.dispose);
  traffic.receive([root, roster(relay, channel, [viewer.pubkey])]);
  return {
    ...owner,
    traffic,
    requests,
    fetcher,
    view: owner.session.thread(channel, root.id),
    transport,
  };
}
it("matches the Rust binding vector and normalized authority, including IPv6 and ports", async () => {
  expect(
    await threadBinding(
      {
        thread_window: true,
        "#h": [channel],
        "#e": ["ab".repeat(32)],
        kinds: [9],
        limit: 50,
      },
      "https://Relay.Example.:443",
      "ab".repeat(32),
    ),
  ).toBe(
    "tw:1:5252322dfd797ddb1d5f1150acd4cf914b9fc09e39bcf3048d25aed514b3546d",
  );
  expect(threadAuthority("wss://RELAY.example.:8443")).toBe(
    "relay.example.:8443",
  );
  expect(threadAuthority("http://[::1]:3000")).toBe("[::1]:3000");
});
it("keeps the older binding when direction and root aux are explicit defaults", async () => {
  const filter: ReadFilter = {
    thread_window: true,
    "#h": [channel],
    "#e": ["ab".repeat(32)],
    kinds: [9],
    limit: 50,
  };
  const binding = (patch: Partial<ReadFilter>) =>
    threadBinding(
      { ...filter, ...patch },
      "https://relay.example",
      "ab".repeat(32),
    );
  // buzz-core thread_window::tests::binding_normalizes_defaults_and_binds_every_argument
  const expected =
    "tw:1:5252322dfd797ddb1d5f1150acd4cf914b9fc09e39bcf3048d25aed514b3546d";
  expect(await binding({ direction: "older", root_aux: true })).toBe(expected);
  expect(await binding({ root_aux: false })).not.toBe(expected);
  expect(await binding({ direction: "newer" })).not.toBe(expected);
});
it("binds a forward page that leaves root aux out as the relay's vector", async () => {
  const filter: ReadFilter = {
    thread_window: true,
    "#h": [channel],
    "#e": ["cd".repeat(32)],
    kinds: [9],
    limit: 50,
    direction: "newer",
    after: 5,
    after_id: "ef".repeat(32),
    root_aux: false,
  };
  // buzz-core thread_window::tests::binding_encodes_direction_cursor_and_root_aux_as_specified
  // (relay 90c63a56b). The digest is sha256 of the vector's canonical array,
  // computed outside this code base.
  const canonical = `["tw",1,"newer","relay.example","${"ab".repeat(32)}","${channel}","${"cd".repeat(32)}",50,100,[9],[5,"${"ef".repeat(32)}"],false,"root_aux:false"]`;
  expect(createHash("sha256").update(canonical).digest("hex")).toBe(
    "a417629c808147bf1592cab56498fd1137bda02e04450ba5aa6fc15d39d63c73",
  );
  expect(
    await threadBinding(filter, "https://relay.example", "ab".repeat(32)),
  ).toBe(
    "tw:1:a417629c808147bf1592cab56498fd1137bda02e04450ba5aa6fc15d39d63c73",
  );
});
describe("forward thread pages", () => {
  const at = { created_at: 10, id: "b".repeat(64) };
  const forward: ReadFilter = {
    thread_window: true,
    "#h": [channel],
    "#e": [root.id],
    kinds: [9],
    limit: 50,
    direction: "newer",
    after: at.created_at,
    after_id: at.id,
    root_aux: false,
  };
  // Independent encoder for a `newer` bound, as NIP-CW specifies it.
  const newerBound = (filter: ReadFilter, content: Record<string, unknown>) => {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "tw",
          1,
          "newer",
          "relay.example:8443",
          viewer.pubkey,
          channel,
          root.id,
          filter.limit,
          100,
          [9],
          filter.after === undefined ? null : [filter.after, filter.after_id],
          false,
          ...(filter.root_aux === false ? ["root_aux:false"] : []),
        ]),
      )
      .digest("hex");
    return signed(relay, {
      kind: 39007,
      tags: [
        ["d", `tw:1:${digest}`],
        ["h", channel],
        ["e", root.id],
      ],
      content: JSON.stringify({ version: 1, ...content }),
    });
  };
  const verify = (filter: ReadFilter, bound: RelayEvent) =>
    verifyThreadWindows([filter], [bound], origin, viewer.pubkey, relay.pubkey);
  it("accept a newer bound that moves forward in relay order", async () => {
    for (const next of [
      { created_at: 11, id: "f".repeat(64) },
      { created_at: 10, id: "a".repeat(64) },
      null,
    ])
      await expect(
        verify(
          forward,
          newerBound(forward, {
            direction: "newer",
            has_more: next !== null,
            next_cursor: next,
          }),
        ),
      ).resolves.toBeUndefined();
    const { after: _a, after_id: _b, ...head } = forward;
    await expect(
      verify(
        head,
        newerBound(head, {
          direction: "newer",
          has_more: true,
          next_cursor: at,
        }),
      ),
    ).resolves.toBeUndefined();
  });
  it("reject a direction mismatch either way", async () => {
    await expect(
      verify(
        forward,
        newerBound(forward, {
          direction: "older",
          has_more: false,
          next_cursor: null,
        }),
      ),
    ).rejects.toThrow(/bounds are invalid/);
    const older: ReadFilter = {
      thread_window: true,
      "#h": [channel],
      "#e": [root.id],
      kinds: [9],
      limit: 50,
    };
    await expect(
      verify(older, bounds(older, null, { direction: "newer" })),
    ).rejects.toThrow(/bounds are invalid/);
    // An older bound for a newer request misses its binding.
    await expect(verify(forward, bounds(older))).rejects.toThrow(
      /bounds are invalid/,
    );
  });
  it.each([
    { created_at: 9, id: "b".repeat(64) },
    { created_at: 10, id: "b".repeat(64) },
    { created_at: 10, id: "c".repeat(64) },
  ])("reject a newer cursor that does not advance (%o)", async (next) => {
    await expect(
      verify(
        forward,
        newerBound(forward, {
          direction: "newer",
          has_more: true,
          next_cursor: next,
        }),
      ),
    ).rejects.toThrow(/bounds are invalid/);
  });
  it.each([
    { next: { created_at: 11, id: "b".repeat(64) }, advances: false },
    { next: { created_at: 10, id: "b".repeat(64) }, advances: false },
    { next: { created_at: 10, id: "a".repeat(64) }, advances: false },
    { next: { created_at: 10, id: "c".repeat(64) }, advances: true },
    { next: { created_at: 9, id: "a".repeat(64) }, advances: true },
  ])(
    "keep the older advance check (next $next.created_at)",
    async ({ next, advances }) => {
      const older: ReadFilter = {
        thread_window: true,
        "#h": [channel],
        "#e": [root.id],
        kinds: [9],
        limit: 50,
        until: at.created_at,
        before_id: at.id,
      };
      const result = verify(older, bounds(older, next));
      if (advances) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow(/bounds are invalid/);
    },
  );
});
it("pages 303 tied replies newest-first, deduplicates live rows and repairs retained overlays", async () => {
  const rows = Array.from({ length: 303 }, (_, n) => reply(n));
  const newest = [...rows].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
  const late = message(author, channel, "live", 999, [
    ["e", root.id, "", "reply"],
  ]);
  const oldest = rows[0];
  const latest = newest[0];
  assert.exists(oldest);
  assert.exists(latest);
  let overlays: RelayEvent[] = [];
  const h = await setup((f) => {
    if (f.ids) return [root];
    expect(f.thread_window).toBe(true);
    expect(f.thread_cursor).toBeUndefined();
    const eligible = newest.filter(
      (e) =>
        f.until === undefined ||
        e.created_at < f.until ||
        (e.created_at === f.until && e.id > (f.before_id ?? "")),
    );
    const page = eligible.slice(0, f.limit);
    const last = page.at(-1);
    assert.exists(last);
    return [
      ...page,
      ...overlays.filter((e) =>
        e.tags.some(([k, id]) => k === "e" && page.some((r) => r.id === id)),
      ),
      bounds(
        f,
        eligible.length > page.length
          ? { created_at: last.created_at, id: last.id }
          : null,
      ),
    ];
  });
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    direction: "older",
    canLoadMore: true,
  });
  expect(new Set(h.view.snapshot().replies.map((e) => e.id))).toEqual(
    new Set(newest.slice(0, 10).map((e) => e.id)),
  );
  h.traffic.receive([late, latest]);
  while (h.view.snapshot().canLoadMore) await h.view.loadMore();
  expect(h.view.snapshot()).toMatchObject({ status: "ready", limited: false });
  expect(h.view.snapshot().replies.map((e) => e.id)).toEqual(
    [...rows, late]
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map((e) => e.id),
  );
  const windows = h.requests.filter(([f]) => f?.thread_window);
  expect(windows).toHaveLength(7);
  expect(windows.map(([f]) => f?.limit)).toEqual([10, 50, 50, 50, 50, 50, 50]);
  expect(windows.every(([f]) => f?.include_aux === true)).toBe(true);
  // The relay's window row allowlist rejects legacy diff kind 40008.
  expect(
    h.requests
      .filter(([f]) => f?.thread_window)
      .every(([f]) => !f?.kinds?.includes(40008)),
  ).toBe(true);
  expect(h.requests.every((filters) => filters.length === 1)).toBe(true);
  overlays = [
    signed(author, {
      kind: 40003,
      created_at: 1000,
      content: "edited oldest",
      tags: [["e", oldest.id]],
    }),
  ];
  const beforeRepair = h.requests.length;
  await h.view.refresh();
  const repair = h.requests.slice(beforeRepair);
  expect(repair).toHaveLength(8);
  expect(repair[0]).toEqual([{ ids: [root.id], "#h": [channel], limit: 1 }]);
  expect(repair.slice(1).every(([filter]) => filter?.thread_window)).toBe(true);
  expect(repair.slice(1).map(([filter]) => filter?.limit)).toEqual([
    10, 50, 50, 50, 50, 50, 50,
  ]);
  expect(repair.every((filters) => filters.length === 1)).toBe(true);
  expect(
    h.view.snapshot().replies.find((r) => r.id === oldest.id)?.content,
  ).toBe("edited oldest");
  const edit = overlays[0];
  assert.exists(edit);
  h.traffic.receive([
    signed(author, {
      kind: 5,
      content: "",
      created_at: 1001,
      tags: [["e", edit.id]],
    }),
  ]);
  expect(
    h.view.snapshot().replies.find((r) => r.id === oldest.id)?.content,
  ).toBe(oldest.content);
});
it("uses raw scan progress across empty pages without deriving cursors from rows", async () => {
  let pages = 0;
  const h = await setup((f) =>
    f.ids
      ? [root]
      : [
          bounds(
            f,
            ++pages === 1 ? { created_at: 20, id: "a".repeat(64) } : null,
          ),
        ],
  );
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
    replies: [],
  });
  await h.view.loadMore();
  expect(h.requests.at(-1)?.[0]).toMatchObject({
    until: 20,
    before_id: "a".repeat(64),
  });
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: false,
    replies: [],
  });
});
it("discards an old relay's 200 probe and restarts legacy with clean state", async () => {
  const old = reply(0),
    probeOnly = reply(100);
  const h = await setup((f) =>
    f.ids
      ? [root]
      : f.thread_window
        ? [probeOnly]
        : f.thread_cursor === undefined
          ? [old]
          : [],
  );
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    direction: "forward",
    canLoadMore: true,
  });
  expect(h.view.snapshot().replies.map((r) => r.id)).toEqual([old.id]);
  expect(h.requests.at(-1)).toHaveLength(2);
  expect(h.requests.at(-1)?.[1]).not.toHaveProperty("thread_window");
  expect(h.requests.at(-1)?.[1]).not.toHaveProperty("until");
  expect(h.requests.at(-1)?.[1]?.kinds).toContain(40008);
  await h.view.loadMore();
  expect(h.requests.at(-1)?.[1]).toMatchObject({
    thread_cursor: old.created_at,
    thread_cursor_id: old.id,
  });
  expect(h.view.snapshot().canLoadMore).toBe(false);
});
it("does not downgrade a later missing bound or admit its rows", async () => {
  let calls = 0;
  const first = reply(200),
    untrusted = reply(0);
  const h = await setup((f) =>
    f.ids
      ? [root]
      : ++calls === 1
        ? [first, bounds(f, { created_at: first.created_at, id: first.id })]
        : [untrusted],
  );
  await h.view.refresh();
  await h.view.loadMore();
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    direction: "older",
  });
  expect(h.view.snapshot().replies.map((r) => r.id)).toEqual([first.id]);
  expect(h.requests.every((fs) => fs.length === 1)).toBe(true);
});
it.each([
  ["wrong signer", (f: ReadFilter) => [bounds(f, null, {}, author)]],
  ["duplicate bounds", (f: ReadFilter) => [bounds(f), bounds(f)]],
  [
    "missing tags",
    (f: ReadFilter) => [
      signed(relay, { ...bounds(f), tags: bounds(f).tags.slice(0, 2) }),
    ],
  ],
  ["wrong binding", (f: ReadFilter) => [bounds({ ...f, limit: 49 })]],
  ["wrong version", (f: ReadFilter) => [bounds(f, null, { version: 2 })]],
  [
    "wrong direction",
    (f: ReadFilter) => [bounds(f, null, { direction: "newer" })],
  ],
  [
    "wrong flag type",
    (f: ReadFilter) => [bounds(f, null, { has_more: "false" })],
  ],
  [
    "missing cursor",
    (f: ReadFilter) => [bounds(f, null, { next_cursor: undefined })],
  ],
  [
    "bad timestamp",
    (f: ReadFilter) => [bounds(f, { created_at: -1, id: "a".repeat(64) })],
  ],
  [
    "bad ID",
    (f: ReadFilter) => [bounds(f, { created_at: 1, id: "A".repeat(64) })],
  ],
  ["contradiction", (f: ReadFilter) => [bounds(f, null, { has_more: true })]],
  [
    "bad signature",
    (f: ReadFilter) => [{ ...bounds(f), sig: "0".repeat(128) }],
  ],
] as const)(
  "rejects %s before shared session admission",
  async (_name, bad) => {
    const row = reply(0);
    const h = await setup((f) => (f.ids ? [root] : [row, ...bad(f)]));
    const observer = h.session.observe([
      { kinds: [9], "#h": [channel], limit: 50 },
    ]);
    await h.view.refresh();
    expect(h.view.snapshot().status).toBe("error");
    expect(h.view.snapshot().replies).toEqual([]);
    expect(observer.snapshot().events.some((e) => e.id === row.id)).toBe(false);
    expect(h.requests).toHaveLength(2);
    observer.dispose();
  },
);
it("keeps ambiguous empty access-scoped responses as errors, not fallback or exhaustion", async () => {
  const h = await setup((f) => (f.ids ? [root] : []));
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    canLoadMore: false,
  });
  expect(h.requests).toHaveLength(2);
});
it.each([401, 403, 429, 500])(
  "does not downgrade HTTP %s and can explicitly retry",
  async (status) => {
    const h = await setup((f) => (f.ids ? [root] : [bounds(f)]));
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
      const f = options?.body
        ? JSON.parse(options.body as string)[0]
        : undefined;
      return f?.thread_window
        ? Response.json({ error: "fixture failure" }, { status })
        : original(url, options);
    });
    vi.useFakeTimers();
    const pending = h.view.refresh();
    await vi.advanceTimersByTimeAsync(7000);
    await pending;
    if (status === 401 || status === 403) {
      expect(h.view.snapshot()).toMatchObject({
        status: "idle",
        root: undefined,
        replies: [],
      });
      expect(h.view.snapshot().error).toContain("no longer available");
    } else expect(h.view.snapshot().status).toBe("error");
    expect(h.requests).toHaveLength(1);
    vi.stubGlobal("fetch", original);
    if (status !== 401 && status !== 403) {
      await h.view.refresh();
      expect(h.view.snapshot().status).toBe("ready");
    }
    vi.useRealTimers();
  },
);

it("validates binding changes and non-advancing cursors on continuation before admission", async () => {
  const first = reply(100),
    older = reply(0);
  let corrupt = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (filter.until === undefined)
      return [
        first,
        bounds(filter, { created_at: first.created_at, id: first.id }),
      ];
    return [
      older,
      bounds(
        corrupt ? { ...filter, until: 1 } : filter,
        corrupt ? null : { created_at: first.created_at, id: first.id },
      ),
    ];
  });
  await h.view.refresh();
  await h.view.loadMore();
  expect(h.view.snapshot().status).toBe("error");
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([first.id]);
  corrupt = true;
  await h.view.loadMore();
  expect(h.view.snapshot().status).toBe("error");
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([first.id]);
});

it("refreshes retained strict pages after establishment while preserving live deletions", async () => {
  const one = reply(0),
    two = reply(60);
  let edited = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (filter.until === undefined)
      return [two, bounds(filter, { created_at: two.created_at, id: two.id })];
    return [
      one,
      ...(edited
        ? [
            signed(author, {
              kind: 40003,
              content: "repaired",
              created_at: 500,
              tags: [["e", one.id]],
            }),
          ]
        : []),
      bounds(filter),
    ];
  });
  await h.view.refresh();
  await h.view.loadMore();
  h.traffic.receive([
    signed(author, {
      kind: 5,
      created_at: 501,
      content: "",
      tags: [["e", two.id]],
    }),
  ]);
  edited = true;
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() =>
    expect(h.view.snapshot().replies[0]?.content).toBe("repaired"),
  );
  expect(h.view.snapshot().status).toBe("ready");
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
});

const at = (n: number) =>
  message(author, channel, `reply ${n}`, 10 * n, [["e", root.id, "", "reply"]]);
const cursorOf = (row: RelayEvent) => ({
  created_at: row.created_at,
  id: row.id,
});

it("refresh after establishment pages past its re-read until it reaches a retained reply", async () => {
  // Live replay covers minutes; a long disconnect can leave the newest page
  // short of the retained replies. Pages continue until one is reached.
  const one = at(1),
    two = at(2),
    three = at(3);
  let reconnected = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [one, bounds(filter, cursorOf(one))];
    if (filter.until === undefined)
      return [three, bounds(filter, cursorOf(three))];
    if (filter.until === three.created_at)
      return [two, bounds(filter, cursorOf(two))];
    return [one, bounds(filter, cursorOf(one))];
  });
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
    ]);
    expect(snapshot).toMatchObject({
      status: "ready",
      canLoadMore: true,
      limited: false,
    });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("replies the re-established stream replays before refresh are not overlap with the replies kept across the drop", async () => {
  const one = at(1),
    two = at(2),
    three = at(3);
  let reconnected = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [one, bounds(filter, cursorOf(one))];
    if (filter.until === undefined)
      return [three, two, bounds(filter, cursorOf(two))];
    return [one, bounds(filter, cursorOf(one))];
  });
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([three]);
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([
    one.id,
    three.id,
  ]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  // The newest page overlaps the replayed reply; the fill still pages on to
  // the reply kept across the drop.
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("refresh after establishment drops a retained reply it cannot reach within the page bound and settles on the range the reader had", async () => {
  const old = at(1);
  const fresh = Array.from({ length: 10 }, (_, index) => at(20 - index));
  let reconnected = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [old, bounds(filter, cursorOf(old))];
    const row =
      fresh[
        filter.until === undefined
          ? 0
          : fresh.findIndex(
              (candidate) => candidate.created_at === filter.until,
            ) + 1
      ];
    assert(row);
    return [row, bounds(filter, cursorOf(row))];
  });
  await h.view.refresh();
  reconnected = true;
  h.traffic.established(channel);
  // Ten pages never reached `old`: it goes rather than sitting below a gap.
  // The pages read stay, but the reader had one page, so the range settles
  // on one: a later refresh re-reads one page, not ten, and older pages
  // continue from its bound. The repair stays ready throughout, so wait on
  // its rows.
  const shown = fresh.map((row) => row.id).reverse();
  await vi.waitFor(() => {
    expect(h.view.snapshot().replies.map((row) => row.id)).toEqual(shown);
    expect(h.view.snapshot()).toMatchObject({
      status: "ready",
      limited: false,
      canLoadMore: true,
    });
  });
  let before = h.requests.length;
  await h.view.refresh();
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
  ]);
  expect(h.requests.at(-1)?.[0]).not.toHaveProperty("until");
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual(shown);
  before = h.requests.length;
  await h.view.loadMore();
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [
      {
        thread_window: true,
        until: fresh[0]?.created_at,
        before_id: fresh[0]?.id,
      },
    ],
  ]);
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
    limited: false,
  });
});

/** Reconnect pages: `four` and `three` on the newest page, then `two`, then `one`. */
const reconnectPages =
  (reconnected: () => boolean) =>
  (filter: ReadFilter): readonly RelayEvent[] => {
    const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
    if (filter.ids) return [root];
    if (!reconnected()) return [one, bounds(filter, cursorOf(one))];
    if (filter.until === undefined)
      return [four, three, bounds(filter, cursorOf(three))];
    if (filter.until === three.created_at)
      return [two, bounds(filter, cursorOf(two))];
    return [one, bounds(filter, cursorOf(one))];
  };

it("a refresh completing while the stream is down keeps the replies held across the drop for the establishment refresh to reach", async () => {
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  const h = await setup(reconnectPages(() => reconnected));
  await h.view.refresh();
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  // A user refresh while the stream is down re-reads the same page. Were it
  // to clear the drop-time snapshot, the replayed reply would be the
  // establishment refresh's overlap.
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("an establishment refresh queued before a drop runs as a plain refresh, keeping the replies held for the next establishment", async () => {
  // A renewal EOSE while a read runs queues an establishment refresh. Run as
  // one after the drop, it would clear the drop-time snapshot while offline.
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  let gate: Promise<void> | undefined;
  let release = () => {};
  const pages = reconnectPages(() => reconnected);
  const h = await setup(async (filter) => {
    const held = filter.thread_window ? gate : undefined;
    if (held) gate = undefined;
    await held;
    return pages(filter);
  });
  h.traffic.state({ status: "connected", routes: [] });
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const refreshing = h.view.refresh();
  let queued = 0;
  try {
    await vi.waitFor(() => expect(gate).toBeUndefined());
    queued = h.requests.length;
    h.traffic.established(channel);
    h.traffic.state({ status: "retrying", routes: [] });
  } finally {
    release();
  }
  await refreshing;
  await vi.waitFor(() => {
    expect(h.requests.slice(queued)).toMatchObject([
      [{ ids: [root.id] }],
      [{ thread_window: true }],
    ]);
    expect(h.view.snapshot().status).toBe("ready");
  });
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("a thread view opened while the stream is down keeps its first read for the establishment refresh to reach", async () => {
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  const h = await setup(reconnectPages(() => reconnected));
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  h.view.dispose();
  const view = h.session.thread(channel, root.id);
  cleanup.push(view.dispose);
  await view.refresh();
  expect(view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("a thread view opened before the first connection keeps its first read for the establishment refresh to reach", async () => {
  // Replies the first connection replays before EOSE are newer than any gap
  // between the pre-connect read and them, not overlap with it.
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  const h = await setup(reconnectPages(() => reconnected));
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("keeps a root edit from a window that answers before an unretained root", async () => {
  const row = reply(0);
  const edit = signed(author, {
    kind: 40003,
    created_at: 50,
    content: "edited root",
    tags: [["e", root.id]],
  });
  // Like the session's verified reader, each answer is admitted as it
  // resolves: an edit whose target is not known yet is dropped.
  const known = new Set<string>();
  let held: Promise<void> | undefined;
  let release = () => {};
  let rootPending = false;
  const reader = {
    async read(filters: readonly ReadFilter[]) {
      const [f] = filters;
      assert.exists(f);
      let events: RelayEvent[];
      if (f.ids?.includes(root.id)) {
        rootPending = true;
        await held;
        rootPending = false;
        events = [root];
      } else if (f.ids) events = [row];
      else if (f.thread_window) events = [row, edit, bounds(f)];
      else events = [];
      const admitted = events.filter(
        (event) =>
          event.kind !== 40003 ||
          event.tags.every(([name, id]) => name !== "e" || known.has(id ?? "")),
      );
      for (const event of admitted) known.add(event.id);
      return admitted;
    },
  };
  // The root answers only once the test releases it, after any read started
  // alongside it has answered.
  const refresh = async (view: { refresh(): Promise<void> }) => {
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshing = view.refresh();
    await vi.waitFor(() => expect(rootPending).toBe(true));
    release();
    await refreshing;
    held = undefined;
  };
  const open = (resume?: ThreadResume) =>
    createThreadView({
      channelId: channel,
      messageId: root.id,
      relayAuthor: relay.pubkey,
      reader,
      seed: undefined,
      resume,
      local: undefined,
      canAccess: () => true,
      visible: (events) => events,
      notify: () => {},
    });
  const first = open();
  await first.view.refresh();
  const resume = first.resume();
  first.view.dispose();
  assert(typeof resume === "object");
  // The resume holds the root; the shared evidence no longer does.
  known.clear();
  const reopened = open(resume);
  await refresh(reopened.view);
  expect(reopened.view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: root.id, content: "edited root" },
  });
  // A retarget makes this ordinary view exact; its reader still admits.
  await expect(
    reopened.view.retarget(row.id, new AbortController().signal),
  ).resolves.toBe("selected");
  reopened.purge(true);
  known.clear();
  await refresh(reopened.view);
  expect(reopened.view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: root.id, content: "edited root" },
  });
});

it("stops an exact view's overlapped window when the root is missing", async () => {
  let rootReads = 0;
  let window:
    | { filter: ReadFilter; signal: AbortSignal | undefined }
    | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = {
    async read(
      filters: readonly ReadFilter[],
      settings?: { signal?: AbortSignal },
    ) {
      const [f] = filters;
      assert.exists(f);
      if (f.ids) return ++rootReads === 1 ? [root] : [];
      if (!f.thread_window) return [];
      window = { filter: f, signal: settings?.signal };
      await held;
      return [reply(0), bounds(f)];
    },
  };
  const view = createThreadView({
    channelId: channel,
    messageId: root.id,
    relayAuthor: relay.pubkey,
    reader,
    seed: undefined,
    local: undefined,
    exact: true,
    canAccess: () => true,
    visible: (events) => events,
    notify: () => {},
  });
  // The target read finds the root; the root read that follows does not.
  const loading = view.view.refresh();
  await vi.waitFor(() => expect(rootReads).toBe(2));
  await loading;
  expect(view.view.snapshot()).toMatchObject({ status: "error" });
  // The window read started with the root read and is stopped.
  expect(window?.filter.thread_window).toBe(true);
  expect(window?.signal?.aborted).toBe(true);
  release();
});

it("revalidates a missing strict root before repair and preserves tombstones on retry", async () => {
  const row = reply(0);
  let missing = false;
  const h = await setup((filter) =>
    filter.ids ? (missing ? [] : [root]) : [row, bounds(filter)],
  );
  await h.view.refresh();
  h.traffic.receive([
    signed(author, {
      kind: 5,
      created_at: 500,
      content: "",
      tags: [["e", row.id]],
    }),
  ]);
  missing = true;
  const before = h.requests.length;
  await h.view.refresh();
  expect(h.requests.slice(before)).toEqual([
    [{ ids: [root.id], "#h": [channel], limit: 1 }],
  ]);
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    root: undefined,
    replies: [],
    canLoadMore: false,
  });
  expect(h.view.snapshot().error).toContain(
    "original thread message is unavailable",
  );
  missing = false;
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: root.id },
    replies: [],
    canLoadMore: false,
  });
});

it.each([
  ["dispose", "root"],
  ["clear", "root"],
  ["revoke", "root"],
  ["dispose", "window"],
  ["clear", "window"],
  ["revoke", "window"],
])("fences %s during a held strict %s read", async (action, phase) => {
  let release!: (events: readonly RelayEvent[]) => void;
  const held = new Promise<readonly RelayEvent[]>((resolve) => {
    release = resolve;
  });
  let pending: ReadFilter | undefined;
  const h = await setup((filter) => {
    if (phase === "window" && filter.ids) return [root];
    pending = filter;
    return held;
  });
  const loading = h.view.refresh();
  try {
    await vi.waitFor(() => expect(pending).toBeDefined());
    if (action === "dispose") h.dispose();
    else if (action === "clear") await h.clearCache();
    else h.traffic.receive([roster(relay, channel, [], 1_700_000_001)]);
  } finally {
    release(
      phase === "root" ? [root] : pending ? [reply(0), bounds(pending)] : [],
    );
  }
  await loading;
  expect(h.view.snapshot().replies).toEqual([]);
  expect(h.view.snapshot().root).toBeUndefined();
  expect(h.requests).toHaveLength(phase === "root" ? 1 : 2);
});

it.each([8_210_266_876_800, Number.MAX_SAFE_INTEGER])(
  "rejects signed timestamps outside chrono's domain (%s) before admission",
  async (created_at) => {
    const row = reply(0);
    const h = await setup((filter) =>
      filter.ids ? [root] : [row, bounds(filter, { created_at, id: row.id })],
    );
    const observer = h.session.observe([
      { kinds: [9], "#h": [channel], limit: 50 },
    ]);
    await h.view.refresh();
    expect(h.view.snapshot().status).toBe("error");
    expect(
      observer.snapshot().events.some((event) => event.id === row.id),
    ).toBe(false);
    expect(h.requests).toHaveLength(2);
    observer.dispose();
  },
);
it("accepts and echoes chrono's inclusive maximum cursor", async () => {
  const cursor = { created_at: 8_210_266_876_799, id: "a".repeat(64) };
  const h = await setup((filter) =>
    filter.ids
      ? [root]
      : [bounds(filter, filter.until === undefined ? cursor : null)],
  );
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
  });
  await h.view.loadMore();
  expect(h.requests.at(-1)?.[0]).toMatchObject({
    until: cursor.created_at,
    before_id: cursor.id,
  });
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: false,
  });
});

// A view's window is its committed pages, in the relay's full order. Rows
// past its cursor belong to the next older page, whatever read carried them.
const replyAt = (content: string, created_at: number) =>
  message(author, channel, content, created_at, [["e", root.id, "", "reply"]]);
const newestPage = Array.from({ length: 10 }, (_, n) =>
  replyAt(`head ${n}`, 1000 + n),
);
// Signed once: 2,000 replies older than the newest page's cursor.
const olderScan = Array.from({ length: 2000 }, (_, n) =>
  replyAt(`older ${n}`, 2 + Math.floor(n / 4)),
);
const pageCursor = cursorOf(newestPage[0] as RelayEvent);
const scanOrder = [...olderScan].sort(
  (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
);
const headOnly = (filter: ReadFilter) =>
  filter.ids
    ? [root]
    : filter.thread_window
      ? [...newestPage, bounds(filter, pageCursor)]
      : scanOrder
          .filter(
            (e) =>
              filter.until === undefined ||
              e.created_at < filter.until ||
              (e.created_at === filter.until &&
                e.id > (filter.before_id ?? "")),
          )
          .slice(0, filter.limit);

it.each(["live traffic", "a session readPage scan"])(
  "keeps a view ready with the same rows when %s carries 2,000 replies older than its cursor",
  async (source) => {
    const h = await setup(headOnly);
    await h.view.refresh();
    const before = h.view.snapshot().replies;
    expect(before).toHaveLength(10);
    if (source === "live traffic") h.traffic.receive(olderScan);
    // A plugin pages the scan; the relay serves at most 500 per read.
    else
      for (let cursor: ThreadCursor | undefined, n = 0; n < 4; n++) {
        const { events } = await h.session.readPage([
          {
            kinds: [9],
            "#h": [channel],
            "#e": [root.id],
            limit: 500,
            ...(cursor
              ? { until: cursor.created_at, before_id: cursor.id }
              : {}),
          },
        ]);
        cursor = events.at(-1);
      }
    expect(h.view.snapshot()).toMatchObject({
      status: "ready",
      error: undefined,
      limited: false,
    });
    expect(h.view.snapshot().replies).toBe(before);
    const live = replyAt("live", 2000);
    const held = newestPage[3] as RelayEvent;
    h.traffic.receive([live]);
    h.traffic.receive([
      signed(author, {
        kind: 5,
        content: "",
        created_at: 2001,
        tags: [["e", held.id]],
      }),
    ]);
    const ids = h.view.snapshot().replies.map((row) => row.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(held.id);
    expect(ids).toHaveLength(10);
  },
);

it("admits a reply at the cursor's second only when its id is at or below the cursor's, and any legacy diff", async () => {
  const tied = Array.from({ length: 3 }, (_, n) =>
    replyAt(`tied ${n}`, 50),
  ).sort((a, b) => a.id.localeCompare(b.id));
  const [low, mid, high] = tied as [RelayEvent, RelayEvent, RelayEvent];
  const newer = replyAt("newer", 60);
  // Older pages run `created_at DESC, id ASC`: the cursor ends mid-second.
  const h = await setup((filter) =>
    filter.ids ? [root] : [newer, mid, bounds(filter, cursorOf(mid))],
  );
  await h.view.refresh();
  // Strict pages never return a legacy diff, so one past the cursor stays.
  const diff = signed(author, {
    kind: 40008,
    content: "diff",
    created_at: 40,
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
  });
  h.traffic.receive([low, high, diff]);
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual(
    [diff, low, mid, newer].map((row) => row.id),
  );
});

it("skips an oversized replay into a view with no page yet, then commits its first page", async () => {
  const thread = createThreadView({
    channelId: channel,
    messageId: root.id,
    relayAuthor: relay.pubkey,
    reader: {
      read: async ([filter]) => (filter ? headOnly(filter) : []),
    },
    seed: root,
    local: undefined,
    canAccess: () => true,
    visible: (events) => events,
    notify: (listener) => listener(),
  });
  try {
    thread.receive([...olderScan, ...newestPage]);
    expect(thread.view.snapshot()).toMatchObject({ error: undefined });
    await thread.view.refresh();
    expect(thread.view.snapshot()).toMatchObject({
      status: "ready",
      error: undefined,
      canLoadMore: true,
    });
    expect(thread.view.snapshot().replies.map((row) => row.id)).toEqual(
      newestPage.map((row) => row.id),
    );
  } finally {
    thread.view.dispose();
  }
});

it("admits a live reply inside the pages a refresh has read past the committed cursor", async () => {
  const one = at(1),
    two = at(2),
    three = at(3),
    four = at(4);
  // Its timestamp places it between two pages the refresh has already read.
  const late = message(author, channel, "late", 25, [
    ["e", root.id, "", "reply"],
  ]);
  let reconnected = false;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => (release = resolve));
  let reading!: () => void;
  const reached = new Promise<void>((resolve) => (reading = resolve));
  const h = await setup(async (filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [three, bounds(filter, cursorOf(three))];
    if (filter.until === undefined)
      return [four, bounds(filter, cursorOf(four))];
    if (filter.until === four.created_at)
      return [two, bounds(filter, cursorOf(two))];
    reading();
    await paused;
    return [one, bounds(filter)];
  });
  await h.view.refresh();
  reconnected = true;
  h.traffic.established(channel);
  await reached;
  h.traffic.receive([late]);
  release();
  await vi.waitFor(() => {
    expect(h.view.snapshot()).toMatchObject({ status: "ready" });
    expect(h.view.snapshot().replies.map((row) => row.id)).toContain(one.id);
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).toContain(late.id);
});
it("keeps a live deletion of a row a refresh reads past the committed cursor", async () => {
  // The held reply is gone after the drop, so the refresh pages past the
  // window it had, to the end of the thread.
  const one = at(1),
    two = at(2),
    three = at(3),
    four = at(4);
  let reconnected = false;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => (release = resolve));
  let reading!: () => void;
  const reached = new Promise<void>((resolve) => (reading = resolve));
  const h = await setup(async (filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [three, bounds(filter, cursorOf(three))];
    if (filter.until === undefined)
      return [four, bounds(filter, cursorOf(four))];
    if (filter.until === four.created_at)
      return [two, bounds(filter, cursorOf(two))];
    reading();
    await paused;
    return [one, bounds(filter)];
  });
  await h.view.refresh();
  reconnected = true;
  h.traffic.established(channel);
  await reached;
  h.traffic.receive([
    signed(author, {
      kind: 5,
      content: "",
      created_at: 500,
      tags: [["e", two.id]],
    }),
  ]);
  release();
  await vi.waitFor(() => {
    expect(h.view.snapshot()).toMatchObject({ status: "ready" });
    expect(h.view.snapshot().replies.map((row) => row.id)).toContain(one.id);
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).not.toContain(two.id);
});
