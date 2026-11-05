// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserAccess } from "./control-access";
import { BrowserService } from "./service";
import type { BrowserPlatform } from "./platform";

const contexts: Context[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

function platform(available: boolean): BrowserPlatform {
  return {
    available,
    attach: vi.fn(),
    setBounds: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    detach: vi.fn(),
  };
}

it("exposes availability and a host View", () => {
  const context = new Context();
  contexts.push(context);
  new BrowserService(context, platform(true));
  expect(context.browser.available).toBe(true);
  expect(typeof context.browser.View).toBe("function");
});

it("exposes authorization primitives without host-owned UI or an opening workflow", () => {
  const context = new Context();
  contexts.push(context);
  const native = platform(true);
  native.control = {
    available: vi.fn(async () => true),
    execute: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(),
  };
  new BrowserService(context, native);
  expect(Object.keys(context.browser.control ?? {})).toEqual([
    "available",
    "eligible",
    "forRecipient",
    "execute",
  ]);
});

it("tells agent access when the View's page stops being shown", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 300),
  );
  const ended = vi.spyOn(BrowserAccess.prototype, "ended");
  const context = new Context();
  contexts.push(context);
  const native = platform(true);
  vi.mocked(native.attach).mockResolvedValue("session-1");
  vi.mocked(native.setBounds).mockResolvedValue();
  vi.mocked(native.status).mockResolvedValue({
    url: "https://example.org/",
    title: "Example",
    loading: false,
    error: null,
    control_granted: false,
    control_revision: 2,
  });
  native.control = {
    available: vi.fn(async () => true),
    execute: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(async () => {}),
  };
  new BrowserService(context, native);
  render(createElement(context.browser.View, { url: "https://example.org" }));
  await waitFor(() => expect(ended).toHaveBeenCalledWith("session-1", 2));
});
