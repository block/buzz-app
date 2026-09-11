import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import { keypair } from "./testing";
import { eventDto, type RelayEvent } from "./events";
// Test the real host codec with ephemeral identities, never a bypass signer.
// @ts-expect-error Node-only host module
import { decodeReadState, signReadState } from "../../../dev/read-state.mjs";
import type { ReadStateSigning } from "./read-state-host";

const owners: ReturnType<typeof createReadState>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function fixture() {
  const key = keypair();
  let journal: ReadJournal | undefined;
  const storage: ReadStateStorage = {
    update: vi.fn(async (change) => {
      journal = readJournal(change(journal), key.pubkey);
      return journal;
    }),
    close: vi.fn(),
  };
  let remote: RelayEvent[] = [];
  const host = {
    decode: vi.fn(async (events: readonly RelayEvent[]) =>
      decodeReadState(events, key.secret),
    ),
    sign: vi.fn(async (intent: ReadStateSigning) =>
      signReadState(intent, key.secret, 100),
    ),
    publish: vi.fn(async (event: RelayEvent) => {
      remote = [event];
    }),
  };
  const reader = { read: vi.fn(async () => remote) };
  const options = {
    viewer: key.pubkey,
    host,
    reader,
    storage,
    lock: async (_signal: AbortSignal, work: () => Promise<void>) => work(),
    now: () => 100,
    debounceMs: 60000,
  };
  const make = () => {
    const owner = createReadState(options);
    owners.push(owner);
    return owner;
  };
  return {
    key,
    host,
    reader,
    storage,
    make,
    journal: () => journal,
    setJournal: (value: ReadJournal) => {
      journal = value;
    },
  };
}
describe("durable read-state owner", () => {
  it("saves intent and exact signed event before publishing, then confirms the coordinate", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const publish = f.host.publish.getMockImplementation();
    if (!publish) throw new Error("Missing fixture publisher");
    f.host.publish.mockImplementation(async (event) => {
      expect(f.journal()?.state.frontiers.room).toBe(12);
      expect(f.journal()?.pending?.event.id).toBe(event.id);
      await publish(event);
    });
    const result = await owner.read("room", 12, () => true);
    expect(result).toMatchObject({ durability: "saved", sync: "pending" });
    await owner.flush();
    expect(owner.snapshot().status).toBe("reconciled");
    expect(f.journal()?.pending).toBeUndefined();
    expect(f.host.publish).toHaveBeenCalledTimes(1);
  });
  it("does not sign/publish after a durability failure", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));
    await expect(owner.read("room", 12, () => true)).rejects.toThrow(
      "disk full",
    );
    expect(owner.state().frontiers.room).toBeUndefined();
    expect(f.host.sign).not.toHaveBeenCalled();
    expect(f.host.publish).not.toHaveBeenCalled();
  });
  it("restores an unknown publish and retries exactly the same signed bytes before newer intent", async () => {
    const f = fixture();
    const first = f.make();
    await first.ready;
    await first.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await first.flush();
    const unknown = f.journal()?.pending?.event;
    expect(unknown).toBeDefined();
    first.dispose();
    const second = f.make();
    await second.ready;
    await second.read("room", 13, () => true);
    await second.flush();
    expect(f.host.publish.mock.calls[1]?.[0]).toEqual(unknown);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
    expect(ownerStatus(second)).toBe("reconciled");
    expect(f.journal()?.lastCreatedAt).toBe(101);
  });
  it("retains accepted-but-unobserved identity and surfaces the gap", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    f.host.publish.mockImplementation(async () => {});
    await owner.read("room", 12, () => true);
    await owner.flush();
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("observation"),
    });
    expect(f.journal()?.pending).toBeDefined();
  });
  it("fences canceled readings at transaction acceptance and never lets hydration erase later intent", async () => {
    const f = fixture();
    f.setJournal({
      ...newReadJournal(),
      state: { frontiers: { old: 20 }, overrides: {} },
    });
    const owner = f.make();
    const result = owner.read("room", 12, () => true);
    await result;
    expect(owner.state().frontiers).toEqual({ old: 20, room: 12 });
    await expect(owner.read("room", 99, () => false)).rejects.toThrow(
      "expired",
    );
    expect(owner.state().frontiers.room).toBe(12);
  });
  it("merges concurrent local windows against the latest transactional journal", async () => {
    const f = fixture();
    const a = f.make(),
      b = f.make();
    await Promise.all([a.ready, b.ready]);
    await Promise.all([a.read("a", 2, () => true), b.read("b", 3, () => true)]);
    expect(f.journal()?.state.frontiers).toEqual({ a: 2, b: 3 });
  });
  it("preserves local-only manual intent without lowering frontiers or scheduling a publish", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.read("room", 12, () => true);
    await owner.flush();
    const result = await owner.markLocalUnread("room", () => true);
    expect(result.sync).toBe("local-only");
    expect(owner.localUnread("room")).toBeGreaterThan(0);
    await owner.read("msg:one", 13, () => true);
    expect(owner.localUnread("room")).toBeGreaterThan(0);
    await owner.read("room", 12, () => true, true);
    expect(owner.localUnread("room")).toBeUndefined();
  });
  it("keeps ordinary reads publishing across growth, old-history reads and restart", async () => {
    const f = fixture(),
      first = f.make();
    await first.ready;
    const id = (n: number) => `msg:${n.toString(16).padStart(64, "0")}`;
    for (let n = 0; n < 700; n++) await first.read(id(n), 50 + n, () => true);
    await first.flush();
    expect(first.snapshot().status).toBe("reconciled");
    expect(f.host.publish).toHaveBeenCalledTimes(1);
    const published = () =>
      decodeReadState([f.host.publish.mock.calls.at(-1)?.[0]], f.key.secret)[0]
        .blob.contexts;
    expect(Object.keys(published()).length).toBeLessThan(600);
    expect(published()[id(699)]).toBe(749);
    expect(f.journal()?.state.frontiers[id(0)]).toBe(50); // Larger local cache than the wire.
    first.dispose();
    const second = f.make();
    await second.ready;
    await second.read(id(800), 1, () => true); // Old history, newly read.
    await second.flush();
    expect(second.snapshot().status).toBe("reconciled");
    expect(published()[id(800)]).toBe(1);
    expect(published()[id(699)]).toBe(749);
    for (let n = 801; n < 1600; n++) await second.read(id(n), 1, () => true);
    await second.flush();
    expect(second.snapshot().status).toBe("reconciled");
    expect(f.journal()?.state.frontiers[id(1599)]).toBe(1);
    expect(f.journal()?.state.frontiers[id(0)]).toBeUndefined();
    expect(published()[id(1599)]).toBe(1);
  }, 15000);
  it("rejects saved corruption and changed signatures without overwriting it", () => {
    const f = fixture();
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          state: { frontiers: { room: -1 }, overrides: {} },
        },
        f.key.pubkey,
      ),
    ).toThrow();
    const event = eventDto(
      signReadState(
        {
          slot: "a".repeat(32),
          createdAt: 100,
          blob: { v: 1, client_id: "x", contexts: {} },
        },
        f.key.secret,
        100,
      ),
    );
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          lastCreatedAt: 100,
          pending: { event, revision: 0 },
        },
        f.key.pubkey,
      ),
    ).toThrow("identity");
  });
});
const ownerStatus = (owner: ReturnType<typeof createReadState>) =>
  owner.snapshot().status;
