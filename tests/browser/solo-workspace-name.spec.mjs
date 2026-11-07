import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const id = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: [id],
  channelNames: { [id]: "Planning" },
  soloChannels: [id],
  ownSoloChannels: [id],
  historyCounts: { [id]: 1 },
});

// Proves real menu/dialog wiring and encrypted host round-tripping: the renamed
// workspace retains the same filed chat after a full app reload.
test("workspace settings rename a workspace without changing its chat filing", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  await sidebar
    .locator(`[data-solo-channel-id="${id}"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "New workspace", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "New workspace" });
  await create
    .getByRole("textbox", { name: "Workspace name" })
    .fill("Side project");
  await create.getByRole("button", { name: "Create and move" }).click();
  await expect(create).toHaveCount(0);
  await expect(sidebar.getByText("Saving workspace…")).toHaveCount(0);
  const project = sidebar.locator("[data-project]").filter({
    has: page.getByRole("button", { name: "Side project", exact: true }),
  });
  await expect(project.locator(`[data-solo-channel-id="${id}"]`)).toBeVisible();
  await project
    .getByRole("button", { name: "Side project", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Workspace settings",
    exact: true,
  });
  const name = settings.getByRole("textbox", {
    name: "Workspace name",
    exact: true,
  });
  await expect(name).toHaveValue("Side project");
  await name.fill("Launch planning");
  await expect(
    settings.getByRole("textbox", { name: /^Instructions/ }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Launch planning", exact: true }),
  ).toBeVisible();
  await page.reload();
  await newChat(page);
  const renamed = sidebar.locator("[data-project]").filter({
    has: page.getByRole("button", { name: "Launch planning", exact: true }),
  });
  await expect(renamed.locator(`[data-solo-channel-id="${id}"]`)).toBeVisible();
  await renamed
    .getByRole("button", { name: "Launch planning", exact: true })
    .focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  await expect(name).toHaveValue("Launch planning");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
});
