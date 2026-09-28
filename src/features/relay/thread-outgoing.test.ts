import { afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import { createOutbox, type OutboxStorage } from "./outbox";
import { createThreadView } from "./threads";
import { keypair, message, signed, scriptedTransport } from "./testing";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";

const viewer = keypair(),
  relay = keypair();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  tags = [["h", "a"]],
  storage: OutboxStorage = { load: () => [], save() {} },
) {
  const signatures: ReturnType<typeof deferred<RelayEvent>>[] = [];
  const publications: ReturnType<typeof deferred<void>>[] = [];
  const sign = vi.fn((_event: EventTemplate) => {
    const work = deferred<RelayEvent>();
    signatures.push(work);
    return work.promise;
  });
  const publish = vi.fn(() => {
    const work = deferred<void>();
    publications.push(work);
    return work.promise;
  });
  const writes = createOutbox(viewer.pubkey, { sign, publish }, storage);
  cleanups.push(writes.dispose);
  const id = writes.outbox.send({ kind: 9, content: "Request", tags });
  let accessible = true;
  const reads: ReturnType<typeof deferred<readonly RelayEvent[]>>[] = [];
  const read = vi.fn(() => {
    const work = deferred<readonly RelayEvent[]>();
    reads.push(work);
    return work.promise;
  });
  function open(messageId = id, channelId = "a", exact = false) {
    const thread = createThreadView({
      channelId,
      messageId,
      relayAuthor: relay.pubkey,
      reader: { read },
      seed: undefined,
      local: writes.local,
      canAccess: () => accessible,
      visible: (events) => (accessible ? events : []),
      notify: (listener) => listener(),
      exact,
    });
    const unsubscribe = writes.local.subscribe(thread.changed);
    cleanups.push(() => {
      unsubscribe();
      thread.view.dispose();
    });
    return thread;
  }
  async function signNext(index = 0) {
    await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(index + 1));
    const template = sign.mock.calls[index]?.[0];
    if (!template) throw new Error("Missing signature request");
    const event = signed(viewer, template);
    signatures[index]?.resolve(event);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    return event;
  }
  return {
    writes,
    id,
    read,
    reads,
    open,
    sign,
    signatures,
    publications,
    signNext,
    access: (value: boolean) => {
      accessible = value;
    },
  };
}

it.each([false, true])(
  "shows an unsigned root immediately without verified evidence or reads (exact=%s)",
  async (exact) => {
    const h = setup();
    const thread = h.open(h.id, "a", exact);
    expect(thread.view.snapshot()).toMatchObject({
      status: "ready",
      root: { id: h.id, content: "Request", delivery: "sending" },
      replies: [],
      canLoadMore: false,
    });
    expect(thread.event(h.id)).toBeUndefined();
    await thread.view.refresh();
    await thread.view.loadMore();
    await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
    expect(h.read).not.toHaveBeenCalled();
    if (exact) expect(thread.view.snapshot().target?.id).toBe(h.id);
  },
);

it.each(["accepted", "unknown"])(
  "waits through %s delivery, then repairs once on verified receive",
  async (delivery) => {
    const h = setup();
    const thread = h.open();
    const root = await h.signNext();
    if (delivery === "accepted") h.publications[0]?.resolve();
    else h.publications[0]?.reject(new Error("Disconnected after dispatch"));
    await vi.waitFor(() =>
      expect(thread.view.snapshot().root?.delivery).toBe(delivery),
    );
    await thread.view.refresh();
    expect(h.read).not.toHaveBeenCalled();
    expect(thread.event(h.id)).toBeUndefined();
    // Session reconciliation completes local delivery before notifying thread readers.
    h.writes.observe([root]);
    expect(thread.view.snapshot().root?.delivery).toBe("seen");
    expect(h.read).not.toHaveBeenCalled();
    thread.receive([root]);
    expect(h.read).toHaveBeenCalledOnce();
    thread.receive([root]);
    const reply = message(viewer, "a", "Already replied", root.created_at + 1, [
      ["e", h.id, "", "reply"],
    ]);
    h.reads[0]?.resolve([root, reply]);
    await vi.waitFor(() =>
      expect(thread.view.snapshot().replies.map((row) => row.id)).toEqual([
        reply.id,
      ]),
    );
    expect(thread.view.snapshot().canLoadMore).toBe(true);
    expect(thread.event(h.id)).toEqual(root);
    expect(h.read).toHaveBeenCalledOnce();
  },
);

