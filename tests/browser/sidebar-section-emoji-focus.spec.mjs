import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// A picked section emoji returns focus to the trigger, but that restored focus
// stays invisible for pointer entry and gains the dialog ring for keyboard
// navigation, without widening the shared dialog-button recipe.
test.use({ productionBroker: true, savedSidebar: true });

test("picked section emoji keeps pointer entry unringed and keyboard focus ringed", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "More actions for Channels", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Create section" });
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  const name = create.getByRole("textbox", { name: "Section name" });
  await expect(name).toBeFocused();
  const trigger = create.locator("[data-section-emoji-trigger]");
  const choose = create.getByRole("button", { name: "Choose section emoji" });
  await expect(choose).toBeVisible();
  await choose.click();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  await expect(search).toBeFocused();
  await search.fill("rocket");
  await page.getByRole("button", { name: "🚀", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS("outline-style", "solid");
});
