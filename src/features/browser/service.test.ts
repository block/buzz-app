import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserService } from "./service";
import type { BrowserOpenResult } from "./api";
import type { BrowserPlatform } from "./platform";

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

function setup(platform: BrowserPlatform) {
  const ctx = new Context();
  contexts.push(ctx);
  new BrowserService(ctx, platform);
  return ctx;
}

function fakePlatform(available: boolean, result: BrowserOpenResult) {
  return {
    available,
    open: vi.fn(async () => result),
  } satisfies BrowserPlatform;
}

it("exposes the underlying platform's availability", () => {
  const ctx = setup(fakePlatform(true, { status: "opened" }));
  expect(ctx.browser.available).toBe(true);
});

it("reports unavailable when the platform has no capability", () => {
  const ctx = setup(fakePlatform(false, { status: "unavailable" }));
  expect(ctx.browser.available).toBe(false);
});

it("delegates open() to the platform", async () => {
  const platform = fakePlatform(true, { status: "opened" });
  const ctx = setup(platform);
  await expect(ctx.browser.open("https://example.com")).resolves.toEqual({
    status: "opened",
  });
  expect(platform.open).toHaveBeenCalledWith("https://example.com");
});
