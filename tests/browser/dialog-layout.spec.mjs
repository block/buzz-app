import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real app geometry and pointer hit testing cannot be established in jsdom.
// Small fixtures exercise the shared recipe through its current callers.
test.use({ productionBroker: true, savedSidebar: true });

test("workspace controls reached by Tab remain clickable beneath sticky gutters", async ({
  page,
  app,
  browserName,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New workspace",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const worktree = dialog.getByRole("switch", {
    name: "Work in a new worktree",
  });
  for (const control of [
    dialog.getByRole("textbox", { name: "Name", exact: true }),
    dialog.getByRole("textbox", { name: "Instructions Optional", exact: true }),
    dialog.getByRole("textbox", { name: "Folders Optional", exact: true }),
    worktree,
  ]) {
    await page.keyboard.press(tab);
    await expect(control).toBeFocused();
  }
  await expect(worktree).not.toBeChecked();
  const bounds = await worktree.boundingBox();
  expect(bounds).not.toBeNull();
  // A locator click would auto-scroll and conceal the keyboard-to-pointer bug.
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(worktree).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("compact section forms preserve separation between their field and actions", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "More actions for Channels", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(field).toBeFocused();
  await expect
    .poll(async () => {
      const input = await field.boundingBox();
      const action = await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .boundingBox();
      const rem = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
      return (action.y - input.y - input.height) / rem;
    })
    .toBeGreaterThanOrEqual(1.5); // 0.5rem compact content gap + 1rem fixed gutter.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
