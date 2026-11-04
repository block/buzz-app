// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BackdropsService, type Backdrop } from "./service";
import { ShellBackdrops } from "./ShellBackdrops";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const backdrops = new BackdropsService(root);
  const install = async (id: string, ...entries: Backdrop[]) => {
    const fiber = root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => {
        for (const entry of entries) ctx.backdrops?.register(entry);
      });
    await act(() => fiber.await());
    return () => act(() => fiber.dispose());
  };
  const view = render(<ShellBackdrops backdrops={backdrops} />);
  return { root, install, view };
}

it("gives each backdrop its own layer in registration order and drops a failing one silently", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { root, install, view } = setup();
  await install("first.plugin", { id: "a", component: () => <i>first</i> });
  await install("broken.plugin", {
    id: "b",
    component: () => {
      throw new Error("paint failed");
    },
  });
  await install("third.plugin", { id: "c", component: () => <i>third</i> });

  const layers = view.container.querySelectorAll(
    ".shell-backdrop > .shell-backdrop-layer",
  );
  expect([...layers].map((layer) => layer.textContent)).toEqual([
    "first",
    "third",
  ]);
  expect(view.queryByRole("alert", { hidden: true })).toBeNull();
  await root.fiber.dispose();
});
