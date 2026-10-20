// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptySync,
  enqueue,
  type PendingOp,
  type SyncState,
} from "../../../features/communities/known-communities";
import type {
  ClientSnapshot,
  KnownCommunities,
} from "../../../features/communities/service";
import type { Host } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import {
  createKnownCommunitiesClient,
  type KnownCommunitiesClient,
  type ListResult,
  type UpdateResult,
} from "./client";
import { startKnownCommunitiesSync } from "./sync";

const viewer = "ab".repeat(32);
const primary = "wss://primary.example";
const secondary = "wss://secondary.example";
const reachError = () => new Error("Couldn’t reach Builderlab.");
const accepted: UpdateResult = { kind: "accepted" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Settles pending promise chains without moving the fake clock. */
const until = (check: () => void) =>
  vi.waitFor(check, { interval: 0, timeout: 2000 });
const queued = (...urls: string[]) =>
  urls.reduce((state, url) => enqueue(state, url, false), emptySync());
/** The account service: a set of destinations with idempotent edits. */
function fakeService(...held: string[]) {
  const rows = new Set(held);
  return {
    rows,
    list: (): ListResult => ({ kind: "listed", communities: [...rows] }),
    add(url: string): UpdateResult {
      rows.add(url);
      return accepted;
    },
    remove(url: string): UpdateResult {
      rows.delete(url);
      return accepted;
    },
  };
}

/** The capability as the service provides it: the record, the queue, and the
 * writes back. `apply` keeps only the sync state; membership changes are the
 * service's business and are asserted as the changes handed to it. */
function store(initial: Partial<ClientSnapshot> = {}) {
  let snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: emptySync(),
    viewer,
    selected: null,
    memberships: [],
    ...initial,
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const status = vi.fn<KnownCommunities["status"]>();
  const apply = vi.fn(async (next: SyncState, _add?: string[]) => {
    snapshot = { ...snapshot, sync: next };
    notify();
  });
  const knownCommunities: KnownCommunities = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pending: () => snapshot.sync.outbox,
    apply,
    status,
  };
  return {
    knownCommunities,
    apply,
    status,
    set(change: Partial<ClientSnapshot>) {
      snapshot = { ...snapshot, ...change };
      notify();
    },
    enqueue(url: string, removed = false) {
      this.set({ sync: enqueue(snapshot.sync, url, removed) });
    },
    outbox: () => snapshot.sync.outbox,
    known: () => snapshot.sync.known,
  };
}
function fakeClient() {
  return {
    list: vi.fn<KnownCommunitiesClient["list"]>(async () => ({
      kind: "listed",
      communities: [],
    })),
    add: vi.fn<KnownCommunitiesClient["add"]>(async () => accepted),
    remove: vi.fn<KnownCommunitiesClient["remove"]>(async () => accepted),
  };
}
/** `arrange` sets the service's answers before the sign-in starts the drain,
 * which reaches the first upload without yielding to the test. */
async function fixture({
  snapshot = {} as Partial<ClientSnapshot>,
  signedIn = true,
  arrange = (_client: ReturnType<typeof fakeClient>) => {},
} = {}) {
  const s = store(snapshot);
  const client = fakeClient();
  arrange(client);
  // Which Builderlab account the next sign-in is for.
  const account = { subject: "user" };
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: {
      subject: account.subject,
      email: "a@example.com",
      canUseRemoteAgents: false,
    },
  }));
  const dispose = startKnownCommunitiesSync({
    client,
    session,
    knownCommunities: s.knownCommunities,
  });
  if (signedIn) await session.signIn();
  /** Every edit sent, in order, as the intent it carried. */
  const sent = () =>
    [
      ...client.add.mock.invocationCallOrder,
      ...client.remove.mock.invocationCallOrder,
    ]
      .sort((x, y) => x - y)
      .map((order): PendingOp => {
        const added = client.add.mock.invocationCallOrder.indexOf(order);
        return added >= 0
          ? { url: client.add.mock.calls[added]?.[0] ?? "", removed: false }
          : {
              url:
                client.remove.mock.calls[
                  client.remove.mock.invocationCallOrder.indexOf(order)
                ]?.[0] ?? "",
              removed: true,
            };
      });
  return { ...s, account, client, session, dispose, sent };
}
const synced = (pending = 0) => ({ phase: "synced", pending });

