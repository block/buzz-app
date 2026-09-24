import { afterEach, expect, it, vi } from "vitest";
import type { RelayReader } from "../relay/reader";
import type { RelayEvent } from "../relay/events";
import { matchesEvent } from "../relay/projection";
import { keypair, signed } from "../relay/testing";
import { createWorkflows } from "./capability";

const channels = Array.from(
  { length: 17 },
  (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
);
const first = "11111111-1111-4111-8111-000000000000";
const second = "11111111-1111-4111-8111-000000000001";
const key = keypair();
const event = signed(key, {
  kind: 30620,
  content: "name: Private workflow",
  tags: [
    ["h", first],
    ["d", "22222222-2222-4222-8222-222222222222"],
  ],
});
const owners: ReturnType<typeof createWorkflows>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function setup() {
  const read = vi.fn<RelayReader["read"]>().mockResolvedValue([event]);
  const denied = new Set<string>();
  const owner = createWorkflows({
    reader: { read },
    viewer: key.pubkey,
    outbox: undefined,
    local: undefined,
    host: undefined,
    canAccess: (id) => !denied.has(id),
  });
  owners.push(owner);
  return { ...owner, read, denied };
}

it("reads the overview across 17 member channels with one channel-scoped filter", async () => {
  const h = setup();
  const requests: {
    resolve(events: readonly RelayEvent[]): void;
    signal: AbortSignal;
  }[] = [];
  h.read.mockImplementation(
    (_filters, options) =>
      new Promise((resolve) => {
        if (!options?.signal) throw new Error("Missing cancellation signal");
        requests.push({ resolve, signal: options.signal });
      }),
  );
  const view = h.capability.definitions(channels);
  const loading = view.refresh();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(view.snapshot().status).toBe("loading");
  requests[0]?.resolve([event]);
  await loading;
  expect(h.read).toHaveBeenCalledExactlyOnceWith(
    [{ kinds: [30620], "#h": channels, limit: 100 }],
    expect.objectContaining({ fresh: true, signal: expect.any(AbortSignal) }),
  );
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [{ revision: event.id }], partial: false },
  });
});

it("reuses the normalized overview on return, expires after ten seconds, and honors explicit refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const h = setup();
  const view = h.capability.definitions([first, second]);
  await view.refresh();
  view.dispose();
  const returned = h.capability.definitions([second, first, first]);
  expect(returned.snapshot().status).toBe("ready");
  await returned.refresh({ ifStale: true });
  expect(h.read).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 10_000);
  const stale = h.capability.definitions([first, second]);
  expect(stale.snapshot().data.items).toHaveLength(1);
  await stale.refresh({ ifStale: true });
  expect(h.read).toHaveBeenCalledTimes(2);
  const manual = h.capability.definitions([first, second]);
  await manual.refresh();
  expect(h.read).toHaveBeenCalledTimes(3);
});

it.each(["clear", "interrupt", "dispose"] as const)(
  "%s invalidates retained results, including released views",
  async (action) => {
    const h = setup();
    const view = h.capability.definitions([first]);
    await view.refresh();
    view.dispose();
    h[action]();
    expect(h.capability.definitions([first]).snapshot().data.items).toEqual([]);
  },
);

it("purges all channel data before callbacks and never resurrects a late read after access loss", async () => {
  const h = setup();
  const view = h.capability.definitions([first, second]);
  await view.refresh();
  let complete!: (events: readonly RelayEvent[]) => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const loading = view.refresh();
  await vi.waitFor(() => expect(complete).toBeDefined());
  view.subscribe(() => {
    expect(view.snapshot().data.items).toEqual([]);
    expect(h.capability.definitions([first]).snapshot().data.items).toEqual([]);
  });
  h.denied.add(second);
  h.clear();
  complete([event]);
  await loading;
  expect(view.snapshot().status).toBe("unavailable");
  h.denied.clear();
  expect(h.capability.definitions([first, second]).snapshot().status).toBe(
    "idle",
  );
});

