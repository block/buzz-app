// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserService } from "./service";
import type { BrowserPlatform } from "./platform";

const contexts: Context[] = [];
afterEach(async () => {
  localStorage.clear();
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

function platform(available: boolean): BrowserPlatform {
  return {
    available,
    attach: vi.fn(),
    setBounds: vi.fn(),
    setMediaSuspended: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    detach: vi.fn(),
    openExternal: vi.fn(),
  };
}

it("exposes availability and a host View", () => {
  const context = new Context();
  contexts.push(context);
  new BrowserService(context, platform(true));
  expect(context.browser.available).toBe(true);
  expect(typeof context.browser.View).toBe("function");
});

it("declines the viewer when website links are set to the browser", () => {
  const context = new Context();
  contexts.push(context);
  new BrowserService(context, platform(true));
  localStorage.setItem("buzz-website-viewer.v1", "browser");
  expect(context.browser.available).toBe(false);
  localStorage.setItem("buzz-website-viewer.v1", "buzz");
  expect(context.browser.available).toBe(true);
  localStorage.removeItem("buzz-website-viewer.v1");
});
