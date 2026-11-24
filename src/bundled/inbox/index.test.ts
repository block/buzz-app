// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarSectionsService } from "../../features/channel-navigation/sidebar-sections-service";
import { PagesService } from "../../features/pages/service";
import { SettingsCardsService } from "../../features/settings/service";
import { ShortcutsService } from "../../features/shortcuts/service";
import { PluginRuntime } from "../../plugins/runtime";
import { ACTIVITY_DISPLAY_KEY } from "./display";
import * as inbox from "./index";
import { apply } from "./index";
import manifest from "./manifest.json";

afterEach(() => vi.restoreAllMocks());
it("opens the Activity page with filters from four chords, including from the composer", () => {
  const shortcuts = { register: vi.fn() };
  const pages = { register: vi.fn() };
  const open = vi.fn();
  // Activity's own choice registers its page and card in a scope of their own.
  const scope = {
    pages,
    reflect: { get: () => undefined },
  };
  apply({
    pages,
    relay: {},
    navigation: { open },
    shortcuts,
    settingsCards: { register: vi.fn() },
    effect: vi.fn(),
    plugin: (apply: (ctx: typeof scope) => void) => {
      apply(scope);
      return { dispose: async () => {} };
    },
  } as unknown as Parameters<typeof apply>[0]);
  const registered = shortcuts.register.mock.calls.map(([item]) => item);
  const cases = [
    [
      "open-unread",
      "Open unread in Activity",
      "a",
      { activity: "all", attention: "unread" },
    ],
    ["open-threads", "Open threads in Activity", "t", { activity: "threads" }],
    [
      "open-mentions",
      "Open mentions in Activity",
      "m",
      { activity: "mentions" },
    ],
    ["open-dms", "Open DMs in Activity", "k", { activity: "dms" }],
  ] as const;
  // No other Activity shortcut: Archive was removed with the Archived view.
  expect(registered.map((item) => item.id)).toEqual(cases.map(([id]) => id));
  const orders = new Set<number>();
  for (const [id, title, key, params] of cases) {
    const shortcut = registered.find((item) => item.id === id);
    expect(shortcut).toMatchObject({
      title,
      binding: { key, mod: true, shift: true },
      allowInEditable: true,
    });
    expect(shortcut.when).toBeUndefined();
    orders.add(shortcut.order);
    open.mockClear();
    shortcut.run();
    expect(open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
      route: { version: 1, params },
    });
  }
  expect(orders.size).toBe(4);
  const [page] = pages.register.mock.calls[0] ?? [];
  // Shown as Activity; the page id and route stay "inbox".
  expect(page).toMatchObject({ id: "inbox", title: "Activity" });
  expect(page.route.version).toBe(1);
  expect(page.route.validate({ activity: "threads" })).toBe(true);
  expect(page.route.validate({ activity: "bogus" })).toBe(false);
  expect(page.handlesNavigation).toBeUndefined();
});

it("names the plugin Activity while keeping its buzz.inbox id", () => {
  expect(manifest).toMatchObject({ id: "buzz.inbox", name: "Activity" });
});

describe("Show Activity as", () => {
  const contexts: Context[] = [];
  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
    localStorage.clear();
  });

  async function setup() {
    const ctx = new Context();
    contexts.push(ctx);
    const runtime = new PluginRuntime(ctx, async () => inbox);
    ctx.effect(() => () => runtime.dispose());
    const pages = new PagesService(ctx);
    const sections = new SidebarSectionsService(ctx);
    new ShortcutsService(ctx, undefined);
    const settingsCards = new SettingsCardsService(ctx);
    ctx.provide("relay", {});
    ctx.provide("navigation", { open: vi.fn() });
    ctx.provide("conversation", { ui: {} });
    ctx.provide("panels", {});
    runtime.reconcile([
      {
        manifest: { id: "buzz.inbox", name: "Activity", apiVersion: 1 },
        enabled: true,
        source: "bundled",
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
      },
    ]);
    await vi.waitFor(() => expect(pages.snapshot()).toHaveLength(1));
    return {
      primary: () => pages.snapshot().map((page) => page.primary),
      cards: () => sections.snapshot().map((section) => section.id),
      settingsCards,
    };
  }

  it("shows the page and the sidebar card by default", async () => {
    const t = await setup();
    expect(t.primary()).toEqual([true]);
    expect(t.cards()).toEqual(["activity"]);
    expect(t.settingsCards.snapshot().map((card) => card.id)).toEqual([
      "activity",
    ]);
  });

  it("follows a change: the page stays for links, only its sidebar entry goes", async () => {
    const t = await setup();
    localStorage.setItem(ACTIVITY_DISPLAY_KEY, "card");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ACTIVITY_DISPLAY_KEY,
        storageArea: localStorage,
      }),
    );
    await vi.waitFor(() => expect(t.primary()).toEqual([false]));
    expect(t.cards()).toEqual(["activity"]);
    localStorage.setItem(ACTIVITY_DISPLAY_KEY, "page");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ACTIVITY_DISPLAY_KEY,
        storageArea: localStorage,
      }),
    );
    await vi.waitFor(() => expect(t.cards()).toEqual([]));
    expect(t.primary()).toEqual([true]);
  });
});
