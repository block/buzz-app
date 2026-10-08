// Relay arrival order is opaque to the app: no author time, lexical ID or
// issue order may decide which read operand survives or what it covers.
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { deferredSidebar, sidebarFixture, sidebarRow } from "./sidebar-testing";
import type { ReadIntent } from "./sidebar-api";
import { keypair, message, metadata, roster } from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const timeline = { kind: "channel", channelId: channel } as const;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});
const viewer = keypair(),
  peer = keypair(),
  relay = keypair();
/** One session over `bff`; a second call over the same fixture is a reload. */
function setup(bff = sidebarFixture()) {
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      sidebarApi: bff.api,
      query: async () => [],
      media: () => undefined,
      subscribe(c) {
        live = c;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { sidebarStorage: bff.storage },
  );
  cleanups.push(owner.dispose);
  live.receive([
    roster(relay, channel, [viewer.pubkey], 10),
    metadata(relay, channel, channel, 10),
  ]);
  const unread = owner.session.unread;
  return {
    bff,
    peer,
    unread,
    dispose: owner.dispose,
    emit: (events: readonly RelayEvent[]) => live.receive(events),
  };
}
type Harness = ReturnType<typeof setup>;
const post = (h: Harness, createdAt: number) =>
  message(h.peer, channel, `authored ${createdAt}`, createdAt);
const sent = (h: Harness) =>
  h.bff.api.write.mock.calls.flatMap(([intents]) => intents);
const anchors = (intents: readonly ReadIntent[]) =>
  intents.map((intent) => intent.message_id).sort();
const pendingAnchors = (h: Harness) =>
  anchors(h.bff.journal().pending.map((p) => p.intent));
const through = (id: string): ReadIntent => ({
  type: "mark_through",
  target: { channel_id: channel },
  message_id: id,
});
/** Relay verdicts for `events`, retained so `attention` has an answer. */
async function unreadVerdicts(h: Harness, events: readonly RelayEvent[]) {
  for (const event of events) {
    h.bff.messages.set(event.id, {
      message_id: event.id,
      status: "unread",
      reason: "mention",
    });
    cleanups.push(
      h.unread.subscribe(
        { kind: "message", channelId: channel, messageId: event.id },
        () => {},
      ),
    );
  }
  await h.unread.refresh();
  for (const event of events)
    expect(h.unread.attention(channel, event.id).unread).toBe(true);
}
function holdWrites({ bff }: { bff: Harness["bff"] }) {
  const held = deferredSidebar<void>();
  const write = bff.api.write.getMockImplementation();
  if (!write) throw new Error("Missing write fixture");
  bff.api.write.mockImplementation(async (intents, signal) => {
    await held.promise;
    return write(intents, signal);
  });
  cleanups.push(() => held.resolve());
  return held;
}
/** Fail only the next save that admits new pending reads; other saves pass. */
function failNextAdmission(h: Harness) {
  const save = h.bff.storage.update;
  let fired = false;
  vi.spyOn(h.bff.storage, "update").mockImplementation(async (change) => {
    const before = h.bff.journal().pending.length;
    if (
      !fired &&
      change(structuredClone(h.bff.journal())).pending.length > before
    ) {
      fired = true;
      throw new Error("disk full");
    }
    return save(change);
  });
  return () => fired;
}
/** Block the next save that admits new pending reads until released. */
function holdNextAdmission(h: Harness) {
  const save = h.bff.storage.update,
    gate = deferredSidebar<void>(),
    entered = deferredSidebar<void>();
  let held = false;
  vi.spyOn(h.bff.storage, "update").mockImplementation(async (change) => {
    const before = h.bff.journal().pending.length;
    if (
      !held &&
      change(structuredClone(h.bff.journal())).pending.length > before
    ) {
      held = true;
      entered.resolve();
      await gate.promise;
    }
    return save(change);
  });
  cleanups.push(() => gate.resolve());
  return { entered: entered.promise, release: () => gate.resolve() };
}
const batches = (h: Harness) =>
  h.bff.api.write.mock.calls.map(([intents]) => intents.length);

