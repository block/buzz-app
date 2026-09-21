import { test, expect } from "./fixture.mjs";

const parent = "11111111-1111-4111-8111-111111111111";
test.use({
  sessionChannels: ["alpha"],
  sessionParents: { alpha: parent },
  historyCounts: { alpha: 5, beta: 5 },
});

// Native details toggle events and hidden descendants need real browser coverage.
test("child-only search temporarily opens both collapsed sidebar levels", async ({
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
  const search = page.getByRole("searchbox", { name: "Search channels" });
  await expect(child).toBeVisible();
  await sidebar
    .getByRole("button", { name: `Collapse sessions in ${parent}` })
    .click();
  await expect(child).toBeHidden();
  await section.locator("summary").click();
  await expect(section).not.toHaveAttribute("open");

  await search.fill("Alpha");
  await expect(child).toBeVisible();
  await section.locator("summary").click();
  await expect(child).toBeVisible();
  await child.click();
  await expect(
    page.getByRole("textbox", { name: "Message this session", exact: true }),
  ).toBeVisible();

  // Remount so accidental onToggle persistence cannot be hidden by local state.
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect(search).toHaveValue("Alpha");
  await expect(child).toBeVisible();
  await search.fill("");
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
