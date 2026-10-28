import { forgetTabWorkspaces } from "../../features/messages/tab-workspace-lifetime";
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import * as headPersistence from "../../features/relay/persistence";
import { ReadError } from "../../features/relay/errors";
import { keypair, metadata, roster } from "../../features/relay/testing";
import { provideRelay } from "../../features/relay/service";
import type { ReadTransport } from "../../features/relay/transport";
import type { RelaySession } from "../../features/relay/session";
import type { RegisteredPanel } from "../../features/panels/service";
import {
  channelTabs,
  panelTabId,
  useChannelTabState,
} from "./useChannelTabState";
import {
  readTabWorkspaces,
  tabWorkspaceStorageKey,
} from "./tab-workspace-storage";

const session = (origin = "https://community.example", viewer = "viewer") =>
  ({ scope: `${origin}:${viewer}`, viewer }) as RelaySession;
const mount = (queries = session(), channel = "alpha", page = "messages") =>
  renderHook(() => useChannelTabState(queries, channel, page));
const profile = { key: "buzz.profiles/profile" } as RegisteredPanel;
const github = { key: "buzz.github/object" } as RegisteredPanel;
const opening = (panel = profile) => ({
  panel,
  target: `${panel.key}:target`,
  channelId: "alpha",
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

test("reload restores tabs, pane order, names, selection and visit associations without replaying requests", () => {
  const first = mount();
  act(() => {
    first.result.current.enterVisit("one:channel");
    first.result.current.setEntries([opening()]);
    first.result.current.openThreadTab(
      "alpha",
      "reply",
      "root",
      "reply",
      "main",
    );
    first.result.current.renameTab("thread:alpha:root", "Named thread");
    first.result.current.leaveVisit();
    first.result.current.enterVisit("two:thread", {
      channelId: "alpha",
      messageId: "reply",
      rootId: "root",
    });
    first.result.current.openThreadTab(
      "alpha",
      "other",
      "other",
      "focus",
      "side",
    );
    first.result.current.setPaneOpen(false);
  });
  const prior = first.result.current;
  first.unmount();
  const restored = mount();
  act(() => restored.result.current.restoreEntries(() => profile));
  expect(restored.result.current).toMatchObject({
    selected: prior.selected,
    mainSelected: prior.mainSelected,
    paneOpen: false,
    visit: "two:thread",
    visits: prior.visits,
    entries: [opening()],
    tabs: [
      {
        id: "thread:alpha:root",
        kind: "thread",
        pane: "main",
        name: "Named thread",
      },
      { id: "thread:alpha:other", kind: "thread", pane: "side" },
    ],
  });
  for (const tab of restored.result.current.tabs) {
    expect(tab.focusRequest).toBeUndefined();
    if (tab.kind === "thread") expect(tab.replyRequest).toBeUndefined();
  }
  act(() => restored.result.current.enterVisit("one:channel"));
  expect(restored.result.current.mainSelected).toBe("thread:alpha:root");
});

test("reload isolates community, viewer, page and channel workspaces", () => {
  const firstSession = session();
  const first = renderHook(() => useChannelTabState(firstSession, "alpha"));
  act(() => first.result.current.openThreadTab("alpha", "root", "root"));
  first.unmount();
  for (const [queries, channel, page] of [
    [session("https://other.example"), "alpha", "messages"],
    [session(undefined, "other-viewer"), "alpha", "messages"],
    [session(), "beta", "messages"],
    [session(), "alpha", "page:inbox"],
  ] as const) {
    const next = renderHook(() => useChannelTabState(queries, channel, page));
    expect(next.result.current.tabs).toEqual([]);
    next.unmount();
  }
  expect(mount().result.current.tabs).toHaveLength(1);
});

test("delayed panel registrations keep their order, placement and selection across another reload", () => {
  const first = mount();
  act(() => {
    first.result.current.setEntries([
      opening({ key: "buzz.terminal/terminal" } as RegisteredPanel),
      opening(),
      opening(github),
    ]);
    first.result.current.moveEntry(panelTabId(opening()), "main");
    first.result.current.select(panelTabId(opening(github)));
  });
  first.unmount();
  const pending = mount();
  act(() => {
    pending.result.current.restoreEntries(() => undefined);
    pending.result.current.setEntries([]);
    pending.result.current.setPaneOpen(false);
  });
  expect(pending.result.current.entries).toEqual([]);
  pending.unmount();
  const restored = mount();
  act(() =>
    restored.result.current.restoreEntries((key) =>
      key === github.key ? github : undefined,
    ),
  );
  act(() =>
    restored.result.current.restoreEntries((key) =>
      key === profile.key ? profile : undefined,
    ),
  );
  expect(restored.result.current.entries).toMatchObject([
    opening(),
    opening(github),
  ]);
  expect(restored.result.current.mainEntries).toEqual([panelTabId(opening())]);
  expect(restored.result.current.selected).toBe(panelTabId(opening(github)));
  expect(restored.result.current.paneOpen).toBe(false);
});

test("close all retires pending panel targets including channel tools", () => {
  const first = mount();
  act(() =>
    first.result.current.setEntries([
      opening(),
      opening({ key: "buzz.terminal/terminal" } as RegisteredPanel),
      {
        ...opening(github),
        channelContext: {
          scope: "scope",
          viewer: "viewer",
          channelId: "alpha",
          channelName: "Alpha",
          relayUrl: "wss://community.example",
        },
      },
    ]),
  );
  first.unmount();
  const restored = mount();
  expect(restored.result.current.pendingEntries).toHaveLength(3);
  act(() => restored.result.current.closeTabs());
  act(() => restored.result.current.restoreEntries(() => profile));
  expect(restored.result.current.entries).toEqual([]);
  restored.unmount();
  expect(mount().result.current.pendingEntries).toEqual([]);
});

test("unavailable storage leaves live workspace actions usable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const live = mount();
  act(() => live.result.current.openThreadTab("alpha", "root", "root"));
  expect(live.result.current.tabs).toHaveLength(1);
});

test("a failed save removes the stale snapshot without disrupting live tabs", () => {
  const queries = session();
  const live = mount(queries);
  act(() => live.result.current.openThreadTab("alpha", "root", "root"));
  expect(readTabWorkspaces(queries)['["messages","alpha"]']?.tabs).toHaveLength(
    1,
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  act(() => live.result.current.closeTabs());
  expect(live.result.current.tabs).toEqual([]);
  expect(readTabWorkspaces(queries)).toEqual({});
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => act(() => live.result.current.setPaneOpen(false))).not.toThrow();
});

test("reload into another channel retires saved menu tabs and preserves launcher tabs", async () => {
  const queries = session();
  const menu = { key: "fixture/canvas", channelMenu: {} } as RegisteredPanel;
  const launcher = {
    key: "fixture/app",
    channelLauncher: {},
  } as RegisteredPanel;
  const first = mount(queries);
  act(() =>
    first.result.current.setEntries([opening(menu), opening(launcher)]),
  );
  first.unmount();
  // A document reload recreates the session-store module, not just the hook.
  vi.resetModules();
  const { useChannelTabState: reloadedState } = await import(
    "./useChannelTabState"
  );
  const restored = renderHook(() => reloadedState(session(), "beta"));
  restored.unmount();
  const alpha = renderHook(() => reloadedState(session(), "alpha"));
  expect(
    alpha.result.current.pendingEntries?.map((entry) => entry.key),
  ).toEqual([launcher.key]);
});

test("corrupt and unsupported snapshots are ignored", () => {
  const queries = session();
  for (const raw of [
    "{",
    "null",
    '{"version":2,"workspaces":{}}',
    '{"version":1,"workspaces":{"invalid":{"tabs":[],"entries":[],"selected":12,"paneOpen":true}}}',
  ]) {
    sessionStorage.setItem(tabWorkspaceStorageKey(queries.scope), raw);
    expect(readTabWorkspaces(queries)).toEqual({});
  }
});

test("only validated fields survive loading and saving a workspace", () => {
  const queries = session();
  const key = '["messages","alpha"]';
  const extra = { opaque: "not-owned" };
  sessionStorage.setItem(
    tabWorkspaceStorageKey(queries.scope),
    JSON.stringify({
      version: 1,
      workspaces: {
        [key]: {
          ...extra,
          selected: "thread",
          paneOpen: true,
          tabs: [],
          entries: [
            {
              ...extra,
              key: "missing/panel",
              target: "app",
              channelId: "alpha",
              index: 0,
              keepOpen: false,
            },
            {
              key: "missing/invalid",
              target: "app",
              channelId: "alpha",
              index: 1,
              keepOpen: "yes",
            },
          ],
          visits: { visit: { ...extra, selected: "thread", paneOpen: true } },
          routedVisits: {
            visit: {
              ...extra,
              channelId: "alpha",
              messageId: "reply",
              rootId: "root",
            },
          },
          detailVisits: {
            visit: { ...extra, channelId: "alpha", target: "app" },
          },
        },
      },
    }),
  );
  expect(JSON.stringify(readTabWorkspaces(queries))).not.toContain("not-owned");
  expect(readTabWorkspaces(queries)[key]?.pendingEntries).toMatchObject([
    { key: "missing/panel", keepOpen: false },
  ]);
  expect(readTabWorkspaces(queries)[key]?.pendingEntries).toHaveLength(1);
  const live = mount(queries);
  act(() => live.result.current.setPaneOpen(false));
  expect(
    sessionStorage.getItem(tabWorkspaceStorageKey(queries.scope)),
  ).not.toContain("not-owned");
});

test("domain-owned dismissal associations survive without hydrating runtime state", () => {
  const queries = session();
  const metadata = {
    routedVisits: {
      old: { channelId: "alpha", messageId: "reply", rootId: "root" },
    },
    detailVisits: { profile: { channelId: "alpha", target: "profile" } },
  };
  sessionStorage.setItem(
    tabWorkspaceStorageKey(queries.scope),
    JSON.stringify({
      version: 1,
      workspaces: {
        '["messages","alpha"]': {
          tabs: [],
          entries: [],
          selected: "thread",
          paneOpen: true,
          ...metadata,
        },
      },
    }),
  );
  const restored = mount(queries);
  expect(readTabWorkspaces(queries)['["messages","alpha"]']).toMatchObject(
    metadata,
  );
  act(() => restored.result.current.setPaneOpen(false));
  expect(readTabWorkspaces(session())['["messages","alpha"]']).toMatchObject(
    metadata,
  );
});

test("a replaced session's late callbacks cannot overwrite the current saved workspace", () => {
  const first = mount();
  act(() => first.result.current.openThreadTab("alpha", "first", "first"));
  const lateSelect = first.result.current.select;
  first.unmount();
  const current = mount();
  act(() => current.result.current.openThreadTab("alpha", "second", "second"));
  act(() => lateSelect("thread:alpha:first"));
  current.unmount();
  expect(mount().result.current.tabs.map((tab) => tab.id)).toEqual([
    "thread:alpha:first",
    "thread:alpha:second",
  ]);
});

test("reload restores channel settings with a fresh opening identity and its pane selection", () => {
  const first = mount();
  act(() => first.result.current.setSettings({ channelId: "alpha" }));
  const previousId = first.result.current.settings?.id;
  act(() => first.result.current.setPaneOpen(false));
  first.unmount();
  const restored = mount();
  expect(restored.result.current).toMatchObject({
    settings: { channelId: "alpha" },
    selected: "settings",
    paneOpen: false,
  });
  expect(restored.result.current.settings?.id).not.toBe(previousId);
  const saved = JSON.parse(
    sessionStorage.getItem(tabWorkspaceStorageKey(session().scope)) ?? "null",
  );
  expect(saved.workspaces['["messages","alpha"]'].settings).toEqual({
    channelId: "alpha",
  });
  act(() => restored.result.current.setSettings(undefined));
  restored.unmount();
  expect(mount().result.current.settings).toBeUndefined();
});

test("restored channel settings cannot belong to a different channel", () => {
  const first = mount();
  act(() => first.result.current.setSettings({ channelId: "beta" }));
  first.unmount();
  expect(mount().result.current.settings).toBeUndefined();
});

test.each([
  [0, 1, 2],
  [2, 0, 1],
  [1, 2, 0],
  [2, 1, 0],
])(
  "arbitrary plugins keep their order through delayed registration and intervening reloads: %j",
  (...order) => {
    const panels = [0, 1, 2].map(
      (index) =>
        ({
          key: `example/${index}`,
          title: `Panel ${index}`,
        }) as RegisteredPanel,
    );
    const first = mount();
    act(() =>
      first.result.current.setEntries(panels.map((panel) => opening(panel))),
    );
    first.unmount();
    const registered = new Set<number>();
    for (const index of order) {
      registered.add(index);
      const restored = mount();
      act(() =>
        restored.result.current.restoreEntries((key) =>
          panels.find(
            (panel, index) => panel.key === key && registered.has(index),
          ),
        ),
      );
      expect(
        restored.result.current.entries.map((entry) => entry.panel.key),
      ).toEqual(
        panels
          .filter((_, index) => registered.has(index))
          .map((panel) => panel.key),
      );
      act(() => restored.result.current.setPaneOpen(false));
      restored.unmount();
    }
  },
);

test("channel-bound recovery stores no captured context and requires freshly supplied context", () => {
  const old = {
    scope: "old",
    viewer: "old",
    channelId: "alpha",
    channelName: "Old",
    relayUrl: "wss://old",
  };
  const panel = {
    key: "example/channel",
    title: "Channel tool",
  } as RegisteredPanel;
  const first = mount();
  act(() =>
    first.result.current.setEntries([
      { ...opening(panel), channelContext: old },
    ]),
  );
  first.unmount();
  const restored = mount();
  act(() => restored.result.current.restoreEntries(() => panel));
  expect(restored.result.current.entries).toEqual([]);
  expect(restored.result.current.pendingEntries).toMatchObject([
    { channelBound: true },
  ]);
  const fresh = {
    ...old,
    scope: "current",
    viewer: "current",
    channelName: "Renamed",
  };
  act(() =>
    restored.result.current.restoreEntries(
      () => panel,
      () => fresh,
    ),
  );
  expect(restored.result.current.entries[0]?.channelContext).toBe(fresh);
  expect(restored.result.current.entries[0]?.restored).toBe(true);
  const saved = sessionStorage.getItem(tabWorkspaceStorageKey(session().scope));
  expect(saved).not.toContain('"viewer"');
  expect(saved).not.toContain('"channelContext"');
});

test("close others keeps a pending selected tab and X permanently removes its descriptor", () => {
  const first = mount();
  act(() => first.result.current.setEntries([opening(), opening(github)]));
  first.unmount();
  const restored = mount();
  const keep = panelTabId(opening(github));
  act(() => restored.result.current.closeTabs(keep));
  expect(restored.result.current.pendingEntries).toMatchObject([
    { key: github.key },
  ]);
  expect(restored.result.current.selected).toBe(keep);
  act(() => restored.result.current.closePendingEntry(keep));
  restored.unmount();
  expect(mount().result.current.pendingEntries).toEqual([]);
});

test.each(["pending", "resolved"])(
  "closing a %s tab while another provider loads preserves the remaining order",
  (closing) => {
    const panels = [0, 1, 2, 3].map(
      (index) => ({ key: `ordering/${index}` }) as RegisteredPanel,
    );
    const first = mount();
    act(() =>
      first.result.current.setEntries(panels.map((panel) => opening(panel))),
    );
    first.unmount();
    const restored = mount();
    act(() =>
      restored.result.current.restoreEntries((key) =>
        panels.find((panel, index) => panel.key === key && index % 2 === 1),
      ),
    );
    act(() => {
      if (closing === "pending")
        restored.result.current.closePendingEntry(
          panelTabId(opening(panels[0])),
        );
      else
        restored.result.current.setEntries(
          restored.result.current.entries.filter(
            (entry) => entry.panel !== panels[1],
          ),
        );
    });
    act(() =>
      restored.result.current.restoreEntries((key) =>
        panels.find((panel) => panel.key === key),
      ),
    );
    expect(
      restored.result.current.entries.map((entry) => entry.panel.key),
    ).toEqual(
      panels
        .filter((_, index) => index !== (closing === "pending" ? 0 : 1))
        .map((panel) => panel.key),
    );
  },
);

test("a reset successor recovers descriptors even before the old workspace unmounts", async () => {
  const ctx = new Context();
  const transport: ReadTransport = {
    viewer: "viewer",
    relayAuthor: "relay",
    scope: "https://reset-order.example",
    media: () => undefined,
    query: async () => [],
  };
  const relay = provideRelay(ctx, async () => transport);
  try {
    await vi.waitFor(() => expect(relay.snapshot().status).toBe("ready"));
    const before = relay.snapshot();
    const old = mount(before.session);
    const liveEntry = opening();
    act(() => old.result.current.setEntries([liveEntry]));

    // Deliberately hold the old hook mounted through the actual service reset.
    // A service may request the successor before React applies its new page key.
    relay.disconnect();
    relay.retry();
    await vi.waitFor(() => expect(relay.snapshot().status).toBe("ready"));
    const successor = relay.snapshot();
    expect(successor.scope).toBe(before.scope);
    expect(successor.generation).toBeGreaterThan(before.generation);
    expect(successor.session).not.toBe(before.session);
    channelTabs(successor.session).list("alpha");
    expect(old.result.current.entries[0]).toBe(liveEntry);

    const recovered = mount(successor.session);
    expect(recovered.result.current.entries).toEqual([]);
    expect(recovered.result.current.pendingEntries).toMatchObject([
      { key: profile.key, target: liveEntry.target },
    ]);
    act(() => recovered.result.current.restoreEntries(() => profile));
    expect(recovered.result.current.entries[0]).not.toBe(liveEntry);
    expect(recovered.result.current.entries[0]?.restored).toBe(true);
  } finally {
    cleanup();
    await ctx.fiber.dispose();
  }
});

test("a denied cached session cannot hand live entries to a later accepted successor", async () => {
  const viewer = keypair(),
    authority = keypair();
  const scope = "https://denied-order.example";
  let cached = true;
  const disk: headPersistence.HeadPersistence = {
    readStartup: async () =>
      cached
        ? {
            discovery: {
              savedAt: Date.now(),
              relayAuthor: authority.pubkey,
              events: [
                roster(authority, "alpha", [viewer.pubkey]),
                metadata(authority, "alpha", "Alpha"),
              ],
            },
          }
        : undefined,
    read: async () => [],
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {
      cached = false;
    },
    close() {},
  };
  vi.spyOn(headPersistence, "createHeadPersistence").mockImplementation(
    () => disk,
  );
  const connections: {
    resolve: (value: ReadTransport) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const ctx = new Context();
  const relay = provideRelay(
    ctx,
    () =>
      new Promise<ReadTransport>((resolve, reject) => {
        connections.push({ resolve, reject });
      }),
    undefined,
    undefined,
    undefined,
    { viewer: viewer.pubkey, scope },
  );
  try {
    await vi.waitFor(() => expect(relay.snapshot().cached).toBe(true));
    const before = relay.snapshot();
    const old = mount(before.session);
    const liveEntry = opening();
    act(() => old.result.current.setEntries([liveEntry]));
    connections[0]?.reject(new ReadError("denied", "Removed"));
    await vi.waitFor(() => {
      expect(relay.snapshot().status).toBe("error");
      expect(relay.snapshot().cached).toBeUndefined();
    });
    expect(cached).toBe(false);
    relay.retry();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    connections[1]?.resolve({
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      scope,
      media: () => undefined,
      query: async () => [],
    });
    await vi.waitFor(() => expect(relay.snapshot().status).toBe("ready"));
    const successor = relay.snapshot();
    expect(successor.scope).toBe(before.scope);
    channelTabs(successor.session).list("alpha");
    expect(old.result.current.entries[0]).toBe(liveEntry);
    const recovered = mount(successor.session);
    expect(recovered.result.current.entries).toEqual([]);
    expect(recovered.result.current.pendingEntries).toMatchObject([
      { key: profile.key },
    ]);
    act(() => recovered.result.current.restoreEntries(() => profile));
    expect(recovered.result.current.entries[0]?.restored).toBe(true);
    expect(recovered.result.current.entries[0]).not.toBe(liveEntry);
  } finally {
    cleanup();
    await ctx.fiber.dispose();
  }
});

test("leave invalidation cannot repersist retained addresses after a same-scope rejoin", () => {
  const queries = session(`https://${crypto.randomUUID()}.example`);
  const old = mount(queries);
  const target = "https://github.com/sample/project/pull/42";
  act(() => {
    old.result.current.enterVisit("purged-detail:detail", undefined, true, {
      channelId: "alpha",
      target,
    });
    old.result.current.enterVisit("purged-thread:thread", {
      channelId: "alpha",
      messageId: "purged-reply",
      rootId: "purged-root",
    });
  });
  const key = tabWorkspaceStorageKey(queries.scope);
  expect(sessionStorage.getItem(key)).toContain(target);
  forgetTabWorkspaces(queries.scope);
  expect(sessionStorage.getItem(key)).toBeNull();
  act(() =>
    old.result.current.enterVisit("late-detail:detail", undefined, true, {
      channelId: "alpha",
      target,
    }),
  );
  expect(sessionStorage.getItem(key)).toBeNull();
  const rejoined = mount({ ...queries });
  expect(rejoined.result.current.detailVisits("alpha", target)).toEqual([]);
  expect(rejoined.result.current.threadVisits("alpha", "purged-root")).toEqual(
    [],
  );
  act(() => rejoined.result.current.select("new-selection"));
  const saved = sessionStorage.getItem(key);
  expect(saved).not.toBeNull();
  for (const address of [
    target,
    "purged-reply",
    "purged-root",
    "purged-detail",
    "late-detail",
  ])
    expect(saved).not.toContain(address);
});