it("waits for sign-in and a ready identity, then lists, merges and drains", async () => {
  const h = await fixture({
    signedIn: false,
    snapshot: {
      status: "loading",
      memberships: [{ id: "https://primary.example", name: "Primary" }],
      sync: queued(primary),
    },
  });
  expect(h.status).toHaveBeenLastCalledWith({
    phase: "signed-out",
    pending: 1,
  });
  await h.session.signIn();
  // Signed in, but the device record is still loading: nothing to send yet.
  expect(h.status).toHaveBeenLastCalledWith({ phase: "pending", pending: 1 });
  expect(h.client.list).not.toHaveBeenCalled();
  h.client.list.mockResolvedValueOnce({
    kind: "listed",
    communities: [secondary],
  });
  const op = h.outbox()[0];
  h.set({ status: "ready" });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.client.list).toHaveBeenCalledWith(expect.any(AbortSignal));
  // The complete list replaces what is known; the destination saved elsewhere
  // is handed to the service to add, and the queued add keeps its place.
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    { known: [secondary], outbox: [op], account: "user" },
    [secondary],
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.client.add).toHaveBeenCalledWith(primary, expect.any(AbortSignal));
  expect(h.client.remove).not.toHaveBeenCalled();
  expect(h.apply).toHaveBeenLastCalledWith({
    known: [secondary, primary],
    outbox: [],
    account: "user",
  });
  expect(h.status.mock.calls.map(([s]) => s?.phase)).toContain("syncing");
  h.dispose();
});

it("merges nothing more than once per sign-in, and sends a newly queued intent at once", async () => {
  const h = await fixture();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.enqueue(primary);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  expect(h.known()).toEqual([primary]);
  h.enqueue(primary, true);
  await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.known()).toEqual([]);
  expect(h.client.list).toHaveBeenCalledTimes(1);
  h.dispose();
});

it.each([
  {
    name: "the list route refuses the account",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "forbidden" }),
    status: {
      phase: "error",
      pending: 1,
      error: "This Builderlab account can’t sync communities.",
    },
  },
  {
    name: "the list route rejects the request as sent",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "rejected", status: 405 }),
    status: {
      phase: "error",
      pending: 1,
      error: "Builderlab refused this request (HTTP 405).",
    },
  },
  {
    name: "the list cannot be read",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "invalid_response" }),
    status: {
      phase: "error",
      pending: 1,
      error: "Builderlab returned an invalid response.",
    },
  },
  {
    // Routes not yet deployed: quiet, with no reason to report.
    name: "the service has no known-communities routes",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "rejected", status: 404 }),
    status: { phase: "unavailable", pending: 1 },
  },
  {
    name: "an upload is forbidden",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.add.mockResolvedValue({ kind: "forbidden" }),
    status: {
      phase: "error",
      pending: 1,
      error: "This Builderlab account can’t sync communities.",
    },
  },
  {
    // A partly routed service is as quiet as one without any route.
    name: "an upload meets no route",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.add.mockResolvedValue({ kind: "rejected", status: 404 }),
    status: { phase: "unavailable", pending: 1 },
  },
])("halts until the next sign-in when $name", async ({ arrange, status }) => {
  const h = await fixture({
    signedIn: false,
    snapshot: { sync: queued(primary) },
  });
  arrange(h);
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(status));
  const calls = () =>
    h.client.list.mock.calls.length +
    h.client.add.mock.calls.length +
    h.client.remove.mock.calls.length;
  const before = calls();
  window.dispatchEvent(new Event("online"));
  h.enqueue(secondary);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(calls()).toBe(before);
  expect(h.outbox()).toHaveLength(2);
  h.session.signOut();
  h.client.list.mockResolvedValue({ kind: "listed", communities: [] });
  h.client.add.mockResolvedValue(accepted);
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it("halts on a 200 list the real client cannot read, forgetting no membership", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const s = store({
    memberships: [{ id: "https://primary.example", name: "Primary" }],
    sync: { known: [primary], outbox: [] },
  });
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: {
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: false,
    },
  }));
  // A proxy's block page, a truncated or an empty body: a 200 that is no list.
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async () => ({ status: 200, headers: {}, body: "" })),
  };
  const dispose = startKnownCommunitiesSync({
    client: createKnownCommunitiesClient(host, session),
    session,
    knownCommunities: s.knownCommunities,
  });
  await session.signIn();
  await until(() =>
    expect(s.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 0,
      error: "Builderlab returned an invalid response.",
    }),
  );
  // Nothing merged: the account was not taken to hold nothing.
  expect(s.apply).not.toHaveBeenCalled();
  expect(s.known()).toEqual([primary]);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(host.request).toHaveBeenCalledTimes(1);
  dispose();
});

