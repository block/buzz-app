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
  const view = render(
    <div className="shell-background">
      <ShellBackdrops backdrops={backdrops} />
      <header>chrome</header>
    </div>,
  );
  return { root, install, view };
}

it("leaves the shell untouched until a plugin registers, and again after it leaves", async () => {
  const { root, install, view } = setup();
  const original = view.container.innerHTML;
  expect(view.container.querySelector(".shell-backdrop")).toBeNull();

  const remove = await install("example.plugin", {
    id: "glow",
    component: () => <canvas data-testid="glow" />,
  });
  const layer = view.container.querySelector(".shell-backdrop");
  expect(layer?.parentElement).toHaveClass("shell-background");
  expect(layer).toHaveAttribute("aria-hidden", "true");
  expect(layer).toHaveAttribute("inert");
  expect(view.getByTestId("glow").closest(".shell-backdrop")).toBe(layer);

  await remove();
  expect(view.container.innerHTML).toBe(original);
  await root.fiber.dispose();
});

it("stacks backdrops in registration order and drops a failing one silently", async () => {
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

  const layer = view.container.querySelector(".shell-backdrop");
  expect(layer?.textContent).toBe("firstthird");
  expect(view.queryByRole("alert")).toBeNull();
  await root.fiber.dispose();
});