it("a failed overview exposes retry and never caches an incomplete result", async () => {
  const h = setup();
  let fail!: (reason: Error) => void;
  h.read.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const view = h.capability.definitions(channels);
  const loading = view.refresh();
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  fail(new Error("offline"));
  await loading;
  expect(view.snapshot().status).toBe("error");
  expect(
    h.read.mock.calls.every(([, options]) => options?.signal?.aborted),
  ).toBe(true);
  expect(h.capability.definitions(channels).snapshot().status).toBe("idle");
  h.read.mockResolvedValue([]);
  await view.refresh();
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [] },
  });
});

it("retains bounded single-channel reads and rejects mismatched channels", async () => {
  const h = setup();
  h.read.mockResolvedValue(Array.from({ length: 100 }, () => event));
  const view = h.capability.definitions(first);
  await view.refresh();
  expect(view.snapshot().data.partial).toBe(true);
  const mismatch = h.capability.definitions(second);
  await mismatch.refresh();
  expect(mismatch.snapshot().status).toBe("error");
});

const fullPage = () =>
  Array.from({ length: 100 }, (_, index) => ({
    ...event,
    id: index.toString(16).padStart(64, "0"),
    tags: [
      ["h", first],
      ["d", `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`],
    ],
  }));

it("pages a full overview using timestamp and event ID, including same-second rows", async () => {
  const h = setup();
  const page = fullPage();
  const last = page.at(-1);
  if (!last) throw new Error("Missing page cursor");
  const older = { ...event, id: "f".repeat(64) };
  h.read
    .mockResolvedValueOnce([...page].reverse())
    .mockResolvedValueOnce([older]);
  const view = h.capability.definitions(channels);
  await view.refresh();
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.read.mock.calls[1]?.[0]).toEqual([
    {
      kinds: [30620],
      "#h": channels,
      limit: 100,
      until: last.created_at,
      before_id: last.id,
    },
  ]);
  expect(view.snapshot().status).toBe("ready");
  expect(view.snapshot().data.items).toHaveLength(101);
  expect(view.snapshot().data.partial).toBe(false);
  view.dispose();
  const returned = h.capability.definitions(channels);
  await returned.refresh({ ifStale: true });
  expect(returned.snapshot().data.items).toHaveLength(101);
  expect(h.read).toHaveBeenCalledTimes(2);
});

it.each(["failure", "repeated-page"] as const)(
  "does not retain a partly paged overview after %s",
  async (mode) => {
    const h = setup();
    const page = fullPage();
    h.read.mockResolvedValueOnce(page);
    if (mode === "failure") h.read.mockRejectedValueOnce(new Error("offline"));
    else h.read.mockResolvedValueOnce(page);
    const view = h.capability.definitions(channels);
    await view.refresh();
    expect(view.snapshot()).toMatchObject({
      status: "error",
      data: { items: [] },
    });
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.capability.definitions(channels).snapshot().status).toBe("idle");
    h.read.mockResolvedValue([]);
    await view.refresh();
    expect(h.read.mock.calls[2]?.[0]?.[0]?.before_id).toBeUndefined();
    expect(view.snapshot().status).toBe("ready");
  },
);

it("stops paging when the overview is disposed", async () => {
  const h = setup();
  let finish!: (events: readonly RelayEvent[]) => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = h.capability.definitions(channels);
  const loading = view.refresh();
  await vi.waitFor(() => expect(finish).toBeDefined());
  view.dispose();
  finish(fullPage());
  await loading;
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.capability.definitions(channels).snapshot().status).toBe("idle");
});

it("rejects responses outside the requested channels and includes other authors", async () => {
  const h = setup();
  const outside = h.capability.definitions([second]);
  await outside.refresh();
  expect(outside.snapshot()).toMatchObject({
    status: "error",
    data: { items: [] },
  });
  h.read.mockResolvedValue([{ ...event, pubkey: keypair().pubkey }]);
  const foreign = h.capability.definitions([first]);
  await foreign.refresh();
  expect(foreign.snapshot()).toMatchObject({ status: "ready" });
  expect(foreign.snapshot().data.items).toHaveLength(1);
  expect(foreign.snapshot().data.items[0]?.owner).not.toBe(key.pubkey);
});

it("does not query without any member channels", async () => {
  const h = setup();
  const view = h.capability.definitions([]);
  await view.refresh();
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [] },
  });
  expect(h.read).not.toHaveBeenCalled();
});