it("runs no pass and reports nothing on a trigger once synced with an empty queue, and never repeats a report", async () => {
  const h = await fixture({ snapshot: { sync: queued(primary) } });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  const reports = h.status.mock.calls.length;
  window.dispatchEvent(new Event("online"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.status).toHaveBeenCalledTimes(reports);
  expect(h.client.list).toHaveBeenCalledTimes(1);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  // A new intent still runs; the store's own notice of it, and the queue
  // shrinking under the acknowledgement, add no report that says the same.
  h.enqueue(secondary);
  await until(() => expect(h.outbox()).toEqual([]));
  const phases = h.status.mock.calls.slice(reports).map(([s]) => s);
  expect(phases).toEqual([
    { phase: "syncing", pending: 1 },
    { phase: "syncing", pending: 0 },
    synced(),
  ]);
  h.dispose();
});

it("keeps syncing when the list left out addresses this device cannot save, and says so once", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = await fixture({
    arrange: (client) =>
      client.list.mockResolvedValue({
        kind: "listed",
        communities: [secondary],
        dropped: 2,
      }),
  });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.apply).toHaveBeenCalledWith(
    { known: [secondary], outbox: [], account: "user" },
    [secondary],
  );
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain("2 community address(es)");
  h.dispose();
});

it("uploads one intent at a time, in queue order", async () => {
  const first = deferred<UpdateResult>();
  const h = await fixture({
    snapshot: { sync: queued(primary, secondary) },
    arrange: (client) => client.add.mockReturnValueOnce(first.promise),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  expect(h.status).toHaveBeenLastCalledWith({ phase: "syncing", pending: 2 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  first.resolve(accepted);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  expect(h.client.add.mock.calls[1]?.[0]).toBe(secondary);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.dispose();
});

it("retries a failed upload with the identical request at doubling delays, capped at a minute", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockRejectedValue(reachError()),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: "Couldn’t reach Builderlab.",
    }),
  );
  let attempts = 1;
  // Each failed run reports twice: syncing, then the error.
  let reports = h.status.mock.calls.length;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(h.client.add).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.add).toHaveBeenCalledTimes(++attempts);
    expect(h.client.add.mock.calls.at(-1)?.[0]).toBe(primary);
    reports += 2;
    await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  }
  // A success resets the backoff for the next failure.
  h.client.add.mockResolvedValueOnce(accepted);
  await vi.advanceTimersByTimeAsync(60000);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  h.enqueue(secondary);
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error" }),
    ),
  );
  const count = h.client.add.mock.calls.length;
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(count + 1);
  h.dispose();
});

it("runs again at once when the window comes online or becomes visible, resetting the backoff", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockRejectedValue(reachError()),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error" }),
    ),
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  let reports = h.status.mock.calls.length;
  window.dispatchEvent(new Event("online"));
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  // The trigger's own failure starts the backoff over at one second.
  reports += 2;
  await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(3);
  reports += 2;
  await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  let visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client.add).toHaveBeenCalledTimes(3);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(4));
  h.dispose();
});

