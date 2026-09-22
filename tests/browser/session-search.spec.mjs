import { test, expect } from "./fixture.mjs";

const parent = "11111111-1111-4111-8111-111111111111";
test.use({
  sessionChannels: ["alpha"],
  sessionParents: { alpha: parent },
  historyCounts: { alpha: 5, beta: 5 },
});

// Native details toggle events and hidden descendants need real browser coverage.
test("global search opens a child session without changing collapsed sidebar levels", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const parentRow = page.locator(`button[data-channel-id="${parent}"]`);
  const child = sidebar.locator('button[data-channel-id="alpha"]');
  const section = sidebar.locator("details").filter({ has: parentRow });
  await expect(child).toBeVisible();
  await sidebar
    .getByRole("button", { name: `Collapse sessions in ${parent}` })
    .click();
  await expect(child).toBeHidden();
  await section.locator("summary").click();
  await expect(section).not.toHaveAttribute("open");

  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const search = dialog.getByRole("searchbox", { name: "Search Buzz" });
  await search.fill("Alpha");
  const result = dialog
    .locator("[data-search-result]")
    .filter({ hasText: "Alpha" })
    .first();
  await expect(result).toBeVisible();
  await search.press("ArrowDown");
  await expect(result).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(child).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Message this session", exact: true }),
  ).toBeVisible();

  // Remount so accidental onToggle persistence cannot be hidden by local state.
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect(section).not.toHaveAttribute("open");
  await section.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(
    sidebar.getByRole("button", { name: `Expand sessions in ${parent}` }),
  ).toBeVisible();
  await expect(child).toBeHidden();
  await page.keyboard.press("Space");
  await expect(section).not.toHaveAttribute("open");
});
