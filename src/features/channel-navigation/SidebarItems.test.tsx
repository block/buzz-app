// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { SidebarItems } from "./SidebarItems";
afterEach(cleanup);
it("resets a spent expansion when a list shrinks, so arrivals respect its cap", async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i) }));
  const tree = (count: number) => (
    <SidebarItems items={items.slice(0, count)} label="Sessions" expandAll>
      {(item) => <button type="button">Chat {item.id}</button>}
    </SidebarItems>
  );
  const view = render(tree(12));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "More in Sessions" }));
  expect(screen.getAllByRole("button", { name: /^Chat / })).toHaveLength(12);
  view.rerender(tree(3));
  view.rerender(tree(12));
  expect(screen.getAllByRole("button", { name: /^Chat / })).toHaveLength(5);
  expect(
    screen.queryByRole("button", { name: "Fewer in Sessions" }),
  ).toBeNull();
});
it("shows every pinned item without pagination controls", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i) }));
  render(
    <SidebarItems items={items} label="Pinned" uncapped>
      {(item) => <button type="button">Pinned {item.id}</button>}
    </SidebarItems>,
  );
  expect(screen.getAllByRole("button", { name: /^Pinned / })).toHaveLength(12);
  expect(screen.queryByRole("button", { name: "More in Pinned" })).toBeNull();
});