it.each([
  {
    refusal: { kind: "invalid_request" } as const,
    reason: "Builderlab refused one of your community addresses.",
  },
  {
    refusal: { kind: "limit_reached" } as const,
    reason: "Builderlab can’t save more communities for this account.",
  },
  {
    refusal: { kind: "rejected", status: 415 } as const,
    reason: "Builderlab refused this request (HTTP 415).",
  },
])(
  "parks an add the service answers $refusal.kind, keeps sending others, and sends the intent that replaces it",
  async ({ refusal, reason }) => {
    const h = await fixture({
      snapshot: { sync: queued(primary, secondary) },
      arrange: (client) =>
        client.add.mockImplementation(async (url) =>
          url === primary ? refusal : accepted,
        ),
    });
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith({
        phase: "error",
        pending: 1,
        error: reason,
      }),
    );
    expect(h.client.add).toHaveBeenCalledTimes(2);
    expect(h.outbox()).toEqual([{ url: primary, removed: false }]);
    // Triggers and time pass it over, and the same intent queued again is
    // the same request: still parked.
    window.dispatchEvent(new Event("online"));
    h.enqueue(primary);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.add).toHaveBeenCalledTimes(2);
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: reason,
    });
    // A fresh intent for another destination still goes.
    h.enqueue(secondary, true);
    await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
    expect(h.client.remove.mock.calls[0]?.[0]).toBe(secondary);
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith({
        phase: "error",
        pending: 1,
        error: reason,
      }),
    );
    // Leaving the refused community replaces the parked add with a removal,
    // which is a different request and goes out; nothing then remains parked.
    h.enqueue(primary, true);
    await until(() => expect(h.client.remove).toHaveBeenCalledTimes(2));
    expect(h.client.remove.mock.calls[1]?.[0]).toBe(primary);
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    expect(h.outbox()).toEqual([]);
    h.dispose();
  },
);

it("sends a parked intent again on the next sign-in", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) =>
      client.add.mockResolvedValueOnce({ kind: "limit_reached" }),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: "Builderlab can’t save more communities for this account.",
    }),
  );
  h.session.signOut();
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it("reports a parked intent's refusal again once a failed upload beside it goes through", async () => {
  const full = "Builderlab can’t save more communities for this account.";
  const h = await fixture({
    snapshot: { sync: queued(primary, secondary) },
    arrange: (client) =>
      client.add
        .mockResolvedValueOnce({ kind: "limit_reached" })
        .mockRejectedValueOnce(reachError()),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 2,
      error: "Couldn’t reach Builderlab.",
    }),
  );
  // The retry sends only the failed upload; the parked one is what remains.
  await vi.advanceTimersByTimeAsync(1000);
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: full,
    }),
  );
  expect(h.sent()).toEqual([
    { url: primary, removed: false },
    { url: secondary, removed: false },
    { url: secondary, removed: false },
  ]);
  h.dispose();
});

it("reports the refusal of the intent still parked once another parked intent is withdrawn", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary, secondary) },
    arrange: (client) =>
      client.add.mockImplementation(async (url) =>
        url === primary
          ? { kind: "invalid_request" }
          : { kind: "limit_reached" },
      ),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error", pending: 2 }),
    ),
  );
  h.enqueue(secondary, true);
  await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: "Builderlab refused one of your community addresses.",
    }),
  );
  h.dispose();
});

it.each([
  { name: "join, lost acknowledgement, leave", first: false },
  { name: "leave, lost acknowledgement, rejoin", first: true },
])(
  "converges on the latest intent after $name: the retry sends only the newer intent",
  async ({ first }) => {
    const service = fakeService(...(first ? [primary] : []));
    const h = await fixture({
      signedIn: false,
      snapshot: {
        memberships: first
          ? [{ id: "https://primary.example", name: "Primary" }]
          : [],
      },
    });
    h.client.list.mockImplementation(async () => service.list());
    let lost = true;
    const edit =
      (apply: (url: string) => UpdateResult) => async (url: string) => {
        const result = apply(url);
        // The service applied it, but its answer never arrived.
        if (lost) {
          lost = false;
          throw reachError();
        }
        return result;
      };
    h.client.add.mockImplementation(edit((url) => service.add(url)));
    h.client.remove.mockImplementation(edit((url) => service.remove(url)));
    await h.session.signIn();
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    h.enqueue(primary, first);
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "error" }),
      ),
    );
    expect(service.rows.has(primary)).toBe(!first);
    // The user changes their mind during the backoff: the newer intent
    // replaces the one whose answer was lost, and is what the retry sends.
    h.enqueue(primary, !first);
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    expect(h.sent()).toEqual([
      { url: primary, removed: first },
      { url: primary, removed: !first },
    ]);
    expect(service.rows.has(primary)).toBe(first);
    expect(h.known()).toEqual(first ? [primary] : []);
    expect(h.outbox()).toEqual([]);
    // No membership change was ever reported against the user's own change
    // of mind.
    expect(h.apply.mock.calls.flatMap(([, add]) => add ?? [])).toEqual([]);
    h.dispose();
  },
);

