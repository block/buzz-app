import { afterEach, expect, it, vi } from "vitest";
import { createOutbox, type OutgoingEvent, type OutboxStorage } from "./outbox";
import { keypair, signed, flush } from "./testing";
const viewer = keypair();
const input = {
  kind: 9,
  content: "@Agent hello :wave:",
  tags: [
    ["h", "c"],
    ["emoji", "wave", "https://example.com/original.png"],
  ],
};
const draft = {
  id: "12345678-abcd-4000-8000-123456789abc",
  createdAt: 1700000000,
};
const owners: ReturnType<typeof createOutbox>[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(storage: OutboxStorage = { load: () => [], save() {} }) {
  const sign = vi.fn(async (template) => signed(viewer, template));
  const publish = vi.fn(async (_event: import("./events").RelayEvent) => {});
  const owner = createOutbox(viewer.pubkey, { sign, publish }, storage);
  owners.push(owner);
  return { ...owner, sign, publish };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
it("awaits hydration and durable intent, coalesces identical drafts but rejects conflicting concurrent inputs", async () => {
  const load = deferred<readonly OutgoingEvent[]>();
  const save = deferred<void>();
  const persisted = vi.fn(() => save.promise);
  const h = setup({ load: () => load.promise, save: persisted });
  const first = h.outbox.sendDraft(input, draft);
  const second = h.outbox.sendDraft(input, draft);
  const conflict = h.outbox.sendDraft(
    { ...input, content: "different" },
    draft,
  );
  const rejected = expect(conflict).rejects.toThrow(/conflict/);
  await flush();
  expect(persisted).not.toHaveBeenCalled();
  expect(h.outbox.snapshot()).toHaveLength(0);
  load.resolve([]);
  await rejected;
  await flush();
  expect(persisted).toHaveBeenCalledTimes(1);
  const id = h.outbox.snapshot()[0]?.event.id;
  expect(id).toBeDefined();
  let returned = false;
  void first.then(() => {
    returned = true;
  });
  h.outbox.retry(id ?? "");
  await h.outbox.dismiss(id ?? "");
  expect(h.sign).not.toHaveBeenCalled();
  expect(returned).toBe(false);
  save.resolve();
  expect(await first).toBe(await second);
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(await h.outbox.sendDraft(input, draft)).toBe(id);
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(1);
});
it("storage rejection retains known-unsent intent; hydration failure blocks lookup and send", async () => {
  const h = setup({
    load: () => [],
    save: () => {
      throw new Error("disk full");
    },
  });
  await expect(h.outbox.sendDraft(input, draft)).rejects.toThrow("disk full");
  expect(await h.outbox.findDraft(draft.id)).toBe(
    h.outbox.snapshot()[0]?.event.id,
  );
  expect(h.outbox.snapshot()[0]?.delivery).toBe("failed");
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  const broken = setup({
    load: () => Promise.reject(new Error("unreadable")),
    save() {},
  });
  await expect(broken.outbox.findDraft(draft.id)).rejects.toThrow("unreadable");
  await expect(broken.outbox.sendDraft(input, draft)).rejects.toThrow(
    "unreadable",
  );
});
it.each(["seen", "unknown", "accepted"] as const)(
  "restores %s without delivery, explicit retry reuses the signed event",
  async (delivery) => {
    const event = signed(viewer, {
      ...input,
      created_at: draft.createdAt,
      tags: [...input.tags, ["client-id", draft.id]],
    });
    const h = setup({
      load: () => [{ event, signed: event, delivery }],
      save() {},
    });
    expect(await h.outbox.findDraft(draft.id)).toBe(event.id);
    expect(await h.outbox.sendDraft(input, draft)).toBe(event.id);
    await expect(
      h.outbox.sendDraft({ ...input, tags: [["h", "other"]] }, draft),
    ).rejects.toThrow(/conflict/);
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
    if (delivery !== "seen") {
      h.outbox.retry(event.id);
      await flush();
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).toHaveBeenCalledTimes(1);
    } else {
      h.purgeConfirmed(() => false);
      expect(await h.outbox.findDraft(draft.id)).toBeUndefined();
      expect(h.publish).not.toHaveBeenCalled();
    }
  },
);
it("confirmed eviction is unknown rather than a durable dedupe claim", async () => {
  const event = signed(viewer, {
    ...input,
    created_at: draft.createdAt,
    tags: [...input.tags, ["client-id", draft.id]],
  });
  const loaded = Array.from({ length: 140 }, (_, index) => {
    if (index === 0) return { event, signed: event, delivery: "seen" as const };
    const next = signed(viewer, {
      ...input,
      content: `${index}${"x".repeat(32000)}`,
      created_at: draft.createdAt,
    });
    return { event: next, signed: next, delivery: "seen" as const };
  });
  const h = setup({ load: () => loaded, save() {} });
  expect(await h.outbox.findDraft(draft.id)).toBeUndefined();
  expect(h.publish).not.toHaveBeenCalled();
});
it("captures immutable inputs before awaiting hydration", async () => {
  const load = deferred<readonly OutgoingEvent[]>();
  const h = setup({ load: () => load.promise, save() {} });
  const mutable = structuredClone(input);
  const sending = h.outbox.sendDraft(mutable, draft);
  mutable.content = "mutated";
  mutable.tags[0]?.push("mutated");
  load.resolve([]);
  const id = await sending;
  expect(
    h.outbox.snapshot().find((item) => item.event.id === id)?.event.content,
  ).toBe(input.content);
});

it("captures the draft UUID as well as payload before hydration and refuses supplied client-id tags", async () => {
  const load = deferred<readonly OutgoingEvent[]>();
  const h = setup({ load: () => load.promise, save() {} });
  const mutable = { ...draft };
  const sending = h.outbox.sendDraft(input, mutable);
  mutable.id = crypto.randomUUID();
  mutable.createdAt++;
  load.resolve([]);
  const id = await sending;
  expect(await h.outbox.findDraft(draft.id)).toBe(id);
  expect(await h.outbox.findDraft(mutable.id)).toBeUndefined();
  await expect(
    h.outbox.sendDraft(
      { ...input, tags: [...input.tags, ["client-id", draft.id]] },
      draft,
    ),
  ).rejects.toThrow(/Invalid draft/);
});
it("disposal during hydration never commits or starts a retired draft", async () => {
  const load = deferred<readonly OutgoingEvent[]>();
  const save = vi.fn();
  const h = setup({ load: () => load.promise, save });
  const sending = h.outbox.sendDraft(input, draft);
  const rejection = expect(sending).rejects.toMatchObject({
    name: "AbortError",
  });
  h.dispose();
  load.resolve([]);
  await rejection;
  expect(save).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "a save rejection (committed: %s) retains exact candidate for explicit retry, not automatic delivery",
  async (committed) => {
    let records: readonly OutgoingEvent[] = [];
    let reject = true;
    const h = setup({
      load: () => [],
      save(items) {
        if (!reject || committed) records = structuredClone(items);
        if (reject) throw new Error("disk unavailable");
      },
    });
    await expect(h.outbox.sendDraft(input, draft)).rejects.toThrow(
      "disk unavailable",
    );
    const id = await h.outbox.findDraft(draft.id);
    expect(id).toBeDefined();
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
    reject = false;
    expect(await h.outbox.sendDraft(input, draft)).toBe(id);
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
    // Restored known failed intent is actionable without reconstructing current emoji.
    const retrying = committed ? setup({ load: () => records, save() {} }) : h;
    if (committed)
      expect(retrying.outbox.snapshot()[0]?.delivery).toBe("failed");
    if (!id) throw new Error("Missing retained candidate");
    retrying.outbox.retry(id);
    await flush();
    expect(retrying.publish).toHaveBeenCalledTimes(1);
    expect(retrying.publish.mock.calls[0]?.[0]).toMatchObject({
      id,
      tags: [...input.tags, ["client-id", draft.id]],
    });
  },
);
it("failure persisting signed intent before publisher entry is known-unsent and retries that signed ID", async () => {
  let writes = 0;
  const h = setup({
    load: () => [],
    save() {
      if (++writes === 2) throw new Error("signed save failed");
    },
  });
  const id = await h.outbox.sendDraft(input, draft);
  await flush();
  expect(h.outbox.snapshot()[0]).toMatchObject({
    delivery: "failed",
    signed: { id },
  });
  expect(h.publish).not.toHaveBeenCalled();
  h.outbox.retry(id);
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it("ambiguous receipt after dispatch restores conservatively and only explicit retry republishes the same signature", async () => {
  let records: readonly OutgoingEvent[] = [];
  const ack = deferred<void>();
  const first = setup({
    load: () => [],
    save(items) {
      records = structuredClone(items);
    },
  });
  first.publish.mockImplementation(() => ack.promise);
  const id = await first.outbox.sendDraft(input, draft);
  await flush();
  expect(first.publish).toHaveBeenCalledTimes(1);
  ack.reject(new Error("lost receipt"));
  await flush();
  expect(first.outbox.snapshot()[0]?.delivery).toBe("unknown");
  const exact = first.publish.mock.calls[0]?.[0];
  first.dispose();
  const next = setup({ load: () => records, save() {} });
  expect(await next.outbox.findDraft(draft.id)).toBe(id);
  await flush();
  expect(next.publish).not.toHaveBeenCalled();
  next.outbox.retry(id);
  await flush();
  expect(next.sign).not.toHaveBeenCalled();
  expect(next.publish.mock.calls[0]?.[0]).toEqual(exact);
});
it("failed candidate retention obeys the existing pending-operation cap", async () => {
  const loaded = Array.from({ length: 256 }, (_, index) => {
    const event = signed(viewer, {
      ...input,
      content: String(index),
      created_at: draft.createdAt,
      tags: [...input.tags, ["client-id", crypto.randomUUID()]],
    });
    return { event, signed: event, delivery: "failed" as const };
  });
  const h = setup({ load: () => loaded, save() {} });
  await expect(h.outbox.sendDraft(input, draft)).rejects.toThrow(
    "Too many outstanding",
  );
  expect(h.outbox.snapshot()).toHaveLength(256);
  expect(await h.outbox.findDraft(draft.id)).toBeUndefined();
  expect(h.publish).not.toHaveBeenCalled();
});
