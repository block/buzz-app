import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({ productionBroker: true });
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

test("automatic history starts before the top in a production broker session", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("button", { name: "Retry live updates", exact: true }),
  ).toHaveCount(0);
  await history(page).hover();
  for (let i = 0; i < 100 && !app.pending.length; i++) {
    await page.mouse.wheel(0, -450);
    await page.waitForTimeout(40);
    if (
      await history(page)
        .getByRole("button", { name: "Loading older…", exact: true })
        .count()
    )
      break;
  }
  await expect.poll(() => app.pending.length).toBe(1);
  const top = await history(page).evaluate((e) => e.scrollTop);
  app.report.measurements.push({ automaticRequestTop: top });
  expect(top).toBeGreaterThan(1000);
  app.pending.shift().release();
  await settle(page);
});

test("returning to the top continues history loading on wheel without a button", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("button", { name: "Retry live updates", exact: true }),
  ).toHaveCount(0);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  // Navigate away while a real cursor request is in flight, then return to the
  // saved top before releasing it; this must remain an ordinary scroll journey.
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  app.pending.shift().release();
  await settle(page);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  app.pending.shift().release();
});

test("saved top resumes automatic history on an upward gesture after remount", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("button", { name: "Retry live updates", exact: true }),
  ).toHaveCount(0);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  await expect.poll(() => history(page).evaluate((e) => e.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  // Remounting Channels captures the normal reading anchor in localStorage.
  // Reload gives a new session/finite head but preserves that user-owned anchor.
  await page.reload();
  app.pending.shift().release();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect(history(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry live updates", exact: true }),
  ).toHaveCount(0);
  await settle(page);
  await expect.poll(() => history(page).evaluate((e) => e.scrollTop)).toBe(0);
  expect(app.pending).toHaveLength(0);
  await history(page).hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => app.pending.length).toBe(1);
  app.pending.shift().release();
});

test("older-page quota errors require deliberate retry instead of more scrolling requests", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("button", { name: "Retry live updates", exact: true }),
  ).toHaveCount(0);
  app.relay.quotaNextOlder("alpha", 0);
  const cursors = () =>
    app.report.queries.filter(({ filter }) => filter.until !== undefined);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect(history(page).getByRole("alert")).toContainText("rate-limited");
  const count = cursors().length;
  const brokerCount = app.report.brokerRequests.filter((r) =>
    r.url.endsWith("/query"),
  ).length;
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -500);
  await settle(page);
  expect(cursors()).toHaveLength(count);
  expect(
    app.report.brokerRequests.filter((r) => r.url.endsWith("/query")),
  ).toHaveLength(brokerCount);
  await expect
    .poll(() => performance.now())
    .toBeGreaterThan(app.relay.rejected[0].until + 50);
  await history(page)
    .getByRole("button", { name: "Load older messages", exact: true })
    .click();
  await expect.poll(() => app.pending.length).toBe(1);
  expect(cursors()).toHaveLength(count + 1);
  app.pending.shift().release();
  await expect(history(page).getByRole("alert")).toHaveCount(0);
});
