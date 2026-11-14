// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { NewMenuService } from "../../features/new-menu/service";
import { fixture, owners } from "./sidebar-testing";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
});

function pluginMenu() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new NewMenuService(root);
  const plugin = (register: (menu: NewMenuService) => void) =>
    root
      .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
      .plugin((ctx) => register(ctx.newMenu as NewMenuService));
  return { root, service, plugin };
}

const menuItems = async () =>
  (await screen.findAllByRole("menuitem")).map((item) => item.textContent);

it("lists plugin items after the built-in items in their group, runs them, and drops them with the plugin", async () => {
  const user = userEvent.setup();
  const menu = pluginMenu();
  const linear = vi.fn();
  const invite = vi.fn(async () => {});
  const fiber = menu.plugin((newMenu) => {
    newMenu.register({
      id: "invite",
      title: "Invite teammate",
      group: "team",
      run: invite,
    });
    newMenu.register({
      id: "linear",
      title: "New chat from Linear",
      group: "solo",
      run: linear,
    });
  });
  await fiber.await();
  fixture(true, false, undefined, undefined, 0, undefined, undefined, {
    newMenu: menu.service,
  });

  await user.click(screen.getByRole("button", { name: "New" }));
  expect(await menuItems()).toEqual([
    "New chat",
    "New workspace",
    "New chat from Linear",
    "New DM",
    "New channel",
    "New section",
    "Invite teammate",
  ]);
  await user.click(
    screen.getByRole("menuitem", { name: "New chat from Linear" }),
  );
  expect(linear).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  await user.click(screen.getByRole("button", { name: "New" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Invite teammate" }),
  );
  expect(invite).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "New" }));
  await screen.findByRole("menuitem", { name: "Invite teammate" });
  await act(() => fiber.dispose());
  expect(await menuItems()).toEqual([
    "New chat",
    "New workspace",
    "New DM",
    "New channel",
    "New section",
  ]);
  await menu.root.fiber.dispose();
});

it("logs a failing plugin item without breaking the menu", async () => {
  const user = userEvent.setup();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const menu = pluginMenu();
  const fiber = menu.plugin((newMenu) => {
    newMenu.register({
      id: "throws",
      title: "Throws",
      group: "solo",
      run: () => {
        throw new Error("thrown");
      },
    });
    newMenu.register({
      id: "rejects",
      title: "Rejects",
      group: "solo",
      run: async () => {
        throw new Error("rejected");
      },
    });
  });
  await fiber.await();
  fixture(true, false, undefined, undefined, 0, undefined, undefined, {
    newMenu: menu.service,
  });

  for (const name of ["Throws", "Rejects"]) {
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
  await waitFor(() =>
    expect(
      error.mock.calls
        .map(([message]) => message)
        .filter((message) => String(message).startsWith("New menu item")),
    ).toEqual([
      "New menu item failed: example.plugin/throws",
      "New menu item failed: example.plugin/rejects",
    ]),
  );
  expect(screen.getByRole("button", { name: "New" })).toBeEnabled();
  await menu.root.fiber.dispose();
});
