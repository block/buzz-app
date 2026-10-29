import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "./events";
import {
  createReminders,
  parseNotBefore,
  parseReminder,
  type ReminderIntent,
} from "./reminders";

const event = (tags: string[][]): RelayEvent =>
  ({
    id: "e1",
    pubkey: "p",
    kind: 30300,
    created_at: 5,
    tags,
    content: "",
    sig: "",
  }) as unknown as RelayEvent;
const tagged = event([
  ["d", "abc"],
  ["not_before", "100"],
]);
const target = {
  eventId: "m",
  channelId: "c",
  preview: "hi",
  authorPubkey: "a",
};

describe("NIP-ER reminder parsing", () => {
  it("accepts target and note-only reminders in every status", () => {
    expect(parseReminder(tagged, { target, status: "pending" })).toEqual({
      id: "abc",
      eventId: "e1",
      createdAt: 5,
      status: "pending",
      notBefore: 100,
      target,
    });
    expect(
      parseReminder(tagged, { note: "call", status: "pending" })?.note,
    ).toBe("call");
    for (const status of ["done", "cancelled"] as const)
      expect(parseReminder(tagged, { target, status })?.status).toBe(status);
    expect(
      parseReminder(tagged, { target, status: "pending", extra: 1 }),
    ).toBeDefined();
  });

  it("fails closed on off-shape plaintext", () => {
    for (const content of [
      null,
      "text",
      [],
      { target, status: "snoozed" },
      { status: "pending" },
      { note: "", status: "pending" },
      { note: 3, status: "pending" },
      { target: { ...target, eventId: 1 }, status: "pending" },
      { target: { id: "x", a: "y", relays: [] }, status: "pending" },
    ])
      expect(parseReminder(tagged, content)).toBeUndefined();
    expect(
      parseReminder(event([]), { target, status: "pending" }),
    ).toBeUndefined();
  });

  it("mirrors the relay's not_before validator", () => {
    expect(parseNotBefore("1700000000")).toBe(1_700_000_000);
    expect(parseNotBefore("0")).toBe(0);
    for (const raw of [
      "01",
      "1e9",
      "-1",
      "1.5",
      "",
      undefined,
      "9007199254740992",
    ])
      expect(parseNotBefore(raw)).toBeUndefined();
  });
});

const viewer = "v";
const wire = (
  id: string,
  createdAt: number,
  status: string,
  d = "r1",
): RelayEvent =>
  ({
    id,
    pubkey: viewer,
    kind: 30300,
    created_at: createdAt,
    tags: [["d", d]],
    content: JSON.stringify({ target, status }),
    sig: "",
  }) as unknown as RelayEvent;

function harness(history: RelayEvent[] = []) {
  const signed: ReminderIntent[] = [];
  let fail = false;
  let query = () => Promise.resolve(history);
  const model = createReminders({
    viewer,
    signal: new AbortController().signal,
    host: {
      decode: async (events) =>
        events.map((e) => ({ eventId: e.id, content: JSON.parse(e.content) })),
      sign: async (intent) => {
        signed.push(intent);
        return wire(
          `e${signed.length}`,
          intent.createdAt,
          intent.content.status,
          intent.d,
        );
      },
    },
    query: () => query(),
    publish: async () => {
      await Promise.resolve();
      if (fail) {
        fail = false;
        throw new Error("rejected");
      }
    },
  });
  return {
    model,
    signed,
    failNextPublish() {
      fail = true;
    },
    setHistory(events: RelayEvent[]) {
      query = () => Promise.resolve(events);
    },
    head: () =>
      model.capability.snapshot().reminders.find((r) => r.id === "r1"),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reminder writes and reconciliation", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the relay's winner whichever order versions arrive in", async () => {
    for (const order of [
      ["ffff", "0000"],
      ["0000", "ffff"],
    ]) {
      const { model, head } = harness();
      for (const id of order)
        model.receive([wire(id, 100, id === "0000" ? "pending" : "done")]);
      await settle();
      expect(head()).toMatchObject({ eventId: "0000", status: "pending" });
      model.receive([wire("aaaa", 99, "cancelled")]);
      await settle();
      expect(head()?.eventId).toBe("0000");
    }
  });

  it("adopts the relay's equal-time winner on refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 50_000 });
    const h = harness([wire("e0", 40, "pending")]);
    await h.model.capability.refresh();
    await h.model.capability.complete("r1");
    expect(h.head()).toMatchObject({ eventId: "e1", createdAt: 50 });
    h.setHistory([wire("0000", 50, "pending")]);
    await h.model.capability.refresh();
    expect(h.head()).toMatchObject({ eventId: "0000", status: "pending" });
  });

  it("runs overlapping Done and Snooze one after the other", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 100_000 });
    const h = harness([wire("e0", 90, "pending")]);
    await h.model.capability.refresh();
    await Promise.all([
      h.model.capability.complete("r1"),
      h.model.capability.snooze("r1", 500),
    ]);
    expect(h.signed.map((i) => [i.createdAt, i.content.status])).toEqual([
      [100, "done"],
      [101, "pending"],
    ]);
    expect(h.head()).toMatchObject({ createdAt: 101, status: "pending" });
  });

  it("recovers after a failed write", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 100_000 });
    const h = harness([wire("e0", 90, "pending")]);
    await h.model.capability.refresh();
    h.failNextPublish();
    const failed = h.model.capability.complete("r1");
    const after = h.model.capability.snooze("r1", 500);
    await expect(failed).rejects.toThrow("rejected");
    await after;
    expect(h.head()).toMatchObject({ createdAt: 100, status: "pending" });
  });
});

