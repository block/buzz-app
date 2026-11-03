import { afterEach, assert, expect, it, vi } from "vitest";
import { getEventHash } from "nostr-tools";
import {
  PublishRejected,
  createOutbox,
  type OutboxStorage,
  type OutgoingEvent,
} from "./outbox";
import type { RelayEvent } from "./events";
import { keypair, signed } from "./testing";

const viewer = keypair();
const channel = "f0".repeat(16);
const proposal = "1".repeat(64);
const owners: ReturnType<typeof createOutbox>[] = [];

function memoryStorage(): OutboxStorage {
  let records: readonly OutgoingEvent[] = [];
  return {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
    },
  };
}

function setup(publish = vi.fn(async (_event: RelayEvent) => {})) {
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const owner = createOutbox(viewer.pubkey, { sign, publish }, memoryStorage());
  owners.push(owner);
  return { ...owner, sign, publish };
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

const imported = (created_at = 1_735_732_800) => ({
  kind: 9 as const,
  created_at,
  tags: [
    ["h", channel],
    ["import", proposal],
    ["source", "slack", "1735732800.000100"],
  ],
  content: "Hello from the archive",
});

it("publishes an imported event at its original time with a deterministic id and no client tags", async () => {
  const h = setup();
  await h.ready;
  const input = imported();
  const id = h.sendAt(input);
  expect(id).toBe(
    getEventHash({ ...input, pubkey: viewer.pubkey, tags: input.tags }),
  );
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  const sent = h.publish.mock.calls[0]?.[0];
  assert.exists(sent);
  expect(sent.id).toBe(id);
  expect(sent.created_at).toBe(1_735_732_800);
  expect(sent.tags).toEqual(input.tags);
  expect(
    sent.tags.some(([name]) => name === "client-id" || name === "ms"),
  ).toBe(false);
  await vi.waitFor(() =>
    expect(
      h.local.snapshot().find((item) => item.event.id === id)?.delivery,
    ).toBe("accepted"),
  );
});

it("returns the same id for a resubmitted event without publishing twice", async () => {
  let release = () => {};
  const publish = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const h = setup(publish);
  await h.ready;
  const first = h.sendAt(imported());
  const second = h.sendAt(imported());
  expect(second).toBe(first);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
  release();
});

it("refuses imported events without exactly one import tag, with bad times, or of other kinds", async () => {
  const h = setup();
  await h.ready;
  const base = imported();
  expect(() =>
    h.sendAt({
      ...base,
      tags: base.tags.filter(([name]) => name !== "import"),
    }),
  ).toThrow("exactly one import tag");
  expect(() =>
    h.sendAt({ ...base, tags: [...base.tags, ["import", proposal]] }),
  ).toThrow("exactly one import tag");
  expect(() =>
    h.sendAt({
      ...base,
      created_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toThrow("time is invalid");
  expect(() => h.sendAt({ ...base, created_at: -1 })).toThrow(
    "time is invalid",
  );
  expect(() => h.sendAt({ ...base, kind: 1 as unknown as 9 })).toThrow(
    "cannot publish",
  );
  expect(() => h.sendAt({ ...base, content: " " })).toThrow("empty");
  expect(h.publish).not.toHaveBeenCalled();
});

it("keeps import records and imported events off the ordinary send path", async () => {
  const h = setup();
  await h.ready;
  expect(() =>
    h.outbox.send({
      kind: 9,
      content: "x",
      tags: [
        ["h", channel],
        ["import", proposal],
      ],
    }),
  ).toThrow("only by the host import service");
  for (const kind of [42110, 42111, 42112, 42113])
    expect(() =>
      h.outbox.send({ kind, content: "{}", tags: [["h", channel]] }),
    ).toThrow("only by the host import service");
  expect(() =>
    h.sendRecord({ kind: 9, content: "x", tags: [["h", channel]] }),
  ).toThrow("Not a conversation import record");
  const id = h.sendRecord({
    kind: 42111,
    content: '{"v":1}',
    tags: [
      ["h", channel],
      ["e", proposal],
    ],
  });
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  expect(h.publish.mock.calls[0]?.[0]?.id).toBe(id);
});

it("keeps the relay's refusal text for a rejected import", async () => {
  const publish = vi.fn(async () => {
    throw new PublishRejected(
      "invalid: import event is outside the proposal range",
    );
  });
  const h = setup(publish);
  await h.ready;
  const id = h.sendAt(imported());
  await vi.waitFor(() =>
    expect(
      h.local.snapshot().find((item) => item.event.id === id)?.delivery,
    ).toBe("failed"),
  );
  const item = h.local.snapshot().find((entry) => entry.event.id === id);
  expect(item?.reason ?? item?.error).toBe(
    "invalid: import event is outside the proposal range",
  );
});

const record = (kind = 42111) => ({
  kind,
  content: '{"v":1}',
  tags: [
    ["h", channel],
    ["e", proposal],
  ],
});

it("signs import records with exactly their protocol tags", async () => {
  const h = setup();
  await h.ready;
  const id = h.sendRecord(record());
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  const sent = h.publish.mock.calls[0]?.[0];
  expect(sent?.id).toBe(id);
  expect(sent?.tags).toEqual(record().tags);
  const proposed = h.sendRecord({
    kind: 42110,
    content: '{"v":1}',
    tags: [["h", channel]],
  });
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  expect(h.publish.mock.calls[1]?.[0]?.id).toBe(proposed);
  expect(h.publish.mock.calls[1]?.[0]?.tags).toEqual([["h", channel]]);
});

it("orders a second record about the same proposal after the first", async () => {
  const h = setup();
  await h.ready;
  const first = h.sendRecord(record());
  const second = h.sendRecord({ ...record(), content: '{"v":1,"n":2}' });
  const events = h.local.snapshot().map((item) => item.event);
  const at = (id: string) =>
    events.find((event) => event.id === id)?.created_at ?? 0;
  expect(at(second)).toBeGreaterThan(at(first));
});

it("lets no send or change listener forge import writes while a record is sent", async () => {
  const h = setup();
  await h.ready;
  const forged: unknown[] = [];
  const attempt = (input: Parameters<typeof h.outbox.send>[0]) => {
    try {
      forged.push(h.outbox.send(input));
    } catch (error) {
      forged.push(error instanceof Error ? error.message : error);
    }
  };
  const observed = vi.fn(() => {
    attempt({
      kind: 9,
      content: "forged history",
      tags: [
        ["h", channel],
        ["import", proposal],
        ["source", "slack", "1"],
      ],
    });
    return undefined;
  });
  h.outbox.observeSend(observed);
  let fired = false;
  h.outbox.subscribe(() => {
    if (fired) return;
    fired = true;
    attempt(record());
    attempt({ kind: 42110, content: '{"v":1}', tags: [["h", channel]] });
  });
  h.sendRecord(record(42113));
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  // A record is not fresh user intent: send observers never see it.
  expect(observed).not.toHaveBeenCalled();
  h.outbox.send({ kind: 9, content: "hello", tags: [["h", channel]] });
  expect(observed).toHaveBeenCalledOnce();
  expect(forged).toEqual([
    "Conversation import events are published only by the host import service",
    "Conversation import events are published only by the host import service",
    "Conversation import events are published only by the host import service",
  ]);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  expect(
    h.local
      .snapshot()
      .filter(
        (item) =>
          item.event.kind !== 42113 &&
          (item.event.kind >= 42110 ||
            item.event.tags.some(([name]) => name === "import")),
      ),
  ).toEqual([]);
});

it("retries import entries only for the host writer", async () => {
  let refuse = true;
  const publish = vi.fn(async () => {
    if (refuse) throw new PublishRejected("rate-limited: slow down");
  });
  const h = setup(publish);
  await h.ready;
  const id = h.sendAt(imported());
  const recordId = h.sendRecord(record());
  await vi.waitFor(() =>
    expect(
      h.local
        .snapshot()
        .filter((item) => item.delivery === "failed")
        .map((item) => item.event.id)
        .sort(),
    ).toEqual([id, recordId].sort()),
  );
  expect(() => h.outbox.retry(id)).toThrow("only by the host import service");
  expect(() => h.outbox.retry(recordId)).toThrow(
    "only by the host import service",
  );
  refuse = false;
  h.retryImport(id);
  await vi.waitFor(() =>
    expect(
      h.local.snapshot().find((item) => item.event.id === id)?.delivery,
    ).toBe("accepted"),
  );
});

it("does not count refused import entries toward the outstanding limit", async () => {
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.tags.some(([name]) => name === "import"))
      throw new PublishRejected("invalid: import event malformed: test");
    await new Promise(() => {});
  });
  const h = setup(publish);
  await h.ready;
  for (let index = 0; index < 256; index++)
    h.sendAt(imported(1_735_732_800 + index));
  await vi.waitFor(
    () =>
      expect(
        h.local.snapshot().filter((item) => item.delivery === "failed"),
      ).toHaveLength(256),
    { timeout: 10_000 },
  );
  expect(() =>
    h.outbox.send({ kind: 9, content: "still sends", tags: [["h", channel]] }),
  ).not.toThrow();
});
