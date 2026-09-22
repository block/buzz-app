import { afterEach, expect, it, vi } from "vitest";
import { keypair, signed as relaySigned } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import type { RelayReader } from "../relay/reader";
import type { ReadTransport } from "../relay/transport";
import { createComputeStatus, readComputeEvents } from "./status";
import type { MeshSnapshot } from "../../bundled/community-compute/types";

import type { EventTemplate } from "nostr-tools";
function signed(
  key: Parameters<typeof relaySigned>[0],
  template: Partial<EventTemplate> & Pick<EventTemplate, "kind">,
) {
  return relaySigned(key, { content: "", tags: [], ...template });
}
const authority = keypair();
const member = keypair();
const roster = (keys = [member.pubkey], created_at = 100) =>
  signed(authority, {
    kind: 13534,
    created_at,
    tags: keys.map((key) => ["member", key]),
  });
const note = (index: number) =>
  signed(member, {
    kind: 30003,
    created_at: 100,
    tags: [
      ["k", "buzz-mesh-status"],
      ["d", `${index}`],
    ],
  });
const abort = () => new AbortController().signal;
const empty: MeshSnapshot = {
  memberCount: 1,
  sharingDeviceCount: 0,
  sharedCapacityGb: null,
  models: [],
  devices: [],
  includesSelf: false,
  reason: "No one is sharing",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.useRealTimers();
});

it("reads every same-second status page using the relay composite cursor", async () => {
  const members = roster();
  const notes = Array.from({ length: 102 }, (_, i) => note(i)).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const read = vi.fn<RelayReader["read"]>(async ([filter]) => {
    if (filter?.kinds?.includes(13534)) return [members];
    expect(filter?.authors).toEqual([member.pubkey]);
    return notes
      .filter((event) => !filter?.before_id || event.id > filter.before_id)
      .slice(0, 100);
  });
  const events = await readComputeEvents({ read }, authority.pubkey, abort());
  expect(events).toEqual([members, ...notes]);
  expect(read.mock.calls[2]?.[0][0]).toMatchObject({
    until: 100,
    before_id: notes[99]?.id,
  });
  expect(read).toHaveBeenCalledTimes(4);
});
it("distinguishes an authoritative empty roster from a missing or wrong-author roster", async () => {
  expect(
    await readComputeEvents(
      { read: async () => [roster([])] },
      authority.pubkey,
      abort(),
    ),
  ).toHaveLength(1);
  for (const events of [[], [signed(member, { kind: 13534 })]])
    await expect(
      readComputeEvents(
        { read: async () => events },
        authority.pubkey,
        abort(),
      ),
    ).rejects.toThrow(/roster/);
});
it("fails closed when the roster changes while status is paginated", async () => {
  const read = vi
    .fn<RelayReader["read"]>()
    .mockResolvedValueOnce([roster()])
    .mockResolvedValueOnce([note(1)])
    .mockResolvedValueOnce([roster([], 101)]);
  await expect(
    readComputeEvents({ read }, authority.pubkey, abort()),
  ).rejects.toThrow(/membership changed/);
});
it("rejects repeated full pages, foreign authors and unrelated kinds", async () => {
  const full = Array.from({ length: 100 }, (_, i) => note(i));
  for (const page of [
    full,
    [signed(authority, { kind: 30003, tags: [["k", "buzz-mesh-status"]] })],
    [signed(member, { kind: 9 })],
  ]) {
    const read: RelayReader["read"] = async ([filter]) =>
      filter?.kinds?.includes(13534) ? [roster()] : page;
    await expect(
      readComputeEvents({ read }, authority.pubkey, abort()),
    ).rejects.toThrow(/pagination/);
  }
});
it("batches large membership author filters without dropping members", async () => {
  const members = Array.from({ length: 201 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const r = roster(members);
  const read = vi.fn<RelayReader["read"]>(async ([filter]) =>
    filter?.kinds?.includes(13534) ? [r] : [],
  );
  await readComputeEvents({ read }, authority.pubkey, abort());
  expect(
    read.mock.calls.flatMap(([filters]) =>
      filters.flatMap((f) =>
        f.kinds?.includes(30003) ? (f.authors ?? []) : [],
      ),
    ),
  ).toEqual(members);
});
function harness(project = vi.fn(async () => empty)) {
  const transport: ReadTransport = {
    viewer: member.pubkey,
    relayAuthor: authority.pubkey,
    archiveAuthority: authority.pubkey,
    media: () => undefined,
    query: vi.fn(async ([filter]) =>
      filter?.kinds?.includes(13534) ? [roster()] : [],
    ),
  };
  return { transport, project, host: createComputeStatus(transport, project) };
}
it("only polls while observed, and retries a real query error", async () => {
  const h = harness();
  expect(h.transport.query).not.toHaveBeenCalled();
  vi.mocked(h.transport.query).mockRejectedValueOnce(
    new Error("Relay unavailable"),
  );
  const changed = vi.fn();
  const release = h.host.source.subscribe(changed);
  await vi.waitFor(() =>
    expect(h.host.source.snapshot()).toMatchObject({
      state: "error",
      error: "Relay unavailable",
    }),
  );
  h.host.source.retry();
  await vi.waitFor(() =>
    expect(h.host.source.snapshot()).toEqual({
      state: "ready",
      snapshot: empty,
    }),
  );
  expect(h.project).toHaveBeenCalledWith(
    [expect.objectContaining({ kind: 13534 })],
    authority.pubkey,
    member.pubkey,
  );
  release();
  expect(h.host.source.snapshot().state).toBe("loading");
  h.host.dispose();
});
it("does not infer explicit NIP-11 authority from a contact key", async () => {
  const h = harness();
  const { archiveAuthority: _, ...transport } = h.transport;
  const host = createComputeStatus(transport, h.project);
  const release = host.source.subscribe(() => {});
  await vi.waitFor(() =>
    expect(host.source.snapshot()).toMatchObject({ state: "error" }),
  );
  expect(h.transport.query).not.toHaveBeenCalled();
  release();
  host.dispose();
  h.host.dispose();
});
it.each(["unsubscribe", "dispose"])(
  "fences late native projection after %s",
  async (method) => {
    const gate = deferred<MeshSnapshot>();
    const h = harness(vi.fn(() => gate.promise));
    const changed = vi.fn();
    const release = h.host.source.subscribe(changed);
    await vi.waitFor(() => expect(h.project).toHaveBeenCalledTimes(1));
    if (method === "dispose") h.host.dispose();
    else release();
    const before = changed.mock.calls.length;
    gate.resolve(empty);
    await gate.promise;
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(before);
    h.host.dispose();
  },
);
it("expires displayed evidence while a subsequent refresh remains pending", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const snapshot: MeshSnapshot = {
    ...empty,
    devices: [
      {
        deviceId: "device",
        label: "Device",
        capacityGb: 8,
        models: ["model"],
        state: "serving",
        isSelf: false,
        reportedAt: 900,
      },
    ],
    freshnessSeconds: 120,
  };
  const h = harness(vi.fn(async () => snapshot));
  const ready = deferred<void>();
  const release = h.host.source.subscribe(() => {
    if (h.host.source.snapshot().state === "ready") ready.resolve();
  });
  await ready.promise;
  const gate = deferred<RelayEvent[]>();
  vi.mocked(h.transport.query).mockImplementation(() => gate.promise);
  await vi.advanceTimersByTimeAsync(20001);
  expect(h.host.source.snapshot()).toMatchObject({
    state: "error",
    error: expect.stringMatching(/expired/),
  });
  release();
  h.host.dispose();
  gate.resolve([]);
});
