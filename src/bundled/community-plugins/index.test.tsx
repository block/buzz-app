// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { provideNavigation } from "../../features/navigation/service";
import { PagesService } from "../../features/pages/service";
import { apply, inject } from ".";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it("registers one primary workspace page and removes it on dispose", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const pages = new PagesService(ctx);
  provideNavigation(ctx, undefined);
  ctx.provide("relay", {
    snapshot: () => ({ status: "disconnected" }),
    subscribe: () => () => {},
  });
  ctx.provide("pluginInventory", {
    installed: () => [],
    subscribe: () => () => {},
  });
  ctx.provide("host", {
    request: async () => ({ status: 404, headers: {}, body: "" }),
  });
  const scope = ctx
    .extend({
      pluginOwner: { id: "buzz.community-plugins", revision: "bundled" },
    })
    .plugin({ inject, apply });
  try {
    await scope;
    expect(pages.snapshot()).toMatchObject([
      {
        id: "community-plugins",
        title: "Community plugins",
        layout: "workspace",
        primary: true,
      },
    ]);
    await scope.dispose();
    expect(pages.snapshot()).toEqual([]);
  } finally {
    await scope.dispose();
    await ctx.fiber.dispose();
  }
});

it("records nothing in a build without a community index", async () => {
  vi.stubEnv("VITE_BUZZ_COMMUNITY_PLUGIN_INDEX_URL", "");
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  new PagesService(ctx);
  provideNavigation(ctx, undefined);
  const subscribe = vi.fn(() => () => {});
  ctx.provide("relay", {
    snapshot: () => ({ status: "disconnected" }),
    subscribe,
  });
  const installed = vi.fn(() => []);
  ctx.provide("pluginInventory", { installed, subscribe });
  ctx.provide("host", {
    request: async () => ({ status: 404, headers: {}, body: "" }),
  });
  const scope = ctx
    .extend({
      pluginOwner: { id: "buzz.community-plugins", revision: "bundled" },
    })
    .plugin({ inject, apply });
  try {
    await scope;
    expect(subscribe).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await scope.dispose();
    await ctx.fiber.dispose();
  }
});

it("says the page needs the desktop app when host requests can't run, instead of offering a retry", async () => {
  vi.stubEnv(
    "VITE_BUZZ_COMMUNITY_PLUGIN_INDEX_URL",
    "https://raw.githubusercontent.com/block/buzz-plugins/index/index.json",
  );
  const request = vi.fn();
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const pages = new PagesService(ctx);
  provideNavigation(ctx, undefined);
  const disconnected = { status: "disconnected" };
  ctx.provide("relay", {
    snapshot: () => disconnected,
    subscribe: () => () => {},
  });
  const watchInventory = vi.fn(() => () => {});
  ctx.provide("pluginInventory", {
    installed: () => [],
    subscribe: watchInventory,
  });
  ctx.provide("host", { request, canRequest: () => false });
  const scope = ctx
    .extend({
      pluginOwner: { id: "buzz.community-plugins", revision: "bundled" },
    })
    .plugin({ inject, apply });
  try {
    await scope;
    const page = pages.snapshot()[0];
    expect(page).toBeDefined();
    if (!page) return;
    render(createElement(page.component, {} as never));
    expect(screen.getByText(/needs the Buzz desktop app/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(watchInventory).not.toHaveBeenCalled();
  } finally {
    await scope.dispose();
    await ctx.fiber.dispose();
  }
});
