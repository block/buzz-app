// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

const activation = vi.hoisted(() => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
});
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.gated", name: "Gated", apiVersion: 1 },
      module: {
        inject: ["settingsCards"],
        async apply(ctx: Context) {
          await activation.held;
          ctx.settingsCards.register({
            id: "card",
            title: "Gated card",
            group: "Communities",
            component: () => <p>Gated card body</p>,
          });
        },
      },
    },
  ],
}));
let services: AppServices | undefined;
afterEach(async () => {
  activation.release();
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("waits for a starting plugin before opening its addressed Settings card", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const target = { version: 1, kind: "settings", section: "test.gated/card" };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  try {
    await waitFor(() =>
      expect(current.plugins.snapshot().activation["test.gated"]?.status).toBe(
        "starting",
      ),
    );
    expect(current.navigation.snapshot().status).not.toBe("failed");
    expect(
      screen.queryByText("This destination couldn’t open"),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => activation.release());
  }
  expect(await screen.findByText("Gated card body")).toBeVisible();
  expect(current.navigation.snapshot().status).toBe("opened");
});