it("does not mark a disposed session ready from a late empty history reply", async () => {
  const controller = new AbortController();
  let answer: (events: RelayEvent[]) => void = () => {};
  const model = createReminders({
    viewer,
    signal: controller.signal,
    host: {
      decode: async () => [],
      sign: async () => wire("e", 1, "pending", "d"),
    },
    query: () => new Promise((resolve) => (answer = resolve)),
    publish: async () => {},
  });
  const read = model.recover();
  controller.abort();
  answer([]);
  await read;
  expect(model.capability.snapshot().status).toBe("loading");
});

it("does not mark a session ready when it is disposed while an empty reply is accepted", async () => {
  const controller = new AbortController();
  let answer: (events: RelayEvent[]) => void = () => {};
  const model = createReminders({
    viewer,
    signal: controller.signal,
    host: {
      decode: async () => [],
      sign: async () => wire("e", 1, "pending", "d"),
    },
    query: () => new Promise((resolve) => (answer = resolve)),
    publish: async () => {},
  });
  const read = model.recover();
  answer([]);
  // Lands after the reply passes the first abort check, before readiness.
  queueMicrotask(() => controller.abort());
  await read;
  expect(model.capability.snapshot().status).toBe("loading");
});

describe("reminder history paging", () => {
  // Distinct coordinates, newest first, as the relay returns heads.
  const heads = (prefix: string, count: number, newest: number) =>
    Array.from({ length: count }, (_, i) =>
      wire(
        `${prefix}${String(i).padStart(3, "0")}`,
        newest - i,
        "done",
        `${prefix}${i}`,
      ),
    );
  function paged(...replies: (RelayEvent[] | Promise<RelayEvent[]>)[]) {
    const filters: ReadFilter[] = [];
    const statuses: string[] = [];
    const model = createReminders({
      viewer,
      signal: new AbortController().signal,
      host: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: async () => wire("e", 1, "pending", "d"),
      },
      query: async ([filter]) => {
        if (filter) filters.push(filter);
        return (await replies.shift()) ?? [];
      },
      publish: async () => {},
    });
    model.capability.subscribe(() =>
      statuses.push(model.capability.snapshot().status),
    );
    return { model, filters, statuses, snapshot: model.capability.snapshot };
  }
  function deferred() {
    let resolve: (events: RelayEvent[]) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<RelayEvent[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("reads one page when the list is shorter than a page", async () => {
    const h = paged(heads("a", 199, 1_000));
    await h.model.recover();
    expect(h.filters).toEqual([
      { kinds: [30300], authors: [viewer], limit: 200 },
    ]);
    expect(h.snapshot()).toMatchObject({ status: "ready", hydrated: true });
  });

  it("pages from the last head until a short page, staying loading until then", async () => {
    // The oldest time is tied, so the cursor is its highest ID.
    const first = [
      ...heads("a", 198, 1_000),
      wire("f1", 802, "done", "t1"),
      wire("f0", 802, "done", "t0"),
    ];
    const rest = deferred();
    const h = paged(first, rest.promise);
    const read = h.model.recover();
    await vi.waitFor(() => expect(h.filters).toHaveLength(2));
    expect(h.statuses).toEqual(["loading"]);
    expect(h.snapshot()).toMatchObject({ status: "loading", hydrated: true });
    expect(h.snapshot().reminders).toHaveLength(200);
    expect(h.filters[1]).toEqual({
      kinds: [30300],
      authors: [viewer],
      limit: 200,
      until: 802,
      before_id: "f1",
    });
    rest.resolve([wire("old", 10, "pending", "old")]);
    await read;
    expect(h.statuses).toEqual(["loading", "ready"]);
    expect(h.snapshot()).toMatchObject({ status: "ready", hydrated: true });
    expect(h.snapshot().reminders).toHaveLength(201);
    expect(h.snapshot().reminders.find((r) => r.id === "old")?.status).toBe(
      "pending",
    );
  });

  it("keeps landed pages when a later page fails and restarts from the top", async () => {
    const h = paged(
      heads("a", 200, 1_000),
      Promise.reject(new Error("rejected")),
      [wire("old", 10, "pending", "old")],
    );
    await h.model.recover();
    expect(h.snapshot()).toMatchObject({
      status: "ready",
      hydrated: true,
      error: "rejected",
    });
    expect(h.snapshot().reminders).toHaveLength(200);
    await h.model.capability.refresh();
    expect(h.filters[2]).not.toHaveProperty("until");
    expect(h.snapshot()).toMatchObject({ status: "ready", hydrated: true });
    expect(h.snapshot().error).toBeUndefined();
  });

  it("abandons a walk when recovery restarts it", async () => {
    const stale = deferred();
    const fresh = deferred();
    const h = paged(heads("a", 200, 1_000), stale.promise, fresh.promise);
    const abandoned = h.model.recover();
    await vi.waitFor(() => expect(h.filters).toHaveLength(2));
    const restarted = h.model.recover();
    await vi.waitFor(() => expect(h.filters).toHaveLength(3));
    expect(h.filters[2]).not.toHaveProperty("until");
    stale.resolve([wire("old", 10, "pending", "old")]);
    await abandoned;
    expect(h.snapshot().status).toBe("loading");
    expect(h.snapshot().reminders.some((r) => r.id === "old")).toBe(false);
    fresh.resolve([]);
    await restarted;
    expect(h.snapshot().status).toBe("ready");
  });

  it("keeps loading when the connection drops between pages, until recovery's own walk ends", async () => {
    const rest = deferred();
    const h = paged(heads("a", 200, 1_000), rest.promise, [
      wire("old", 10, "pending", "old"),
    ]);
    const dropped = h.model.recover();
    await vi.waitFor(() => expect(h.filters).toHaveLength(2));
    h.model.stale();
    // The short page still lands and shows, but it cannot end the walk: live
    // edits made during the outage could not reach this session.
    rest.resolve([wire("old", 10, "pending", "old")]);
    await dropped;
    expect(h.statuses).not.toContain("ready");
    expect(h.snapshot()).toMatchObject({ status: "loading", hydrated: true });
    expect(h.snapshot().reminders).toHaveLength(201);
    await h.model.recover();
    expect(h.filters).toHaveLength(3);
    expect(h.filters[2]).not.toHaveProperty("until");
    expect(h.snapshot()).toMatchObject({ status: "ready", hydrated: true });
    expect(h.snapshot().error).toBeUndefined();
  });

  it("reports a page that fails during an outage like any failed read, until recovery's own walk ends", async () => {
    const rest = deferred();
    const h = paged(heads("a", 200, 1_000), rest.promise, [
      wire("old", 10, "pending", "old"),
    ]);
    const dropped = h.model.recover();
    await vi.waitFor(() => expect(h.filters).toHaveLength(2));
    h.model.stale();
    rest.reject(new Error("socket closed"));
    await dropped;
    // The rows stay up under Retry, and `error` keeps the check time put.
    expect(h.snapshot()).toMatchObject({
      status: "ready",
      hydrated: true,
      error: "socket closed",
    });
    expect(h.snapshot().reminders).toHaveLength(200);
    await h.model.recover();
    expect(h.filters[2]).not.toHaveProperty("until");
    expect(h.snapshot()).toMatchObject({ status: "ready", hydrated: true });
    expect(h.snapshot().reminders).toHaveLength(201);
  });

  it("stops at the page bound and reports the list as partial", async () => {
    const h = paged(
      ...Array.from({ length: 51 }, (_, page) =>
        heads(`p${page}-`, 200, 20_000 - page * 200),
      ),
    );
    await h.model.recover();
    expect(h.filters).toHaveLength(50);
    expect(h.snapshot()).toMatchObject({
      status: "ready",
      hydrated: true,
      error: "Too many reminders to load",
    });
    expect(h.snapshot().reminders).toHaveLength(10_000);
  });

  it("fails a page that does not advance the cursor", async () => {
    const first = heads("a", 200, 1_000);
    const h = paged(first, first);
    await h.model.recover();
    expect(h.filters).toHaveLength(2);
    expect(h.snapshot()).toMatchObject({
      status: "ready",
      error: "Reminder paging did not advance",
    });
  });
});