it("backs off when the device record will not save, then replays the identical request", async () => {
  const h = await fixture();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  const failure = new Error(
    "Could not save this community on this device. Try again.",
  );
  h.apply.mockRejectedValueOnce(failure);
  h.enqueue(primary);
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: failure.message,
    }),
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  // The service accepted it; only the record did not take the answer. The
  // intent stays, and the idempotent request goes again.
  expect(h.outbox()).toEqual([{ url: primary, removed: false }]);
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.client.add.mock.calls[1]?.[0]).toBe(primary);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  expect(h.known()).toEqual([primary]);
  h.dispose();
});

it("keeps an intent queued while the list is in flight: the merge reads the record again", async () => {
  const list = deferred<ListResult>();
  const h = await fixture({ signedIn: false });
  h.client.list.mockReturnValueOnce(list.promise);
  await h.session.signIn();
  await until(() => expect(h.client.list).toHaveBeenCalledTimes(1));
  h.enqueue(primary);
  const op = h.outbox()[0];
  list.resolve({ kind: "listed", communities: [] });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    { known: [], outbox: [op], account: "user" },
    [],
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it("follows the account on the next sign-in: a membership never uploaded is sent, one removed elsewhere is kept and not re-sent", async () => {
  const service = fakeService(secondary);
  const h = await fixture({
    signedIn: false,
    snapshot: {
      memberships: [
        { id: "https://primary.example", name: "Primary" },
        { id: "https://secondary.example", name: "Secondary" },
      ],
      sync: { known: [secondary], outbox: [], account: "user" },
    },
  });
  h.client.list.mockImplementation(async () => service.list());
  h.client.add.mockImplementation(async (url) => service.add(url));
  // Another device removed the secondary and added a third community. The
  // removal is ignored for now: the secondary stays saved and known, so only
  // the primary, which the service has never seen, is uploaded.
  service.rows.delete(secondary);
  service.rows.add("wss://third.example");
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    {
      known: [secondary, "wss://third.example"],
      outbox: [{ url: primary, removed: false }],
      account: "user",
    },
    ["wss://third.example"],
  );
  expect(h.sent()).toEqual([{ url: primary, removed: false }]);
  expect(h.known()).toEqual([secondary, "wss://third.example", primary]);
  expect([...service.rows]).toEqual(["wss://third.example", primary]);
  h.dispose();
});

const both = [
  { id: "https://primary.example", name: "Primary" },
  { id: "https://secondary.example", name: "Secondary" },
];

it("keeps what it knows across sign-ins as the same account: a membership removed elsewhere meanwhile is kept, never removed here and never uploaded again", async () => {
  const service = fakeService(primary, secondary);
  const h = await fixture({
    snapshot: { memberships: both },
    arrange: (client) => {
      client.list.mockImplementation(async () => service.list());
      client.add.mockImplementation(async (url) => service.add(url));
    },
  });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.known()).toEqual([primary, secondary]);
  h.session.signOut();
  service.rows.delete(secondary);
  // The sign-in that first reads the shorter list, and the one after it:
  // neither forgets the secondary, and neither re-adds it to the account.
  for (const signIn of [2, 3]) {
    await h.session.signIn();
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    expect(h.client.list).toHaveBeenCalledTimes(signIn);
    expect(h.apply).toHaveBeenLastCalledWith(
      { known: [primary, secondary], outbox: [], account: "user" },
      [],
    );
    expect(h.sent()).toEqual([]);
    expect(h.outbox()).toEqual([]);
    expect([...service.rows]).toEqual([primary]);
    expect(h.knownCommunities.snapshot().memberships).toEqual(both);
    h.session.signOut();
  }
  h.dispose();
});

