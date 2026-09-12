import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import { keypair, roster, signed, scriptedTransport } from "../relay/testing";
const channelId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const relay = keypair(),
  viewer = keypair();
const definition = signed(viewer, {
  kind: 30620,
  created_at: 10,
  content: "PRIVATE yaml",
  tags: [
    ["h", channelId],
    ["d", id],
  ],
});
const reference = { id, channelId, owner: viewer.pubkey };
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  let resolveRuns!: (value: unknown) => void;
  const runs = vi.fn(
    (_id: string, _cursor: unknown, _signal: AbortSignal) =>
      new Promise<unknown>((resolve) => {
        resolveRuns = resolve;
      }),
  );
  const owner = createRelaySession({
    ...wire.transport,
    workflows: { runs, approvals: async () => ({ approvals: [] }) },
    subscribe(callbacks) {
      incoming = callbacks.receive;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return {
    ...wire,
    ...owner,
    runs,
    emit: (events: readonly RelayEvent[]) => incoming(events),
    resolveRuns: (value: unknown) => resolveRuns(value),
  };
}
it("workflow views start lazy and purge to unavailable before any channel/operation/view observer runs", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const definitions = h.session.workflows.definitions(channelId),
    history = h.session.workflows.runs(reference);
  expect(h.pending).toHaveLength(0);
  expect(h.runs).not.toHaveBeenCalled();
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const request = h.next();
  expect(request.filters).toEqual([
    { kinds: [30620], "#h": [channelId], limit: 100 },
  ]);
  // A second refresh shares its pending read.
  expect(definitions.refresh()).toBe(loading);
  request.respond([definition]);
  await loading;
  expect(definitions.snapshot().status).toBe("ready");
  expect(history.snapshot().status).toBe("idle");
});
it("authoritative revocation clears all saved and structured data before callbacks, rejects late results and denies fresh views", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const definitions = h.session.workflows.definitions(channelId),
    history = h.session.workflows.runs(reference);
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await loading;
  expect(definitions.snapshot().data.items[0]?.revision).toBe(definition.id);
  const runRead = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  const checked = vi.fn(() => {
    expect(definitions.snapshot()).toMatchObject({
      status: "unavailable",
      data: { items: [] },
    });
    expect(history.snapshot()).toMatchObject({
      status: "unavailable",
      data: { runs: [] },
    });
    expect(h.session.workflows.operations.snapshot()).toEqual([]);
  });
  definitions.subscribe(checked);
  history.subscribe(checked);
  h.session.workflows.operations.subscribe(checked);
  h.session.channels.subscribeList(checked);
  h.emit([roster(relay, channelId, [], 2)]);
  expect(checked).toHaveBeenCalled();
  expect(h.runs.mock.calls[0]?.[2].aborted).toBe(true);
  const denied = h.session.workflows.definitions(channelId);
  expect(denied.snapshot().status).toBe("unavailable");
  await denied.refresh();
  expect(h.pending).toHaveLength(0);
  h.resolveRuns({ runs: [], next: null });
  await runRead;
  expect(history.snapshot().status).toBe("unavailable");
});
it("regrant cannot resurrect stale history; clear-cache and dispose cancel interest", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const history = h.session.workflows.runs(reference);
  const first = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.emit([roster(relay, channelId, [], 2)]);
  h.emit([roster(relay, channelId, [viewer.pubkey], 3)]);
  h.resolveRuns({ runs: [], next: null });
  await first;
  expect(history.snapshot().status).toBe("unavailable");
  const fresh = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(2));
  h.resolveRuns({ runs: [], next: null });
  await fresh;
  expect(history.snapshot().status).toBe("ready");
  const next = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(3));
  await h.clearCache();
  expect(h.runs.mock.calls[2]?.[2].aborted).toBe(true);
  expect(history.snapshot()).toMatchObject({
    status: "idle",
    data: { runs: [] },
  });
  h.resolveRuns({ runs: [], next: null });
  await next;
  expect(history.snapshot().status).toBe("idle");
  h.dispose();
  expect(history.snapshot().status).toBe("unavailable");
});
it("a loading observer can revoke without leaving a wedged pending read", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const history = h.session.workflows.runs(reference);
  const stop = history.subscribe(() => {
    if (history.snapshot().status === "loading")
      h.emit([roster(relay, channelId, [], 2)]);
  });
  await history.refresh();
  expect(h.runs).not.toHaveBeenCalled();
  expect(history.snapshot().status).toBe("unavailable");
  stop();
  h.emit([roster(relay, channelId, [viewer.pubkey], 3)]);
  const fresh = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.resolveRuns({ runs: [], next: null });
  await fresh;
  expect(history.snapshot().status).toBe("ready");
});
it("old host keeps every workflow command unavailable, even through direct session outbox", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey),
    sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(viewer, template),
    );
  const owner = createRelaySession(
    { ...wire.transport, writer: { sign, publish: async () => "" } },
    {
      outboxStorage: { load: async () => [], save: async () => {} },
    },
  );
  owners.push(owner);
  expect(owner.session.workflows.availability).toMatchObject({
    save: false,
    delete: false,
    trigger: false,
  });
  const workflow = {
    ...reference,
    yaml: definition.content,
    revision: definition.id,
    createdAt: 10,
  };
  expect(() => owner.session.workflows.trigger(workflow)).toThrow(
    "unavailable",
  );
  owner.session.outbox?.send({
    kind: 46020,
    tags: [
      ["h", channelId],
      ["d", id],
    ],
    content: "",
  });
  await vi.waitFor(() =>
    expect(owner.session.outbox?.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(sign).not.toHaveBeenCalled();
});
