import { test, expect } from "./fixture.mjs";
import { openPage, settleShellToggle } from "./navigation.mjs";

// Browser hit testing is required: jsdom cannot detect overflowing filter text.
test("New remains clickable beside enlarged navigation filters", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await settleShellToggle(page);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  const trigger = page.getByRole("button", { name: "New", exact: true });
  await expect(trigger).toBeInViewport();
  const before = await page
    .getByRole("tablist", { name: "Navigation scope" })
    .getByRole("tab", { selected: true })
    .textContent();
  await trigger.click();
  await expect(
    page.getByRole("menu", { name: "New", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("tablist", { name: "Navigation scope" })
      .getByRole("tab", { selected: true }),
  ).toHaveText(before);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

// Browser layout is required: wrapping depends on real flex sizing and fonts.
test("New stays beside the navigation filters at the minimum sidebar width", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  await resize.press("Home");
  await expect(resize).toHaveAttribute("aria-valuenow", "220");
  const tabs = page.getByRole("tablist", { name: "Navigation scope" });
  const trigger = page.getByRole("button", { name: "New", exact: true });
  await expect
    .poll(async () => {
      const [list, button] = await Promise.all([
        tabs.boundingBox(),
        trigger.boundingBox(),
      ]);
      const middle = button.y + button.height / 2;
      return middle > list.y && middle < list.y + list.height;
    })
    .toBe(true);
});
