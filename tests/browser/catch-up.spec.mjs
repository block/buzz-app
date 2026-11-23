import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { holdReadingFocus } from "./reading.mjs";
import { channelUnread } from "./unread-state.mjs";

test.use({
  productionBroker: true,
  readState: true,
  pluginFixtures: true,
  enabledPlugins: ["buzz.catch-up"],
  historyCounts: { alpha: 2, beta: 2 },
});

// Real plugin activation/navigation and the shared unread engine are the boundary:
// a preview must leave evidence unread; an explicit read must update the sidebar owner.
test("Catch up keeps previews unread and reads only on request", async ({
  page,
  app,
}, info) => {
  await holdReadingFocus(page);
  await page.goto(app.origin);
  await openPage(page, "Catch up");
  const card = page.getByRole("article", { name: /^Unread conversation:/ });
  await expect(card).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark as read", exact: true }),
  ).toBeEnabled();
  const before = await channelUnread(page, "alpha");
  expect(before.observedCount).toBeGreaterThan(0);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
    }, mode);
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await page.screenshot({ path: info.outputPath(`catch-up-${mode}.png`) });
  }
  await page.setViewportSize({ width: 480, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "1.5");
    window.dispatchEvent(
      new StorageEvent("storage", { key: null, storageArea: localStorage }),
    );
  });
  const keep = page.getByRole("button", { name: "Keep unread", exact: true });
  await keep.focus();
  await keep.press("Enter");
  await expect(card).toBeVisible();
  expect((await channelUnread(page, "alpha")).observedCount).toBe(
    before.observedCount,
  );
  await page.getByRole("button", { name: "Mark as read", exact: true }).click();
  await expect(
    page.getByText("Review complete", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(card).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark as read", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Mark as read", exact: true }).click();
  await expect(
    page.getByText("No unread conversations observed", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await channelUnread(page, "alpha")).observedCount)
    .toBe(0);
  await expect
    .poll(async () => (await channelUnread(page, "beta")).observedCount)
    .toBe(0);
});

test("Catch up supports mouse and trackpad swipes", async ({ page, app }) => {
  await holdReadingFocus(page);
  await page.goto(app.origin);
  await openPage(page, "Catch up");
  const card = page.getByRole("article", { name: /^Unread conversation:/ });
  await expect(card).toContainText("primary alpha message");
  const before = await channelUnread(page, "alpha");
  // Real browser pointer input proves pointer capture and the moving card remain
  // wired together; the component layer covers the directional/cancellation matrix.
  const heading = await card
    .getByRole("heading", { name: "Alpha" })
    .boundingBox();
  expect(heading).not.toBeNull();
  const x = heading.x + heading.width / 2;
  const y = heading.y + heading.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 6 });
  await page.mouse.up();
  await expect(card).toHaveAccessibleName("Unread conversation: Beta");
  expect((await channelUnread(page, "alpha")).observedCount).toBe(
    before.observedCount,
  );
  await card.hover();
  await page.mouse.wheel(-120, 0);
  await expect(
    page.getByText("Review complete", { exact: true }),
  ).toBeVisible();
  expect((await channelUnread(page, "beta")).observedCount).toBe(0);
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(card).toHaveAccessibleName("Unread conversation: Alpha");
  await card.hover();
  await page.mouse.wheel(0, 120);
  await expect(card).toHaveAccessibleName("Unread conversation: Alpha");
});
