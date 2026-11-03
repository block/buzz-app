// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { PageProps } from "../features/pages/service";
import type { OpenTarget } from "../features/navigation/targets";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

const gate = vi.hoisted(() => {
  const state = {
    held: Promise.resolve(),
    release: () => {},
    reset() {
      state.held = new Promise<void>((resolve) => {
        state.release = resolve;
      });
    },
  };
  return state;
});

function Params({ navigation }: PageProps) {
  const target = navigation?.target;
  return (
    <p>
      {target?.kind === "page" ? target.pageId : "?"}:
      {JSON.stringify(
        target?.kind === "page" ? (target.route?.params ?? null) : null,
      )}
    </p>
  );
}
const slugRoute = {
  version: 1,
  validate: (params: unknown) =>
    typeof params === "object" &&
    params !== null &&
    typeof (params as { slug?: unknown }).slug === "string" &&
    (params as { slug: string }).slug !== "forbidden",
};
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.catalog", name: "Catalog", apiVersion: 1 },
      module: {
        inject: ["pages"],
        async apply(ctx: Context) {
          await gate.held;
          ctx.pages.register({ id: "list", title: "List", component: Params });
          ctx.pages.register({
            id: "entry",
            title: "Entry",
            primary: true,
            route: slugRoute,
            component: Params,
          });
        },
      },
    },
    {
      manifest: { id: "test.plain", name: "Plain", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "first",
            title: "First",
            component: Params,
          });
          ctx.pages.register({
            id: "second",
            title: "Second",
            component: Params,
          });
        },
      },
    },
    {
      manifest: { id: "test.off", name: "Dormant", apiVersion: 1 },
      enabledByDefault: false,
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({ id: "main", title: "Main", component: Params });
        },
      },
    },
  ],
}));

beforeEach(() => {
  gate.reset();
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
  gate.release();
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function start(target: OpenTarget) {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}
const link = (fields: Record<string, unknown>) =>
  ({ version: 1, kind: "plugin", ...fields }) as OpenTarget;

it("opens the primary page with validated link params once its plugin activates", async () => {
  const current = start(
    link({ pluginId: "test.catalog", params: { slug: "alpha" } }),
  );
  await waitFor(() =>
    expect(current.plugins.snapshot().activation["test.catalog"]?.status).toBe(
      "starting",
    ),
  );
  expect(current.navigation.snapshot().status).not.toBe("failed");
  await act(async () => gate.release());
  expect(await screen.findByText('entry:{"slug":"alpha"}')).toBeVisible();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: {
      target: {
        kind: "page",
        pluginId: "test.catalog",
        pageId: "entry",
        route: { version: 1, params: { slug: "alpha" } },
      },
    },
    canGoBack: false,
  });
});

it("opens a named page, and the page without params when its validator refuses them", async () => {
  gate.release();
  const current = start(
    link({
      pluginId: "test.catalog",
      pageId: "entry",
      params: { slug: "forbidden" },
    }),
  );
  expect(await screen.findByText("entry:null")).toBeVisible();
  expect(current.navigation.snapshot().entry.target).not.toHaveProperty(
    "route",
  );
});

it("drops params for a page that declares no route", async () => {
  gate.release();
  start(
    link({ pluginId: "test.catalog", pageId: "list", params: { slug: "a" } }),
  );
  expect(await screen.findByText("list:null")).toBeVisible();
});

it("opens the first page of a plugin with no primary page", async () => {
  start(link({ pluginId: "test.plain" }));
  expect(await screen.findByText("first:null")).toBeVisible();
});

it("explains a plugin that is not installed and opens Manage plugins on request", async () => {
  gate.release();
  const user = userEvent.setup();
  const current = start(link({ pluginId: "test.absent" }));
  expect(
    await screen.findByRole("heading", { name: "test.absent isn’t installed" }),
  ).toBeVisible();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "unavailable",
  });
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Manage plugins" }));
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toMatchObject({
      kind: "settings",
      section: "plugins",
    }),
  );
});

it("explains a plugin that is turned off without enabling it", async () => {
  gate.release();
  const current = start(link({ pluginId: "test.off" }));
  expect(
    await screen.findByRole("heading", { name: "Dormant is turned off" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Manage plugins" })).toBeVisible();
  const catalog = current.plugins.snapshot().configuration;
  expect(
    catalog.status === "ready" &&
      catalog.catalog.plugins.find(
        (plugin) => plugin.manifest.id === "test.off",
      )?.enabled,
  ).toBe(false);
});

it("names the missing page of an enabled plugin and offers no install action", async () => {
  gate.release();
  start(link({ pluginId: "test.plain", pageId: "nope" }));
  expect(
    await screen.findByRole("heading", { name: "Plain has no page “nope”" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage plugins" })).toBeNull();
});

it("keeps the generic notice when a page target, not a plugin link, fails", async () => {
  gate.release();
  start({
    version: 1,
    kind: "page",
    pluginId: "test.absent",
    pageId: "main",
  });
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage plugins" })).toBeNull();
});