it("reads nothing into another account's sign-in on this device: the first account's communities are uploaded to it, never forgotten", async () => {
  const alice = fakeService(primary, secondary);
  const bob = fakeService();
  let service = alice;
  const h = await fixture({
    snapshot: { memberships: both },
    arrange: (client) => {
      client.list.mockImplementation(async () => service.list());
      client.add.mockImplementation(async (url) => service.add(url));
    },
  });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.known()).toEqual([primary, secondary]);
  h.session.signOut();
  h.account.subject = "bob";
  service = bob;
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  // The device record outlived Alice's sign-out, but her list says nothing
  // about Bob's: neither membership was removed elsewhere, and both are ones
  // Bob's account has never seen.
  expect(h.apply).toHaveBeenNthCalledWith(
    2,
    {
      known: [],
      outbox: [
        { url: primary, removed: false },
        { url: secondary, removed: false },
      ],
      account: "bob",
    },
    [],
  );
  expect(h.sent()).toEqual([
    { url: primary, removed: false },
    { url: secondary, removed: false },
  ]);
  expect([...bob.rows]).toEqual([primary, secondary]);
  expect(h.knownCommunities.snapshot().sync).toEqual({
    known: [primary, secondary],
    outbox: [],
    account: "bob",
  });
  h.dispose();
});

it("runs no pass and reports nothing on a trigger while only parked intents remain", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) =>
      client.add.mockResolvedValueOnce({ kind: "limit_reached" }),
  });
  const parked = {
    phase: "error",
    pending: 1,
    error: "Builderlab can’t save more communities for this account.",
  };
  await until(() => expect(h.status).toHaveBeenLastCalledWith(parked));
  const reports = h.status.mock.calls.length;
  // A parked intent moves again only when replaced or on the next sign-in,
  // so these triggers have nothing to run and nothing new to say.
  window.dispatchEvent(new Event("online"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.status).toHaveBeenCalledTimes(reports);
  expect(h.client.list).toHaveBeenCalledTimes(1);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  // A fresh intent still runs, passing the parked one over.
  h.enqueue(secondary);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  expect(h.client.add.mock.calls[1]?.[0]).toBe(secondary);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(parked));
  expect(h.outbox()).toEqual([{ url: primary, removed: false }]);
  h.dispose();
});

it("signing out abandons the upload in flight and keeps the outbox for the next sign-in", async () => {
  const gate = deferred<UpdateResult>();
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockReturnValueOnce(gate.promise),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  const [, signal] = h.client.add.mock.calls[0] as [string, AbortSignal];
  const op = h.outbox()[0];
  const applied = h.apply.mock.calls.length;
  h.session.signOut();
  expect(signal.aborted).toBe(true);
  expect(h.status).toHaveBeenLastCalledWith({
    phase: "signed-out",
    pending: 1,
  });
  gate.resolve(accepted);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.apply).toHaveBeenCalledTimes(applied);
  expect(h.outbox()).toEqual([op]);
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  // A fresh sign-in reads the list again, then resends.
  expect(h.client.list).toHaveBeenCalledTimes(2);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.client.add.mock.calls[1]?.[0]).toBe(primary);
  h.dispose();
});

it("stops without a retry when the service ends the session", async () => {
  const h = await fixture({
    signedIn: false,
    snapshot: { sync: queued(primary) },
  });
  h.client.add.mockImplementation(async () => {
    h.session.signOut();
    throw new DOMException("Builderlab session changed.", "AbortError");
  });
  await h.session.signIn();
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "signed-out",
      pending: 1,
    }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.outbox()).toHaveLength(1);
  h.dispose();
});

it("disposal withdraws the report and stops listening", async () => {
  const h = await fixture();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.dispose();
  expect(h.status).toHaveBeenLastCalledWith(undefined);
  const reports = h.status.mock.calls.length;
  h.enqueue(primary);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.add).not.toHaveBeenCalled();
  expect(h.status).toHaveBeenCalledTimes(reports);
});
