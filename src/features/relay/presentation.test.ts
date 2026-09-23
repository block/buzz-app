import { afterEach, expect, it, vi } from "vitest";
import { createPresentation } from "./presentation";
import type { CheckpointStorage } from "./checkpoint-storage";
import { keypair, metadata, profile, roster, signed } from "./testing";
import type { RelayEvent } from "./events";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const viewer = keypair(),
  authority = keypair(),
  peer = keypair();
const community = "https://community.example";
const groups = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: [],
};
const empty = { sections: [], assignments: {}, starred: [] };
const evidence = (ids = ["alpha", "beta"]) =>
  ids.flatMap((id) => [
    roster(authority, id, [viewer.pubkey]),
    metadata(authority, id, id.toUpperCase()),
  ]);
const checkpoint = () => ({
  version: 1,
  viewer: viewer.pubkey,
  community,
  authority: authority.pubkey,
  events: evidence(),
  profiles: [],
  preferenceEvents: [],
});
const owners: ReturnType<typeof createPresentation>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(value: unknown = checkpoint(), read?: () => Promise<unknown>) {
  let stored: unknown = value;
  const disk: CheckpointStorage = {
    read: read ?? (async () => stored),
    write: vi.fn(async (value) => {
      stored = structuredClone(value);
    }),
    clear: vi.fn(async () => {
      stored = undefined;
    }),
    close: vi.fn(),
  };
  const decode = vi.fn(async () => groups);
  const changed = vi.fn();
  const owner = createPresentation(
    viewer.pubkey,
    community,
    disk,
    decode,
    changed,
  );
  owners.push(owner);
  return {
    owner,
    disk,
    decode,
    changed,
    stored: () => stored as ReturnType<typeof checkpoint> | undefined,
  };
}
const source = (events = evidence(), extra = {}) => ({
  ready: true,
  complete: true,
  events,
  profiles: [],
  accessEpoch: 1,
  ...extra,
});
async function restored(owner: ReturnType<typeof createPresentation>) {
  await vi.waitFor(() => expect(owner.pending()).toBe(false));
}

it("restores one coherent inert projection from reverified signed evidence", async () => {
  const h = setup();
  expect(h.owner.snapshot()).toBeUndefined();
  await restored(h.owner);
  expect(h.owner.snapshot()?.channels.map((row) => row.name)).toEqual([
    "ALPHA",
    "BETA",
  ]);
  expect(h.owner.snapshot()?.preferences).toEqual(groups);
  expect(h.decode).toHaveBeenCalledTimes(1);
});

it("preserves labels while metadata/preferences are pending, then accepts successful empty groups", async () => {
  const h = setup();
  await restored(h.owner);
  h.owner.connect(authority.pubkey);
  h.owner.accept(source([roster(authority, "alpha", [viewer.pubkey])]));
  expect(h.owner.snapshot()?.channels).toMatchObject([
    { id: "alpha", name: "ALPHA" },
  ]);
  expect(h.owner.snapshot()?.preferences).toEqual(groups);
  h.owner.accept(
    source(
      [
        roster(authority, "alpha", [viewer.pubkey]),
        metadata(authority, "alpha", "New", 1700000001),
      ],
      { preferences: empty, preferenceEvents: [] },
    ),
  );
  expect(h.owner.snapshot()?.channels[0]?.name).toBe("New");
  expect(h.owner.snapshot()?.preferences).toEqual(empty);
});

it("keeps omitted rows on disk for partial reads, but never in the actionable projection", async () => {
  const h = setup();
  await restored(h.owner);
  h.owner.connect(authority.pubkey);
  h.owner.accept(source(evidence(["alpha"]), { complete: false }));
  expect(h.owner.snapshot()?.channels.map((row) => row.id)).toEqual(["alpha"]);
  await vi.waitFor(() => expect(h.disk.write).toHaveBeenCalled());
  expect(
    h
      .stored()
      ?.events.some((event) =>
        event.tags.some(([key, id]) => key === "d" && id === "beta"),
      ),
  ).toBe(true);
  h.owner.accept(source(evidence(["alpha"])));
  await vi.waitFor(() =>
    expect(
      h
        .stored()
        ?.events.every(
          (event) =>
            !event.tags.some(([key, id]) => key === "d" && id === "beta"),
        ),
    ).toBe(true),
  );
});

it("merges a late disk read without replacing fresh metadata or resurrecting omissions", async () => {
  const held = deferred<unknown>();
  const h = setup(undefined, () => held.promise);
  h.owner.connect(authority.pubkey);
  h.owner.accept(
    source(
      [
        roster(authority, "alpha", [viewer.pubkey]),
        metadata(authority, "alpha", "Fresh", 1700000002),
      ],
      { preferences: empty, preferenceEvents: [] },
    ),
  );
  held.resolve(checkpoint());
  await restored(h.owner);
  expect(h.owner.snapshot()?.channels.map((row) => row.name)).toEqual([
    "Fresh",
  ]);
  expect(h.owner.snapshot()?.preferences).toEqual(empty);
});

it("removes denied rows and purged DM names before notifications and writeback", async () => {
  const dm = [
    roster(authority, "dm", [viewer.pubkey, peer.pubkey]),
    signed(authority, {
      kind: 39000,
      tags: [["d", "dm"], ["t", "dm"], ["hidden"]],
      content: "",
    }),
  ];
  const h = setup({
    ...checkpoint(),
    events: [...evidence(), ...dm],
    profiles: [profile(peer, { name: "Peer" })],
  });
  await restored(h.owner);
  h.owner.connect(authority.pubkey);
  h.owner.accept(source([...evidence(), ...dm]));
  expect(
    h.owner.snapshot()?.channels.find((row) => row.id === "dm")?.name,
  ).toBe("Peer");
  h.owner.accept(
    source(dm, { complete: false, denied: ["alpha", "beta"], accessEpoch: 2 }),
  );
  expect(h.owner.snapshot()?.channels.map((row) => row.name)).toEqual([
    peer.pubkey.slice(0, 10),
  ]);
  await vi.waitFor(() => expect(h.stored()?.profiles).toEqual([]));
  expect(h.stored()?.events.map((event) => event.id)).toEqual(
    dm.map((event) => event.id),
  );
});

