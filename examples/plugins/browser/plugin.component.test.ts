// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./plugin.ts";

afterEach(() => {
  cleanup();
});

type FakePanel = {
  component: React.ComponentType<{ target: string; close(): void }>;
};

function setup(open: (url: string) => Promise<unknown>) {
  let registered: FakePanel | undefined;
  const ctx = {
    react: React,
    get(name: string) {
      return name === "browser" ? ctx.browser : undefined;
    },
    inject(_dependencies: string[], callback: (scope: typeof ctx) => void) {
      callback(ctx);
      return { await: async () => {} };
    },
    panels: {
      register(panel: FakePanel) {
        registered = panel;
      },
    },
    browser: { available: true, open },
  };
  void apply(ctx as never);
  if (!registered) throw new Error("Panel was not registered");
  return registered;
}

it(
  "StrictMode's double-invoke launches ctx.browser.open exactly once and " +
    "still settles to Opened, instead of getting stuck on the discarded " +
    "first effect instance's promise",
  async () => {
    let resolve!: (value: { status: string }) => void;
    const open = vi.fn(
      () => new Promise<{ status: string }>((r) => (resolve = r)),
    );
    const panel = setup(open);
    const Panel = panel.component;
    render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(Panel, {
          target: "https://example.com",
          close: () => {},
        }),
      ),
    );
    expect(open).toHaveBeenCalledTimes(1);
    resolve({ status: "opened" });
    await waitFor(() => screen.getByText("Opened."));
    expect(open).toHaveBeenCalledTimes(1);
  },
);

it("surfaces the platform's reason text for an invalid URL, not the bare status", async () => {
  const open = vi.fn(async () => ({
    status: "invalid-url",
    reason: "Only http and https URLs are supported",
  }));
  const panel = setup(open);
  const Panel = panel.component;
  render(
    React.createElement(Panel, {
      target: "https://example.com",
      close: () => {},
    }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Couldn't open this link (Only http and https URLs are supported).",
  );
});