it.each([
  ["a future-dated anchor", 1000, 500],
  ["an anchor ahead of an old-authored late arrival", 500, 100],
])(
  "%s covers only its own ID while saving, pending and applied",
  async (_case, anchorAt, otherAt) => {
    const h = setup();
    const anchor = post(h, anchorAt),
      other = post(h, otherAt);
    h.emit([anchor, other]);
    await unreadVerdicts(h, [anchor, other]);
    const held = holdWrites(h),
      admission = holdNextAdmission(h);
    const marking = h.unread.markThrough(timeline, anchor.id);
    await admission.entered; // saving: the durable admission is blocked
    expect(h.unread.attention(channel, anchor.id).unread).toBe(false);
    expect(h.unread.attention(channel, other.id).unread).toBe(true);
    admission.release();
    await marking;
    await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
    // pending: saved, its write not yet acknowledged
    expect(h.unread.attention(channel, anchor.id).unread).toBe(false);
    expect(h.unread.attention(channel, other.id).unread).toBe(true);
    held.resolve();
    await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
    expect(h.unread.attention(channel, other.id).unread).toBe(true);
  },
);

it.each(["older-authored first", "newer-authored first"] as const)(
  "distinct unsent anchors in one context all survive and retry after a lost ack (%s)",
  async (order) => {
    const h = setup();
    const newer = post(h, 20),
      older = post(h, 10);
    h.emit([newer, older]);
    // The relay applied the first write, but its acknowledgement was lost.
    h.bff.api.write.mockRejectedValueOnce(new Error("acknowledgement lost"));
    const first = order === "older-authored first" ? older : newer;
    const second = first === older ? newer : older;
    await h.unread.markThrough(timeline, first.id);
    await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.unread.sync().writeError).toBeDefined());
    await h.unread.markThrough(timeline, second.id);
    expect(pendingAnchors(h)).toEqual([newer.id, older.id].sort());
    await h.unread.retrySync();
    await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
    const retried = h.bff.api.write.mock.calls.slice(1).flatMap(([i]) => i);
    expect(anchors(retried)).toEqual([newer.id, older.id].sort());
  },
);

it("dwell durably admits all 128 eligible observed IDs together, then sends wire batches of 100 and 28", async () => {
  const h = setup();
  const seen = Array.from({ length: 128 }, (_, i) => post(h, 1000 - i));
  h.emit(seen);
  const reading = h.unread.reading(channel);
  cleanups.push(reading.dispose);
  const held = holdWrites(h);
  await reading.observe(seen.map((e) => e.id));
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(pendingAnchors(h)).toEqual(seen.map((e) => e.id).sort());
  held.resolve();
  await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
  expect(batches(h)).toEqual([100, 28]);
  expect(anchors(sent(h))).toEqual(seen.map((e) => e.id).sort());
  expect(sent(h)).toEqual(
    expect.arrayContaining(seen.map((e) => through(e.id))),
  );
});

it.each([
  [1, [1]],
  [128, [100, 28]],
])(
  "a failed dwell save observes nothing; the same %i IDs are admitted on the next observe",
  async (count, expected) => {
    const h = setup();
    const seen = Array.from({ length: count }, (_, i) => post(h, 1000 - i));
    h.emit(seen);
    const reading = h.unread.reading(channel);
    cleanups.push(reading.dispose);
    const fired = failNextAdmission(h);
    // A failed save propagates; it is never reported as a successful read.
    await expect(reading.observe(seen.map((e) => e.id))).rejects.toThrow(
      "disk full",
    );
    expect(fired()).toBe(true);
    expect(h.bff.journal().pending).toEqual([]);
    expect(h.bff.api.write).not.toHaveBeenCalled();
    await reading.observe(seen.map((e) => e.id));
    await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
    await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
    expect(batches(h)).toEqual(expected);
    expect(anchors(sent(h))).toEqual(seen.map((e) => e.id).sort());
  },
);

it("an observed ID that could not be resolved stays eligible for a later observe", async () => {
  const h = setup();
  const known = post(h, 10),
    late = post(h, 5);
  h.emit([known]);
  const reading = h.unread.reading(channel);
  cleanups.push(reading.dispose);
  await reading.observe([known.id, late.id]);
  await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
  expect(sent(h)).toEqual([through(known.id)]);
  h.emit([late]);
  await reading.observe([known.id, late.id]);
  await vi.waitFor(() => expect(sent(h)).toHaveLength(2));
  expect(sent(h)[1]).toEqual(through(late.id));
});