it("retains failure and same-ID retry while signing is deferred", async () => {
  const h = setup();
  const thread = h.open();
  await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
  h.signatures[0]?.reject(new Error("Signing unavailable"));
  await vi.waitFor(() =>
    expect(thread.view.snapshot().root?.delivery).toBe("failed"),
  );
  expect(thread.view.snapshot().root?.deliveryError).toBe(
    "Signing unavailable",
  );
  await thread.view.refresh();
  expect(h.read).not.toHaveBeenCalled();
  h.writes.outbox.retry(h.id);
  expect(thread.view.snapshot().root).toMatchObject({
    id: h.id,
    delivery: "sending",
  });
  const root = await h.signNext(1);
  // The verified root can also arrive before local completion notification.
  thread.receive([root]);
  h.writes.observe([root]);
  h.reads[0]?.resolve([root]);
  await vi.waitFor(() => expect(thread.view.snapshot().status).toBe("ready"));
  expect(thread.view.snapshot().root?.delivery).toBe("seen");
  expect(h.read).toHaveBeenCalledOnce();
});

it("opens an already confirmed local completion after shared evidence eviction", async () => {
  const h = setup();
  const root = await h.signNext();
  h.writes.observe([root]);
  const thread = h.open();
  expect(thread.view.snapshot().root).toMatchObject({
    id: h.id,
    delivery: "seen",
  });
  expect(thread.event(h.id)).toEqual(root);
  const refresh = thread.view.refresh();
  expect(h.read).toHaveBeenCalledOnce();
  h.reads[0]?.resolve([root]);
  await refresh;
  // Ordinary not-found behavior resumes once there is verified evidence.
  const missing = thread.view.refresh();
  h.reads[1]?.resolve([]);
  await missing;
  expect(thread.view.snapshot()).toMatchObject({
    status: "error",
    root: undefined,
  });
});

it.each(["different ID", "different channel", "reply"])(
  "does not seed an unrelated local %s",
  async (scope) => {
    const other = "a".repeat(64);
    const h = setup(
      scope === "reply"
        ? [
            ["h", "a"],
            ["e", other, "", "reply"],
          ]
        : undefined,
    );
    const thread = h.open(
      scope === "different ID" ? other : h.id,
      scope === "different channel" ? "b" : "a",
    );
    expect(thread.view.snapshot().root).toBeUndefined();
    const refresh = thread.view.refresh();
    expect(h.read).toHaveBeenCalledOnce();
    h.reads[0]?.resolve([]);
    await refresh;
    expect(thread.view.snapshot().status).toBe("error");
  },
);

it.each([false, true])(
  "fences clear/access restoration and disposal (exact=%s)",
  async (exact) => {
    const h = setup();
    const thread = h.open(h.id, "a", exact);
    thread.purge(true);
    thread.changed();
    expect(thread.view.snapshot().root).toBeUndefined();
    await thread.view.refresh();
    expect(thread.view.snapshot().root?.id).toBe(h.id);
    h.access(false);
    thread.purge();
    thread.changed();
    await thread.view.refresh();
    expect(thread.view.snapshot().root).toBeUndefined();
    h.access(true);
    thread.changed();
    expect(thread.view.snapshot().root).toBeUndefined();
    await thread.view.refresh();
    expect(thread.view.snapshot().root?.id).toBe(h.id);
    const root = await h.signNext();
    h.writes.observe([root]);
    thread.receive([root]);
    thread.view.dispose();
    h.reads[0]?.resolve([
      root,
      message(viewer, "a", "Late", root.created_at + 1, [
        ["e", h.id, "", "reply"],
      ]),
    ]);
    thread.receive([root]);
    thread.changed();
    await thread.view.refresh();
    expect(thread.view.snapshot().root).toBeUndefined();
    expect(thread.view.snapshot().replies).toEqual([]);
    expect(h.read).toHaveBeenCalledOnce();
  },
);

it("restores an interrupted exact local root without attempting a read", async () => {
  const h = setup();
  const thread = h.open(h.id, "a", true);
  thread.purge();
  await thread.view.refresh();
  expect(thread.view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: h.id },
    target: { id: h.id },
    targetStatus: "ready",
  });
  expect(h.read).not.toHaveBeenCalled();
});

it("does not start confirmation repair after disposal during signing", async () => {
  const h = setup();
  const thread = h.open();
  thread.view.dispose();
  const root = await h.signNext();
  h.writes.observe([root]);
  thread.receive([root]);
  await thread.view.refresh();
  expect(thread.view.snapshot().root).toBeUndefined();
  expect(h.read).not.toHaveBeenCalled();
});