const manyChannels = Array.from(
  { length: 257 },
  (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
);

it.each([128, 129, 256, 257])(
  "batches %s joined channels without exceeding the relay limit",
  async (count) => {
    const h = setup();
    h.read.mockResolvedValue([]);
    const joined = manyChannels.slice(0, count);
    const view = h.capability.definitions([...joined].reverse().concat(first));
    await view.refresh();
    expect(view.snapshot().status).toBe("ready");
    expect(h.read).toHaveBeenCalledTimes(Math.ceil(count / 128));
    expect(h.read.mock.calls.map(([filters]) => filters)).toEqual(
      Array.from({ length: Math.ceil(count / 128) }, (_, index) => [
        {
          kinds: [30620],
          "#h": joined.slice(index * 128, (index + 1) * 128),
          limit: 100,
        },
      ]),
    );
  },
);

it("returns ten joined-channel workflows among 10,000 accessible workflows in one request", async () => {
  const h = setup();
  const joined = channels.slice(0, 10);
  const outside = "33333333-3333-4333-8333-333333333333";
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    ...event,
    id: index.toString(16).padStart(64, "0"),
    created_at: index,
    tags: [
      ["h", joined[index] ?? outside],
      ["d", `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`],
    ],
  }));
  // Put unrelated accessible workflows first, as a broad relay query would.
  rows.reverse();
  h.read.mockImplementation(async (filters) =>
    filters.flatMap((filter) =>
      rows.filter((row) => matchesEvent(row, filter)).slice(0, filter.limit),
    ),
  );
  const view = h.capability.definitions(joined);
  await view.refresh();
  expect(view.snapshot().status).toBe("ready");
  expect(view.snapshot().data.items).toHaveLength(10);
  expect(h.read).toHaveBeenCalledTimes(1);
});

it("finishes each batch's pages and resets the cursor before the next batch", async () => {
  const h = setup();
  const joined = manyChannels.slice(0, 129);
  const lastChannel = joined[128];
  if (!lastChannel) throw new Error("Missing second batch");
  const firstPage = fullPage();
  const secondPage = firstPage.map((row, index) => ({
    ...row,
    tags: [
      ["h", lastChannel],
      ["d", `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`],
    ],
  }));
  h.read
    .mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce([{ ...event, id: "f".repeat(64) }])
    .mockResolvedValueOnce(secondPage)
    .mockResolvedValueOnce([]);
  const view = h.capability.definitions(joined);
  await view.refresh();
  expect(view.snapshot().status).toBe("ready");
  expect(view.snapshot().data.items).toHaveLength(201);
  expect(h.read.mock.calls.map(([filters]) => filters[0])).toEqual([
    { kinds: [30620], "#h": joined.slice(0, 128), limit: 100 },
    {
      kinds: [30620],
      "#h": joined.slice(0, 128),
      limit: 100,
      until: event.created_at,
      before_id: firstPage.at(-1)?.id,
    },
    { kinds: [30620], "#h": [lastChannel], limit: 100 },
    {
      kinds: [30620],
      "#h": [lastChannel],
      limit: 100,
      until: event.created_at,
      before_id: secondPage.at(-1)?.id,
    },
  ]);
});

it.each(["failure", "access-loss", "dispose"] as const)(
  "does not retain earlier batches or start later ones after %s",
  async (mode) => {
    const h = setup();
    let complete!: (rows: readonly RelayEvent[]) => void;
    let fail!: (error: Error) => void;
    h.read.mockResolvedValueOnce([event]).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          complete = resolve;
          fail = reject;
        }),
    );
    const view = h.capability.definitions(manyChannels);
    const loading = view.refresh();
    await vi.waitFor(() => expect(complete).toBeDefined());
    if (mode === "failure") fail(new Error("offline"));
    else {
      if (mode === "access-loss") {
        h.denied.add(first);
        h.clear();
      } else view.dispose();
      complete([]);
    }
    await loading;
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(view.snapshot().data.items).toEqual([]);
    expect(
      h.capability.definitions(manyChannels).snapshot().data.items,
    ).toEqual([]);
  },
);