it("applied exact-ID coverage survives a summary refresh that started before the write, until fenced message evidence arrives", async () => {
  const h = setup();
  const anchor = post(h, 20),
    other = post(h, 10);
  h.emit([anchor, other]);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { unread: { status: "exact", value: 2 } }),
  );
  await unreadVerdicts(h, [anchor, other]);
  // Hold one context read whose verdicts were captured before the write.
  const contexts = h.bff.api.contexts.getMockImplementation();
  if (!contexts) throw new Error("Missing contexts fixture");
  const stale = deferredSidebar<void>();
  cleanups.push(() => stale.resolve());
  h.bff.api.contexts.mockImplementationOnce(async (queries, signal) => {
    const answer = await contexts(queries, signal);
    await stale.promise;
    return answer;
  });
  const refreshing = h.unread.refresh();
  await vi.waitFor(() =>
    expect(h.bff.api.contexts.mock.calls.length).toBeGreaterThan(1),
  );
  const flickers: boolean[] = [];
  cleanups.push(
    h.unread.subscribe(timeline, () =>
      flickers.push(h.unread.attention(channel, anchor.id).unread),
    ),
  );
  await h.unread.markThrough(timeline, anchor.id);
  await vi.waitFor(() => expect(h.bff.journal().pending).toEqual([]));
  // The relay has applied it: later requests answer read.
  h.bff.messages.set(anchor.id, { message_id: anchor.id, status: "read" });
  stale.resolve();
  await refreshing;
  await h.unread.refresh();
  expect(flickers).not.toContain(true);
  expect(h.unread.attention(channel, anchor.id).unread).toBe(false);
  expect(h.unread.attention(channel, other.id).unread).toBe(true);
});

it("a channel badge is not hidden by a local mark; the relay summary clears it", async () => {
  const h = setup();
  // Arrival anchor and author-max activity name different messages.
  const anchor = "a".repeat(64);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, {
      unread: { status: "exact", value: 2 },
      latest_message_id: anchor,
      latest_message_at: 900,
    }),
  );
  await h.unread.ensure();
  expect(h.unread.snapshot(timeline).unreadVisible).toBe(true);
  const held = holdWrites(h);
  await h.unread.markChannelRead(channel);
  await vi.waitFor(() => expect(h.bff.api.write).toHaveBeenCalled());
  expect(sent(h)).toEqual([
    { type: "mark_channel_read", channel_id: channel, message_id: anchor },
  ]);
  expect(h.unread.snapshot(timeline).unreadVisible).toBe(true);
  h.bff.rows.set(
    channel,
    sidebarRow(channel, { latest_message_id: anchor, latest_message_at: 900 }),
  );
  held.resolve();
  await vi.waitFor(() =>
    expect(h.unread.snapshot(timeline).unreadVisible).toBe(false),
  );
});

it("a legacy saved operand carrying createdAt is retained and delivered beside a skewed later anchor; only exact duplicates dedupe", async () => {
  const bff = sidebarFixture();
  // Saved by the old client: anchored by author time, which the new one ignores.
  // Journal semantics only; IndexedDB normalization is Meli's integration case.
  const draft = setup(bff),
    anchor = post(draft, 900),
    late = post(draft, 10);
  draft.dispose();
  await bff.storage.update(
    () =>
      ({
        pending: [
          { id: "legacy-1", intent: through(anchor.id), createdAt: 900 },
        ],
        manual: [],
      }) as never,
  );
  const held = holdWrites({ bff });
  const h = setup(bff);
  h.emit([anchor, late]);
  void h.unread.ensure(); // first demand after boot flushes the journal
  await vi.waitFor(() => expect(bff.api.write).toHaveBeenCalled());
  await h.unread.markThrough(timeline, late.id);
  await h.unread.markThrough(timeline, anchor.id);
  expect(pendingAnchors(h)).toEqual([anchor.id, late.id].sort());
  held.resolve();
  await vi.waitFor(() => expect(bff.journal().pending).toEqual([]));
  expect(anchors(sent(h))).toEqual([anchor.id, late.id].sort());
});

it.each([
  ["one anchor", [20]],
  ["two author-skewed anchors", [20, 10]],
])(
  "every anchor whose outcome came back unknown is retried after a reload (%s)",
  async (_case, times) => {
    const bff = sidebarFixture();
    const first = setup(bff);
    const posts = times.map((t) => post(first, t));
    first.emit(posts);
    bff.api.write.mockImplementation(async (intents) =>
      intents.map(() => ({
        status: "unknown" as const,
        retryable: true as const,
      })),
    );
    for (const p of posts) await first.unread.markThrough(timeline, p.id);
    await vi.waitFor(() => expect(bff.api.write).toHaveBeenCalled());
    first.dispose();
    bff.api.write.mockReset();
    bff.api.write.mockImplementation(async (intents) =>
      intents.map(() => ({ status: "applied" as const })),
    );
    const h = setup(bff);
    await h.unread.ensure(); // first demand after boot flushes the journal
    await vi.waitFor(() => expect(bff.journal().pending).toEqual([]));
    expect(anchors(sent(h))).toEqual(posts.map((p) => p.id).sort());
  },
);
