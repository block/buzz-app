import { afterEach, expect, it, vi } from "vitest";
import { createSidebarState } from "./sidebar-state";
import {
  sidebarFixture,
  sidebarRow,
  sidebarAccount,
  deferredSidebar,
} from "./sidebar-testing";
import type { SidebarPage } from "./sidebar-api";
const channel = "01234567-89ab-cdef-0123-456789abcdef";
const other = "11234567-89ab-cdef-0123-456789abcdef";
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const f of dispose.splice(0)) f();
  vi.useRealTimers();
});
function harness() {
  const bff = sidebarFixture();
  bff.rows.set(channel, sidebarRow(channel));
  bff.rows.set(other, sidebarRow(other));
  let access = true;
  const owner = createSidebarState({
    api: bff.api,
    storage: bff.storage,
    allowed: () => access,
  });
  dispose.push(owner.dispose);
  return {
    bff,
    owner,
    deny() {
      access = false;
      owner.purge();
    },
  };
}
it("coalesces repeated live hints into one target refresh, without rereading the roster", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  h.bff.api.sidebar.mockClear();
  for (let i = 0; i < 100; i++) h.owner.invalidate(channel);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.bff.api.sidebar.mock.calls.map(([q]) => q)).toEqual([
    { channel_ids: [channel] },
  ]);
});
it("late targeted responses cannot restore revoked projections", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  const held = deferredSidebar<SidebarPage>();
  h.bff.api.sidebar.mockImplementationOnce(() => held.promise);
  h.owner.invalidate(channel);
  await vi.advanceTimersByTimeAsync(250);
  const seen: unknown[] = [];
  h.owner.subscribe(() => seen.push(h.owner.row(channel)));
  h.deny();
  held.resolve({
    account: sidebarAccount,
    channels: [sidebarRow(channel)],
    next_cursor: null,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.every((row) => row === undefined)).toBe(true);
});
it("targeted absence removes a row but does not revoke unrelated channel context access", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.owner.ensure();
  h.bff.rows.delete(channel);
  h.owner.invalidate(channel);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.owner.row(channel)).toBeUndefined();
  expect(h.owner.row(other)).toBeDefined();
  const lease = h.owner.retain({
    target: { channel_id: channel },
    message_ids: [],
  });
  await lease.ready;
  expect(h.owner.context({ channel_id: channel })?.status).toBe("available");
  lease.dispose();
});
