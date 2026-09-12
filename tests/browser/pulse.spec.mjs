import { test, expect } from "./fixture.mjs";
const pulse = (page) =>
  page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Pulse", exact: true });
const view = (page, name) =>
  page
    .getByRole("navigation", { name: "Pulse views" })
    .getByRole("button", { name, exact: true });

test("Pulse reads shared activity, searches, opens a conversation and retains scoped drafts", async ({
  page,
  app,
}, testInfo) => {
  // Match the real relay: window extensions are single-channel only.
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      Array.isArray(filters) &&
      filters.some(
        (filter) =>
          filter["#h"]?.length > 1 && (filter.top_level || filter.include_aux),
      )
    ) {
      await route.fulfill({
        status: 400,
        json: { error: "top_level requires exactly one #h channel" },
      });
    } else await route.continue();
  });
  await page.goto(app.origin);
  await pulse(page).click();
  await expect(
    page.getByRole("article", { name: "Activity in Alpha" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pulse-light.png") });
  await view(page, "Search").click();
  const search = page.getByRole("searchbox", {
    name: "Search recent Pulse activity",
  });
  await search.fill("nothing-matches-this");
  await expect(
    page.getByText("No recent conversations match that search."),
  ).toBeVisible();
  await search.fill("message 639");
  await expect(page.getByRole("article")).toHaveCount(1);
  const before = performance.now();
  await page.getByRole("button", { name: /Open conversation ↗/ }).click();
  await expect(
    page.getByRole("region", { name: "Channel message history" }),
  ).toBeVisible();
  app.report.measurements.push({
    name: "pulse-cold-open",
    durationMs: performance.now() - before,
  });
  const draft = page.getByRole("textbox", { name: "Message #Alpha" });
  await draft.fill("Keep this Pulse draft");
  await page.getByRole("button", { name: "Back to Pulse" }).click();
  const warm = performance.now();
  await page.getByRole("button", { name: /Open conversation ↗/ }).click();
  await expect(draft).toHaveValue("Keep this Pulse draft");
  app.report.measurements.push({
    name: "pulse-warm-open",
    durationMs: performance.now() - warm,
  });
  await page.screenshot({
    path: testInfo.outputPath("pulse-conversation.png"),
  });
  await page.getByRole("button", { name: "Back to Pulse" }).click();
  await view(page, "All messages").click();
  await page.getByRole("button", { name: "Bestie", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Bestie", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Bestie panel" }).click();
  await page.getByRole("button", { name: "Your profile" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await pulse(page).click();
  await page.screenshot({ path: testInfo.outputPath("pulse-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("pulse-mobile.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await view(page, "For you").click();
  await expect(
    page.getByText(
      "No direct conversations or mentions in this recent window.",
    ),
  ).toBeVisible();
});
