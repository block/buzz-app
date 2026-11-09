// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

// One plugin with a plain page and a launcher panel that always throws. The
// page doesn't host the companion, so the shell renders the panel outside it.
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.owned", name: "Owned Tools", apiVersion: 1 },
      module: {
        inject: ["pages", "panels"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "home",
            title: "Home",
            route: { version: 1, validate: () => true },
            component: () => <p>Home content</p>,
          });
          ctx.panels.register({
            id: "broken",
            title: "Broken tools",
            matches: (target) => target === "test:broken",
            launcher: { icon: "/buzz-mark.svg", target: "test:broken" },
            component: () => {
              throw new Error("Fixture companion failure");
            },
          });
        },
      },
    },
  ],
}));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

// The catalog lists this bundled fixture as an external plugin when asked to.
function start(external: boolean) {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "page",
        pluginId: "test.owned",
        pageId: "home",
      }),
    )}`,
  );
  const current = createServices();
  services = current;
  if (external) {
    const read = current.plugins.snapshot;
    let seen: ReturnType<typeof read> | undefined;
    let shown: ReturnType<typeof read> | undefined;
    current.plugins.snapshot = () => {
      const next = read();
      if (next !== seen) {
        seen = next;
        const { configuration } = next;
        shown =
          configuration.status === "ready"
            ? {
                ...next,
                configuration: {
                  ...configuration,
                  catalog: {
                    ...configuration.catalog,
                    plugins: configuration.catalog.plugins.map((plugin) =>
                      plugin.manifest.id === "test.owned"
                        ? { ...plugin, source: "external" as const }
                        : plugin,
                    ),
                  },
                },
              }
            : next;
      }
      return shown ?? next;
    };
  }
  render(<App services={current} />);
  return current;
}

it("names an external plugin when its launcher companion fails", async () => {
  start(true);
  expect(await screen.findByText("Home content")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Broken tools" }));

  expect(
    await screen.findByRole("heading", { name: "This panel couldn’t open" }),
  ).toBeVisible();
  expect(
    screen.getByText("Owned Tools had a problem showing it."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Manage plugin" }));
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
  const target = decodeURIComponent(window.location.hash);
  expect(target).toContain('"section":"plugins"');
  expect(target).toContain('"pluginId":"test.owned"');
});

it("keeps a built-in companion's failure generic", async () => {
  start(false);
  expect(await screen.findByText("Home content")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Broken tools" }));

  expect(
    await screen.findByRole("heading", { name: "This panel couldn’t open" }),
  ).toBeVisible();
  expect(
    screen.getByText("Something went wrong showing this panel."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage plugin" })).toBeNull();
});
