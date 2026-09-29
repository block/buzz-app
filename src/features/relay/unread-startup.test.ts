import { afterEach, expect, it, vi } from "vitest";
import { createSidebarState } from "./sidebar-state";
import {
  sidebarFixture,
  sidebarRow,
  sidebarAccount,
  deferredSidebar,
} from "./sidebar-testing";
import type { SidebarPage } from "./sidebar-api";
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`;
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const f of dispose.splice(0)) f();
  vi.useRealTimers();
});
function harness() {
  const bff = sidebarFixture();
  let allowed = true;
  const owner = createSidebarState({
    api: bff.api,
    storage: bff.storage,
    allowed: () => allowed,
  });
  dispose.push(owner.dispose);
  return {
    bff,
    owner,
    revoke() {
      allowed = false;
      owner.purge();
    },
  };
}
it("traverses 278 channels progressively with shared concurrent ensure and no Nostr history reads", async () => {
  const h = harness(),
    gate = deferredSidebar<SidebarPage>();
  const rows = Array.from({ length: 278 }, (_, i) =>
    sidebarRow(id(i), { unread: { status: "at_least", value: 1 } }),
  );
  h.bff.api.sidebar.mockImplementation(async (query) => {
    const start = "cursor" in query ? Number(query.cursor) : 0;
    if (start === 20) return gate.promise;
    return {
      account: sidebarAccount,
      channels: rows.slice(start, start + 20),
      next_cursor: start + 20 < rows.length ? String(start + 20) : null,
    };
  });
  const a = h.owner.ensure(),
    b = h.owner.ensure();
  try {
    await vi.waitFor(() => expect(h.bff.api.sidebar).toHaveBeenCalledTimes(2));
    expect(h.owner.row(id(0))?.unread).toEqual({
      status: "at_least",
      value: 1,
    });
    expect(h.owner.row(id(20))).toBeUndefined();
  } finally {
    gate.resolve({
      account: sidebarAccount,
      channels: rows.slice(20, 40),
      next_cursor: "40",
    });
  }
  await Promise.all([a, b]);
  expect(h.bff.api.sidebar).toHaveBeenCalledTimes(14);
  expect(h.owner.row(id(277))?.unread).toEqual({
    status: "at_least",
    value: 1,
  });
});
it.each(["clear", "dispose", "revoke"])(
  "a held page cannot publish or dispatch a next page after %s",
  async (action) => {
    const h = harness(),
      gate = deferredSidebar<SidebarPage>();
    h.bff.api.sidebar.mockImplementationOnce(() => gate.promise);
    const loading = h.owner.ensure();
    await vi.waitFor(() => expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1));
    if (action === "clear") h.owner.clear();
    if (action === "dispose") h.owner.dispose();
    if (action === "revoke") h.revoke();
    gate.resolve({
      account: sidebarAccount,
      channels: [sidebarRow(id(1))],
      next_cursor: id(1),
    });
    await loading;
    expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1);
    expect(h.owner.row(id(1))).toBeUndefined();
  },
);
it("a subscriber clear during progressive publication stops subsequent pages", async () => {
  const h = harness();
  h.bff.api.sidebar.mockResolvedValueOnce({
    account: sidebarAccount,
    channels: [sidebarRow(id(1))],
    next_cursor: id(1),
  });
  h.owner.subscribe(() => {
    if (h.owner.row(id(1))) h.owner.clear();
  });
  await h.owner.ensure();
  expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1);
  expect(h.owner.row(id(1))).toBeUndefined();
});
it("transient failure requires refresh and preserves earlier rows without exact-zero fabrication", async () => {
  const h = harness();
  h.bff.api.sidebar
    .mockResolvedValueOnce({
      account: sidebarAccount,
      channels: [sidebarRow(id(1))],
      next_cursor: id(1),
    })
    .mockRejectedValueOnce(new Error("offline"));
  await h.owner.ensure();
  expect(h.owner.sync().status).toBe("error");
  await h.owner.ensure();
  expect(h.bff.api.sidebar).toHaveBeenCalledTimes(2);
  expect(h.owner.row(id(1))).toBeDefined();
  h.bff.rows.set(id(1), sidebarRow(id(1)));
  await h.owner.refresh();
  expect(h.owner.sync().status).toBe("ready");
});
it("stops a malicious repeated cursor rather than querying indefinitely", async () => {
  const h = harness();
  h.bff.api.sidebar.mockResolvedValue({
    account: sidebarAccount,
    channels: [],
    next_cursor: "same",
  });
  await h.owner.ensure();
  expect(h.owner.sync().status).toBe("error");
  expect(h.bff.api.sidebar.mock.calls.length).toBeLessThanOrEqual(2);
});

it("ordinary refreshes join a held traversal without another pass", async () => {
  const h = harness(),
    gate = deferredSidebar<SidebarPage>();
  h.bff.api.sidebar.mockImplementationOnce(() => gate.promise);
  const initial = h.owner.ensure();
  await vi.waitFor(() => expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1));
  const refreshes = [h.owner.refresh(), h.owner.refresh()];
  gate.resolve({
    account: sidebarAccount,
    channels: [sidebarRow(id(1))],
    next_cursor: null,
  });
  await Promise.all([initial, ...refreshes]);
  expect(h.bff.api.sidebar).toHaveBeenCalledTimes(1);
});
