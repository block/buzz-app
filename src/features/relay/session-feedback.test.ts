import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { feedbackEvent } from "./product-feedback";
import { flush, keypair, signed } from "./testing";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import type { LiveCallbacks } from "./live";

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("keeps sidecar feedback private through acceptance, persistence, restore and an unsolicited echo", async () => {
  let saved: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(saved),
    save: (items: readonly OutgoingEvent[]) => {
      saved = structuredClone(items);
    },
  };
  const query = vi.fn(async () => [] as RelayEvent[]);
  const publish = vi.fn(async (_event: RelayEvent) => undefined);
  let live!: LiveCallbacks;
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
    writer: {
      kinds: [42000],
      sign: async (event: Parameters<typeof signed>[1]) =>
        signed(viewer, event),
      publish,
    },
    subscribe(callbacks: LiveCallbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  };
  const owner = createRelaySession(transport, { outboxStorage: storage });
  owners.push(owner);
  const outbox = owner.session.outbox;
  expect(outbox).toBeDefined();
  if (!outbox) throw new Error("Outbox unavailable");
  await outbox.ready();
  const id = outbox.send(feedbackEvent("Sensitive text", "bug"));
  await vi.waitFor(() =>
    expect(outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]?.[0]).toMatchObject({
    id,
    kind: 42000,
    content: "Sensitive text",
  });
  expect(query).not.toHaveBeenCalled();
  const view = owner.session.observe([{ kinds: [42000], limit: 20 }]);
  expect(view.snapshot().events).toEqual([]);
  const event = signed(viewer, {
    kind: 42000,
    content: "Sensitive text",
    tags: [["category", "bug"]],
  });
  live.receive([event]);
  expect(view.snapshot().events).toEqual([]);
  view.dispose();
  await flush();
  owner.dispose();
  const restored = createRelaySession(transport, { outboxStorage: storage });
  owners.push(restored);
  await restored.session.outbox?.ready();
  expect(restored.session.outbox?.snapshot()[0]).toMatchObject({
    delivery: "unknown",
    event: { id },
  });
  expect(
    restored.session.observe([{ kinds: [42000], limit: 20 }]).snapshot().events,
  ).toEqual([]);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("rejects sidecar feedback returned by a faulty read transport from finite and retained views", async () => {
  const privateEvent = signed(viewer, {
    kind: 42000,
    content: "Secret returned by faulty transport",
    tags: [],
  });
  const query = vi.fn(async () => [privateEvent]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
  });
  owners.push(owner);
  const broad = [{ kinds: [42000], limit: 20 }];
  const view = owner.session.observe(broad);
  await view.refresh();
  expect(view.snapshot()).toMatchObject({ status: "ready", events: [] });
  expect(await owner.session.read(broad)).toEqual([]);
  expect(
    await owner.session.read([{ ids: [privateEvent.id], limit: 1 }]),
  ).toEqual([]);
  expect(query).toHaveBeenCalled();
  view.dispose();
});

it.each(["rejected", "unknown"])(
  "retains %s feedback for an explicit retry of the original signed event",
  async (failure) => {
    const publish = vi.fn(async (_event: RelayEvent) => {
      if (publish.mock.calls.length === 1) {
        if (failure === "unknown")
          throw new Error("connection lost after dispatch");
        throw new PublishRejected("rejected by relay");
      }
    });
    const sign = vi.fn(async (event: Parameters<typeof signed>[1]) =>
      signed(viewer, event),
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query: vi.fn(async () => [] as RelayEvent[]),
        writer: { kinds: [42000], sign, publish },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
    owners.push(owner);
    const outbox = owner.session.outbox;
    if (!outbox) throw new Error("Outbox unavailable");
    await outbox.ready();
    const id = outbox.send(feedbackEvent("Retain my intent", null));
    await vi.waitFor(() =>
      expect(outbox.snapshot()[0]?.delivery).toBe(
        failure === "unknown" ? "unknown" : "failed",
      ),
    );
    expect(outbox.snapshot()[0]?.event.id).toBe(id);
    expect(
      owner.session.observe([{ kinds: [42000], limit: 20 }]).snapshot().events,
    ).toEqual([]);
    outbox.retry(id);
    await vi.waitFor(() =>
      expect(outbox.snapshot()[0]?.delivery).toBe("accepted"),
    );
    expect(sign).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toEqual(publish.mock.calls[0]?.[0]);
  },
);

it("does not expose ordinary community media as private feedback uploads", () => {
  const uploadAttachment = vi.fn();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://relay.test",
    media: () => undefined,
    query: vi.fn(async () => [] as RelayEvent[]),
    uploadAttachment,
    writer: {
      kinds: [42000],
      sign: async (template: Parameters<typeof signed>[1]) =>
        signed(viewer, template),
      publish: async () => {},
    },
  });
  owners.push(owner);
  expect(owner.session.feedbackUpload).toBeUndefined();
  expect(uploadAttachment).not.toHaveBeenCalled();
});