it("opens the synchronous send hash through the actual session and catches earlier replies on confirmation", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const signing = deferred<RelayEvent>();
  const sign = vi.fn((_event: EventTemplate) => signing.promise);
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign, publish },
      subscribe(callbacks) {
        traffic = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  cleanups.push(owner.dispose);
  const id = owner.session.messages.send("a", "Immediate request");
  const view = owner.session.thread("a", id);
  expect(view.snapshot().root).toMatchObject({ id, delivery: "sending" });
  await view.refresh();
  // Send may start the independent author directory read; no thread/root read.
  expect(
    wire.pending
      .flatMap(({ filters }) => filters)
      .every((filter) => !filter.ids && !filter["#e"] && !filter["#h"]),
  ).toBe(true);
  await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
  const template = sign.mock.calls[0]?.[0];
  if (!template) throw new Error("Missing signature request");
  const root = signed(viewer, template);
  // A verified finite/live read completes outbox intent before thread.receive.
  traffic.receive([root]);
  await vi.waitFor(() =>
    expect(
      wire.pending.some(({ filters }) =>
        filters.some((filter) => filter.depth_limit),
      ),
    ).toBe(true),
  );
  const request = wire.pending.find(({ filters }) =>
    filters.some((filter) => filter.depth_limit),
  );
  if (!request) throw new Error("Missing thread repair");
  const reply = message(viewer, "a", "Earlier reply", root.created_at + 1, [
    ["e", id, "", "reply"],
  ]);
  request.respond([root, reply]);
  await vi.waitFor(() =>
    expect(view.snapshot().replies.map((row) => row.id)).toEqual([reply.id]),
  );
  expect(view.snapshot().root?.delivery).toBe("seen");
  signing.resolve(root);
  expect(publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "repairs a dismissed failed optimistic root instead of stranding its view (exact=%s)",
  async (exact) => {
    const h = setup();
    const thread = h.open(h.id, "a", exact);
    await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
    h.signatures[0]?.reject(new Error("Signing unavailable"));
    await vi.waitFor(() =>
      expect(thread.view.snapshot().root?.delivery).toBe("failed"),
    );
    await h.writes.outbox.dismiss(h.id);
    expect(h.read).toHaveBeenCalledOnce();
    expect(thread.view.snapshot().status).toBe("loading");
    expect(thread.view.snapshot().root).toBeUndefined();
    h.reads[0]?.resolve([]);
    await vi.waitFor(() =>
      expect(thread.view.snapshot().status).toBe(exact ? "ready" : "error"),
    );
    if (exact) expect(thread.view.snapshot().targetStatus).toBe("unavailable");
    const retry = thread.view.refresh();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.reads[1]?.resolve([]);
    await retry;
  },
);

it("refresh releases a dismissed root gate even without local-change notifications", async () => {
  const h = setup();
  const thread = createThreadView({
    channelId: "a",
    messageId: h.id,
    relayAuthor: relay.pubkey,
    reader: { read: h.read },
    seed: undefined,
    local: h.writes.local,
    canAccess: () => true,
    visible: (events) => events,
    notify: (listener) => listener(),
  });
  cleanups.push(thread.view.dispose);
  await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
  h.signatures[0]?.reject(new Error("Signing unavailable"));
  await vi.waitFor(() =>
    expect(h.writes.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  await h.writes.outbox.dismiss(h.id);
  expect(h.read).not.toHaveBeenCalled();
  const retry = thread.view.refresh();
  expect(h.read).toHaveBeenCalledOnce();
  h.reads[0]?.resolve([]);
  await retry;
  expect(thread.view.snapshot().root).toBeUndefined();
});

it.each(["access", "dispose"])(
  "dismissal after %s retirement starts no read",
  async (retire) => {
    const h = setup();
    const thread = h.open();
    await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
    h.signatures[0]?.reject(new Error("Signing unavailable"));
    await vi.waitFor(() =>
      expect(thread.view.snapshot().root?.delivery).toBe("failed"),
    );
    if (retire === "dispose") thread.view.dispose();
    else {
      h.access(false);
      thread.purge();
    }
    await h.writes.outbox.dismiss(h.id);
    await thread.view.refresh();
    expect(thread.view.snapshot().root).toBeUndefined();
    expect(h.read).not.toHaveBeenCalled();
  },
);

it("keeps a failed root until outbox dismissal actually commits, including a failed disk write", async () => {
  let removal: ReturnType<typeof deferred<void>> | undefined;
  const h = setup(undefined, {
    load: () => [],
    save: (rows) => (!rows.length && removal ? removal.promise : undefined),
  });
  const thread = h.open();
  await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
  h.signatures[0]?.reject(new Error("Signing unavailable"));
  await vi.waitFor(() =>
    expect(thread.view.snapshot().root?.delivery).toBe("failed"),
  );
  removal = deferred<void>();
  const dismiss = h.writes.outbox.dismiss(h.id);
  const rejected = expect(dismiss).rejects.toThrow("Disk unavailable");
  expect(thread.view.snapshot().root?.id).toBe(h.id);
  expect(h.read).not.toHaveBeenCalled();
  removal.reject(new Error("Disk unavailable"));
  await rejected;
  expect(thread.view.snapshot().root?.id).toBe(h.id);
  await thread.view.refresh();
  expect(h.read).not.toHaveBeenCalled();
  removal = undefined;
  await h.writes.outbox.dismiss(h.id);
  expect(h.read).toHaveBeenCalledOnce();
  h.reads[0]?.resolve([]);
  await vi.waitFor(() => expect(thread.view.snapshot().status).toBe("error"));
});
