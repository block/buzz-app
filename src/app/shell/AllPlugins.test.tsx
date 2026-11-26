// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  ALL_PLUGINS_SEARCH_THRESHOLD,
  AllPlugins,
  arrangePlugins,
  type AllPluginsEntry,
} from "./AllPlugins";

afterEach(cleanup);

const entry = (
  key: string,
  overrides: Partial<AllPluginsEntry> = {},
): AllPluginsEntry => ({
  key,
  label: (key[0] ?? "").toUpperCase() + key.slice(1),
  icon: null,
  pinned: false,
  active: false,
  ...overrides,
});

function setup(plugins: AllPluginsEntry[]) {
  const props = {
    onOpen: vi.fn(),
    onPinnedChange: vi.fn(),
    onPinnedOrderChange: vi.fn(),
    sort: "custom" as const,
    onSortChange: vi.fn(),
  };
  render(<AllPlugins plugins={plugins} {...props} />);
  return props;
}

async function openPopover() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "All plugins" }));
  return { user, popup: await screen.findByRole("dialog") };
}

it("keeps pinned plugins in the person's order and sorts the rest A–Z", () => {
  const { pinned, rest } = arrangePlugins([
    entry("zebra", { pinned: true }),
    entry("delta"),
    entry("alpha", { pinned: true }),
    entry("charlie"),
    entry("bravo"),
  ]);
  expect(pinned.map(({ key }) => key)).toEqual(["zebra", "alpha"]);
  expect(rest.map(({ key }) => key)).toEqual(["bravo", "charlie", "delta"]);
});

it("filters both groups by name", () => {
  const { pinned, rest } = arrangePlugins(
    [entry("reminders", { pinned: true }), entry("repos"), entry("agents")],
    "RE",
  );
  expect(pinned.map(({ key }) => key)).toEqual(["reminders"]);
  expect(rest.map(({ key }) => key)).toEqual(["repos"]);
});

it("shows search only once there are enough plugins to need it", async () => {
  const few = Array.from({ length: ALL_PLUGINS_SEARCH_THRESHOLD - 1 }, (_, i) =>
    entry(`plugin${i}`),
  );
  setup(few);
  await openPopover();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  cleanup();

  setup([...few, entry("extra")]);
  const { user } = await openPopover();
  await user.type(screen.getByRole("searchbox"), "nothing");
  expect(screen.getByRole("status")).toHaveTextContent(
    "No plugins match “nothing”.",
  );
});

it("opens and pins from the list, without switches", async () => {
  const props = setup([entry("reminders", { pinned: true }), entry("agents")]);
  const { user, popup } = await openPopover();
  expect(within(popup).queryByRole("switch")).not.toBeInTheDocument();

  await user.click(within(popup).getByRole("button", { name: "Pin Agents" }));
  expect(props.onPinnedChange).toHaveBeenCalledWith("agents", true);

  await user.click(
    within(popup).getByRole("button", { name: "Unpin Reminders" }),
  );
  expect(props.onPinnedChange).toHaveBeenCalledWith("reminders", false);

  await user.click(within(popup).getByRole("button", { name: "Agents" }));
  expect(props.onOpen).toHaveBeenCalledWith("agents");
});

it("moves between plugins with the arrow keys", async () => {
  setup([entry("reminders", { pinned: true }), entry("agents")]);
  const { user, popup } = await openPopover();
  within(popup).getByRole("button", { name: "Reminders" }).focus();
  await user.keyboard("{ArrowDown}");
  expect(within(popup).getByRole("button", { name: "Agents" })).toHaveFocus();
});

it("reorders pinned plugins with the arrow keys on the handle", async () => {
  const props = setup([
    entry("alpha", { pinned: true }),
    entry("bravo", { pinned: true }),
    entry("charlie"),
  ]);
  const { user, popup } = await openPopover();
  // Unpinned plugins have no handle.
  expect(
    within(popup).queryByRole("button", { name: "Reorder Charlie" }),
  ).not.toBeInTheDocument();
  within(popup).getByRole("button", { name: "Reorder Alpha" }).focus();
  await user.keyboard("{ArrowDown}");
  expect(props.onPinnedOrderChange).toHaveBeenCalledWith(["bravo", "alpha"]);
});

it("offers A–Z or custom order for pinned plugins under Your plugins", async () => {
  const props = setup([entry("alpha", { pinned: true })]);
  const { user, popup } = await openPopover();
  expect(within(popup).getByText("Your plugins")).toBeInTheDocument();
  await user.click(
    within(popup).getByRole("combobox", { name: "Sort pinned plugins" }),
  );
  await user.click(await screen.findByRole("option", { name: "A–Z" }));
  expect(props.onSortChange).toHaveBeenCalledWith("alphabetical");
});
