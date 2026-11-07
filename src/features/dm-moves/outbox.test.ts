import { afterEach, assert, expect, it, vi } from "vitest";
import { createOutbox, type OutgoingEvent } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import { movedTemplate } from "./plan";
import { controlTemplate, type MoveRequest } from "./protocol";
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
const author = keypair();
const req: MoveRequest = {
  type: "request",
  move: "00000000-0000-4000-8000-000000000001",
  worker: "00000000-0000-4000-8000-000000000002",
  target: "target",
  expires: 200,
  authors: [[author.pubkey, author.pubkey]],
};
const template = movedTemplate(
  req,
  {
    original: "a".repeat(64),
    author: author.pubkey,
    ms: 100000,
    content: "Before edit",
    tags: [],
  },
  "b".repeat(64),
  "b".repeat(64),
);
it("fences a copy invalidated while signing and never restores its live admission", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let valid = true;
  const publish = vi.fn(async () => {});
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (value: readonly OutgoingEvent[]) => {
      records = structuredClone(value);
    },
  };
  const sign = vi.fn(async (input) => {
    await gate;
    return signed(author, input);
  });
  const owner = createOutbox(author.pubkey, { sign, publish }, storage);
  owners.push(owner);
  await owner.ready;
  const id = owner.outbox.send(
    template,
    { key: "dm-move:copy", value: "1" },
    () => valid,
  );
  try {
    await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
    valid = false;
  } finally {
    release();
  }
  await vi.waitFor(() =>
    expect(
      owner.outbox.snapshot().find((e) => e.event.id === id)?.delivery,
    ).toBe("failed"),
  );
  expect(publish).not.toHaveBeenCalled();
  owner.dispose();
  const restored = createOutbox(
    author.pubkey,
    { sign: async (input) => signed(author, input), publish },
    storage,
  );
  owners.push(restored);
  await restored.ready;
  expect(() => restored.outbox.retry(id)).toThrow();
  expect(publish).not.toHaveBeenCalled();
});
it.each([
  ["copy", template],
  [
    "request",
    controlTemplate("dm", {
      ...req,
      expires: Date.parse("2026-11-06T00:00:00Z") / 1000 + 3600,
    }),
  ],
  [
    "commit",
    controlTemplate("dm", {
      type: "commit",
      move: req.move,
      request: "a".repeat(64),
      nonce: req.worker,
      through: 100000,
    }),
  ],
  [
    "root",
    {
      kind: 9,
      content: "Moved from a DM",
      tags: [
        ["h", "target"],
        ["buzz:dm-move-root", req.move],
      ],
    },
  ],
])(
  "retires an uncertain guarded %s only after expiry and authoritative readback",
  async (_name, operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    const publish = vi.fn(async () => {
      throw new Error("ACK lost");
    });
    const owner = createOutbox(
      author.pubkey,
      { sign: async (input) => signed(author, input), publish },
      { load: () => [], save: () => {} },
    );
    owners.push(owner);
    await owner.ready;
    const id = owner.outbox.send(
      operation,
      { key: "dm-move:copy", value: "1" },
      () => true,
    );
    await vi.waitFor(() =>
      expect(
        owner.outbox.snapshot().find((e) => e.event.id === id)?.delivery,
      ).toBe("unknown"),
    );
    const verify = vi.fn(async () => undefined);
    await expect(owner.outbox.acknowledge(id, verify)).rejects.toThrow(
      "15-minute",
    );
    expect(verify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(901000);
    await owner.outbox.acknowledge(id, verify);
    expect(verify).toHaveBeenCalledOnce();
    expect(
      owner.outbox.snapshot().find((e) => e.event.id === id),
    ).toBeUndefined();
  },
);
it("does not let ordinary unguarded messages use copy retirement", async () => {
  vi.useFakeTimers();
  const owner = createOutbox(
    author.pubkey,
    {
      sign: async (input) => signed(author, input),
      publish: async () => {
        throw new Error("ACK lost");
      },
    },
    { load: () => [], save: () => {} },
  );
  owners.push(owner);
  await owner.ready;
  const id = owner.outbox.send(template, { key: "dm-move:copy", value: "1" });
  await vi.waitFor(() =>
    expect(
      owner.outbox.snapshot().find((e) => e.event.id === id)?.delivery,
    ).toBe("unknown"),
  );
  await vi.advanceTimersByTimeAsync(901000);
  const item = owner.outbox.snapshot().find((e) => e.event.id === id);
  assert.exists(item);
  await expect(
    owner.outbox.acknowledge(id, async () => undefined),
  ).rejects.toThrow();
});
