// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { QuickViewProps } from "./service";
import { QuickViews } from "./QuickViews";
import { PagesService } from "./service";

function setup() {
  const ctx = new Context();
  const active = new Set(["org.example", "someone.else"]);
  const listeners = new Set<() => void>();
  ctx.provide("pluginStatus", {
    isActive: (id: string) => active.has(id),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const pages = new PagesService(ctx);
  const plugin = (id: string) =>
    ctx.extend({ pluginOwner: Object.freeze({ id, revision: "1" }) }).pages;
  const stop = (id: string) => {
    active.delete(id);
    for (const listener of listeners) listener();
  };
  return { pages, plugin, stop };
}

it("opens a plugin's quick view in the palette until the body closes it", async () => {
  const { pages, plugin } = setup();
  const owner = plugin("org.example");
  owner.registerQuickView({
    id: "tasks",
    title: "Tasks",
    component: ({ close }: QuickViewProps) => (
      <button type="button" onClick={close}>
        Done
      </button>
    ),
  });
  render(<QuickViews pages={pages} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  // A plugin opens only its own quick views.
  expect(() => plugin("someone.else").openQuickView("tasks")).toThrow(
    /No active quick view/,
  );
  act(() => owner.openQuickView("tasks"));
  expect(screen.getByRole("dialog", { name: "Tasks" })).toBeTruthy();
  act(() => screen.getByRole("button", { name: "Done" }).click());
  await waitFor(() => expect(screen.queryByText("Done")).toBeNull());
});

it("closes a quick view whose plugin stops", async () => {
  const { pages, plugin, stop } = setup();
  const owner = plugin("org.example");
  owner.registerQuickView({
    id: "tasks",
    title: "Tasks",
    component: () => <p>Body</p>,
  });
  render(<QuickViews pages={pages} />);
  act(() => owner.openQuickView("tasks"));
  expect(screen.getByText("Body")).toBeTruthy();
  act(() => stop("org.example"));
  await waitFor(() => expect(screen.queryByText("Body")).toBeNull());
  expect(pages.quickViews.open()).toBeUndefined();
});
