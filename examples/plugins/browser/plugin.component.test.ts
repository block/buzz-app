// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./plugin.ts";

afterEach(cleanup);

type FakePanel = {
  component: React.ComponentType<{ target: string; close(): void }>;
};

async function setup() {
  let registered: FakePanel | undefined;
  const View = vi.fn(({ url }: { url: string }) =>
    React.createElement("div", { "data-testid": "host-browser" }, url),
  );
  const context = {
    react: React,
    get(name: string) {
      return name === "browser" ? context.browser : undefined;
    },
    inject(_dependencies: string[], callback: (scope: typeof context) => void) {
      callback(context);
      return { await: async () => {} };
    },
    panels: {
      register(panel: FakePanel) {
        registered = panel;
      },
    },
    browser: { available: true, View },
  };
  await apply(context as never);
  if (!registered) throw new Error("Panel was not registered");
  return { panel: registered, View };
}

it("renders the host browser View with the panel target", async () => {
  const { panel, View } = await setup();
  const Panel = panel.component;
  render(
    React.createElement(Panel, {
      target: "https://example.com/path",
      close: () => {},
    }),
  );
  expect(screen.getByTestId("host-browser")).toHaveTextContent(
    "https://example.com/path",
  );
  expect(View).toHaveBeenCalledWith(
    { url: "https://example.com/path" },
    undefined,
  );
});
