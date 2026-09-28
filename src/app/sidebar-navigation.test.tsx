// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Messages", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "channels",
            title: "Messages",
            component: () => <h1>Messages page</h1>,
          });
        },
      },
    },
    {
      manifest: { id: "buzz.workflows", name: "Workflows", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "workflows",
            title: "Workflows",
            layout: "workspace",
            component: () => <h1>Workflows page</h1>,
          });
        },
      },
    },
  ],
}));

let services: AppServices | undefined;

afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  localStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("renders enabled contributed pages in the disconnected sidebar and follows plugin changes", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  services = createServices();
  const current = services;
  render(<App services={current} />);

  const workflows = await screen.findByRole("button", { name: "Workflows" });
  const pages = workflows.closest("nav");
  expect(current.relay.snapshot().status).toBe("disconnected");
  expect(screen.getByRole("button", { name: "Messages" })).toBeVisible();
  expect(workflows).toBeVisible();
  expect(pages).toContainElement(workflows);

  await act(async () => {
    await current.plugins.change("disable", "buzz.workflows");
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Workflows" }),
    ).not.toBeInTheDocument(),
  );

  await act(async () => {
    await current.plugins.change("enable", "buzz.workflows");
  });
  const restored = await screen.findByRole("button", { name: "Workflows" });
  await userEvent.click(restored);

  expect(
    await screen.findByRole("heading", { name: "Workflows page" }),
  ).toBeVisible();
  expect(screen.getByRole("main")).toHaveFocus();
  expect(current.navigation.snapshot().entry.target).toMatchObject({
    kind: "page",
    pluginId: "buzz.workflows",
    pageId: "workflows",
  });
});