it("serializes clear after an already-started write and fences a late restore", async () => {
  const h = setup();
  await restored(h.owner);
  const writing = deferred<void>();
  const started = deferred<void>();
  const write = h.disk.write;
  h.disk.write = async (value) => {
    started.resolve();
    await writing.promise;
    await write(value);
  };
  h.owner.connect(authority.pubkey);
  h.owner.accept(source(evidence(["alpha"])));
  await started.promise;
  const cleared = h.owner.clear();
  expect(h.owner.snapshot()).toBeUndefined();
  writing.resolve();
  await cleared;
  expect(h.stored()).toBeUndefined();

  const reading = deferred<unknown>();
  const next = setup(undefined, () => reading.promise);
  await next.owner.clear();
  reading.resolve(checkpoint());
  await restored(next.owner);
  expect(next.owner.snapshot()).toBeUndefined();
  expect(next.disk.write).not.toHaveBeenCalled();
});

it.each([
  { ...checkpoint(), version: 2 },
  { ...checkpoint(), viewer: peer.pubkey },
  { ...checkpoint(), community: "https://elsewhere.example" },
  { ...checkpoint(), events: [{ ...evidence()[0], sig: "invalid" }] },
  { ...checkpoint(), extra: "x".repeat(4 * 1024 * 1024) },
])(
  "rejects unsupported, wrong-scope, corrupt or oversized records",
  async (value) => {
    const h = setup(value);
    await restored(h.owner);
    expect(h.owner.snapshot()).toBeUndefined();
    expect(h.decode).not.toHaveBeenCalled();
  },
);

it("drops an old authority and ignores a decoder completing after disposal", async () => {
  const h = setup();
  await restored(h.owner);
  h.owner.connect(peer.pubkey);
  expect(h.owner.snapshot()).toBeUndefined();
  await vi.waitFor(() => expect(h.disk.clear).toHaveBeenCalled());
  const held = deferred<typeof groups>();
  const late = setup();
  late.decode.mockImplementation(() => held.promise);
  await vi.waitFor(() => expect(late.decode).toHaveBeenCalled());
  late.owner.dispose();
  const calls = late.changed.mock.calls.length;
  held.resolve(groups);
  await held.promise;
  await Promise.resolve();
  expect(late.changed).toHaveBeenCalledTimes(calls);
  expect(late.owner.snapshot()).toBeUndefined();
});

it("falls back after storage failure and persists resolved live evidence", async () => {
  const h = setup(undefined, async () => {
    throw new Error("Storage blocked");
  });
  await restored(h.owner);
  h.owner.connect(authority.pubkey);
  h.owner.accept(
    source(evidence(), {
      preferences: empty,
      preferenceEvents: [] as RelayEvent[],
    }),
  );
  expect(h.owner.snapshot()?.channels).toHaveLength(2);
  await vi.waitFor(() => expect(h.disk.write).toHaveBeenCalled());
});

it.each(["complete", "denied"])(
  "invalidates disk after decoder failure and %s removal before the next restart",
  async (mode) => {
    const h = setup();
    h.decode.mockRejectedValue(new Error("Local decoder unavailable"));
    await restored(h.owner);
    expect(h.owner.snapshot()).toBeUndefined();
    h.owner.connect(authority.pubkey);
    h.owner.accept(
      source(evidence(["alpha"]), {
        complete: mode === "complete",
        denied: mode === "denied" ? ["beta"] : [],
      }),
    );
    // A disposal barrier includes every queued write/clear, as at app shutdown.
    await Promise.resolve();
    h.owner.dispose();
    await vi.waitFor(() => expect(h.disk.close).toHaveBeenCalled());
    const next = setup(h.stored() ?? null);
    await restored(next.owner);
    expect(
      next.owner.snapshot()?.channels.some((row) => row.id === "beta") ?? false,
    ).toBe(false);
    // Once live encrypted preferences are available a new coherent checkpoint is saved.
    next.owner.connect(authority.pubkey);
    next.owner.accept(
      source(evidence(["alpha"]), { preferences: empty, preferenceEvents: [] }),
    );
    await vi.waitFor(() => expect(next.stored()?.events).toHaveLength(2));
  },
);

it("does not restore denied-channel profiles when disk decoding finishes after fresh roster pruning", async () => {
  const held = deferred<typeof groups>();
  const dm = [
    roster(authority, "dm", [viewer.pubkey, peer.pubkey]),
    signed(authority, {
      kind: 39000,
      tags: [["d", "dm"], ["t", "dm"], ["hidden"]],
      content: "",
    }),
  ];
  const h = setup({
    ...checkpoint(),
    events: [...evidence(), ...dm],
    profiles: [profile(peer, { name: "Private Peer" })],
  });
  h.decode.mockImplementation(() => held.promise);
  await vi.waitFor(() => expect(h.decode).toHaveBeenCalled());
  h.owner.connect(authority.pubkey);
  h.owner.accept(source(evidence(["alpha"])));
  held.resolve(groups);
  await restored(h.owner);
  expect(h.owner.snapshot()?.channels.map((row) => row.id)).toEqual(["alpha"]);
  await vi.waitFor(() => expect(h.stored()?.profiles).toEqual([]));
});
