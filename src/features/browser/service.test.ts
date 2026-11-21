// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Context } from "@deepseek-ai/cordis";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { inAppBrowserDisabled } from "./in-app-browser-preference";
import { BrowserService } from "./service";
import type { BrowserPlatform } from "./platform";

const contexts: Context[] = [];
afterEach(async () => {
  cleanup();
  inAppBrowserDisabled.set(false);
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

it("turns the in-app browser off for the next click, and mounts no website while off", async () => {
  const context = new Context();
  contexts.push(context);
  const host = platform(true);
  new BrowserService(context, host);
  expect(context.browser.available).toBe(true);
  inAppBrowserDisabled.set(true);
  expect(context.browser.available).toBe(false);
  render(createElement(context.browser.View, { url: "https://example.org/" }));
  expect(host.attach).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Open in browser" }),
  );
  expect(host.openExternal).toHaveBeenCalledWith("https://example.org/");
  inAppBrowserDisabled.set(false);
  expect(context.browser.available).toBe(true);
});
