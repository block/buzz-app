import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../communities/service";
import { createRelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import { sidebarFixture, sidebarRow } from "../relay/sidebar-testing";
import { keypair, message, metadata, roster } from "../relay/testing";
import { bindUnreadIndicator } from "./indicator-unread";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});
function setup(supported = true) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  let incoming = (_events: readonly RelayEvent[]) => {};
  const bff = sidebarFixture();
  const query = vi.fn(async () => [] as RelayEvent[]);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      ...(supported ? { sidebarApi: bff.api } : {}),
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { sidebarStorage: bff.storage },
  );
  cleanups.push(owner.dispose);
  const client = {
    viewer: viewer.pubkey as string | undefined,
    selected: "https://one.example" as string | null,
    memberships: [{ id: "https://one.example" }],
  };
  const relayState = {
    status: "ready",
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const communities = {
    snapshot: () => client,
    subscribe,
    relay: { snapshot: () => relayState, subscribe },
  } as unknown as Communities;
  const project = vi.fn();
  const bind = () => {
    const stop = bindUnreadIndicator(communities, project);
    cleanups.push(stop);
    return stop;
  };
  return {
    ...owner,
    bff,
    async count(id: string, value: number) {
      bff.rows.set(id, sidebarRow(id, { unread: { status: "exact", value } }));
      await owner.session.unread.refresh();
    },
    viewer,
    peer,
    relay,
    client,
    relayState,
    project,
    query,
    bind,
    notify() {
      for (const fn of listeners) fn();
    },
    emit(events: readonly RelayEvent[]) {
      incoming(events);
    },
    grant(id = "01234567-89ab-cdef-0123-456789abcdef", time = 10) {
      incoming([
        roster(relay, id, [viewer.pubkey], time),
        metadata(relay, id, id, time),
      ]);
    },
  };
}
const target = {
  kind: "channel",
  channelId: "01234567-89ab-cdef-0123-456789abcdef",
} as const;
it("projects only relay responses and local intent, never ingested traffic or optimistic writes", async () => {
  const h = setup();
  h.grant();
  h.bind();
  expect(h.project.mock.calls).toEqual([[false]]);
  expect(h.session.unread.snapshot(target).unread).toEqual({
    status: "unknown",
  });
  const row = message(h.peer, target.channelId, "arrival", 11);
  h.emit([row]);
  expect(h.project.mock.calls).toEqual([[false]]);
  await h.count(target.channelId, 1);
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.session.unread.markThrough(target, row.id);
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.count(target.channelId, 0);
  expect(h.project).toHaveBeenLastCalledWith(false);
  await h.session.unread.markUnreadLocal(target);
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.session.unread.markThrough(target, row.id);
  expect(h.project).toHaveBeenLastCalledWith(false);
  expect(h.query).not.toHaveBeenCalled();
});
it("restores existing channel totals including thread-only activity without extra reads", async () => {
  const h = setup();
  h.grant();
  await h.count(target.channelId, 2);
  h.bind();
  expect(h.project).toHaveBeenLastCalledWith(true);
  expect(h.query).not.toHaveBeenCalled();
});
it("uses all accessible channels and clears on relay correction or access loss", async () => {
  const h = setup();
  h.bind();
  h.grant();
  const second = "11234567-89ab-cdef-0123-456789abcdef";
  h.grant(second);
  await h.count(second, 1);
  expect(h.project).toHaveBeenLastCalledWith(true);
  await h.count(second, 0);
  expect(h.project).toHaveBeenLastCalledWith(false);
  await h.count(target.channelId, 1);
  expect(h.project).toHaveBeenLastCalledWith(true);
  h.emit([roster(h.relay, target.channelId, [], 14)]);
  expect(h.project).toHaveBeenLastCalledWith(false);
});
it.each(["personal", "viewer", "disconnected", "membership"])(
  "clears and detaches old evidence on %s transition",
  async (transition) => {
    const h = setup();
    h.grant();
    h.bind();
    await h.count(target.channelId, 1);
    expect(h.project).toHaveBeenLastCalledWith(true);
    if (transition === "personal") h.client.selected = null;
    if (transition === "viewer") h.client.viewer = keypair().pubkey;
    if (transition === "disconnected") h.relayState.status = "disconnected";
    if (transition === "membership") h.client.memberships = [];
    h.notify();
    expect(h.project).toHaveBeenLastCalledWith(false);
    const calls = h.project.mock.calls.length;
    h.emit([
      message(
        h.peer,
        "01234567-89ab-cdef-0123-456789abcdef",
        "retired session",
        12,
      ),
    ]);
    await h.count(target.channelId, 2);
    expect(h.project).toHaveBeenCalledTimes(calls);
  },
);
it("retargets an already-open community and ignores the prior session after switching and teardown", async () => {
  const h = setup(),
    other = setup();
  h.grant();
  other.grant();
  const stop = h.bind();
  await h.count(target.channelId, 1);
  h.client.selected = "https://two.example";
  h.client.memberships.push({ id: h.client.selected });
  h.client.viewer = other.viewer.pubkey;
  h.relayState.viewer = other.viewer.pubkey;
  h.relayState.session = other.session;
  h.notify();
  expect(h.project).toHaveBeenLastCalledWith(false);
  h.emit([
    message(
      h.peer,
      "01234567-89ab-cdef-0123-456789abcdef",
      "background community",
      12,
    ),
  ]);
  await h.count(target.channelId, 2);
  expect(h.project).toHaveBeenLastCalledWith(false);
  await other.count(target.channelId, 1);
  expect(h.project).toHaveBeenLastCalledWith(true);
  stop();
  expect(h.project).toHaveBeenLastCalledWith(false);
  const calls = h.project.mock.calls.length;
  other.emit([
    message(
      other.peer,
      "01234567-89ab-cdef-0123-456789abcdef",
      "after stop",
      14,
    ),
  ]);
  await other.count(target.channelId, 2);
  h.notify();
  stop();
  expect(h.project).toHaveBeenCalledTimes(calls);
});
it.each([
  ["relay count", true],
  ["local unread mark", false],
] as const)(
  "a channel leaving the roster does not detach the indicator from remaining channels: %s",
  async (_label, supported) => {
    const h = setup(supported);
    const second = "11234567-89ab-cdef-0123-456789abcdef";
    h.grant();
    h.grant(second);
    h.bind();
    expect(h.project).toHaveBeenLastCalledWith(false);
    h.emit([roster(h.relay, target.channelId, [], 14)]);
    expect(h.project).toHaveBeenLastCalledWith(false);
    if (supported) await h.count(second, 1);
    else
      await h.session.unread.markUnreadLocal({
        kind: "channel",
        channelId: second,
      });
    expect(h.project).toHaveBeenLastCalledWith(true);
  },
);
