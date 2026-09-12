import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ pluginFixtures: true, exactMessages: true });
const detail = (page) =>
  page.getByRole("region", { name: "Message detail", exact: true });
const target = (app, id = app.exact.target.id) => ({
  version: 1,
  kind: "conversation",
  channelId: "alpha",
  messageId: id,
  scope: {
    viewer: app.viewer,
    communityOrigin: "https://primary.example",
  },
  threadRootId: "f".repeat(64),
});
const status = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot().status);
async function openTarget(page, value) {
  return page.evaluate((value) => window.fixtureNavigation.open(value), value);
}

test("old root and reply beyond the first thread page open exactly; reclick and Back reveal again", async ({
  page,
  app,
}) => {
  await open(page, app);
  const initialHeadQueries = app.report.queries.filter(
    (q) => q.filter.top_level,
  ).length;
  // This navigation fixture deliberately registers a catch-all panel first.
  // Disable it before exercising the actual Profiles provider.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Notes fixture", exact: true })
    .click();
  for (const [mode, id] of [
    ["cold root", app.exact.root.id],
    ["cold reply", app.exact.target.id],
    ["warm reply", app.exact.target.id],
  ]) {
    const start = performance.now();
    expect(await openTarget(page, target(app, id))).toEqual({
      status: "opened",
    });
    app.report.measurements.push({
      mode,
      clickToOpenedMs: performance.now() - start,
    });
    const row = detail(page).locator(`[data-message-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
    expect(await status(page)).toBe("opened");
    if (id === app.exact.target.id) {
      await expect(row).toContainText("Exact reply edited");
      await expect(
        row.locator("strong").filter({ hasText: "Exact reply edited" }),
      ).toHaveText("Exact reply edited");
      await expect(
        row.getByRole("button", {
          name: "View Alice Fixture profile",
          exact: true,
        }),
      ).toHaveCount(0); // Edited-body names cannot inherit original signed recipients.
      await expect(
        page.getByText("Message detail · Selected message only."),
      ).toBeVisible();
      expect(await detail(page).locator("[data-message-id]").count()).toBe(1);
    }
  }
  expect(app.report.queries.filter((q) => q.filter.top_level).length).toBe(
    initialHeadQueries,
  );
  expect(app.report.queries.filter((q) => q.filter.depth_limit)).toHaveLength(
    0,
  );
  expect(app.report.queries.filter((q) => q.filter.until)).toHaveLength(0);
  // Use an unedited reply to exercise exact mention/profile identity plumbing.
  expect(
    await openTarget(page, target(app, app.exact.replies.at(-2).id)),
  ).toEqual({ status: "opened" });
  const mention = detail(page).getByRole("button", {
    name: "View Alice Fixture profile",
    exact: true,
  });
  await mention.click();
  await expect(
    page.getByRole("region", { name: "Profile details" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close channel panel", exact: true })
    .click();
  await expect(mention).toBeFocused();
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await page.getByRole("button", { name: "Open channel", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(
    detail(page).locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toBeFocused();
  await expect.poll(() => status(page)).toBe("opened");
});

test("unknown target fails without channel-head success and retries in the same visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  expect(await openTarget(page, target(app, "e".repeat(64)))).toEqual({
    status: "failed",
    reason: "not-found",
  });
  await expect(
    page.getByRole("heading", { name: "This destination couldn’t open" }),
  ).toBeVisible();
  const visit = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry.id,
  );
  await page
    .getByRole("button", { name: "Retry navigation", exact: true })
    .click();
  await expect.poll(() => status(page)).toBe("failed");
  expect(
    await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
  ).toBe(visit);
  await expect(page.locator("[data-message-id]")).toHaveCount(0);
});

test("superseding a held exact read cancels it; a late response cannot steal focus or complete the next visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  let release;
  let intercepted;
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters?.some((filter) => filter.ids?.includes(app.exact.target.id)))
      return route.continue();
    intercepted();
    await held;
    await route.fulfill({ json: [app.exact.target] }).catch(() => {});
  });
  await page.evaluate((value) => {
    window.exactResult = window.fixtureNavigation.open(value);
  }, target(app));
  await seen;
  expect(await status(page)).toBe("opening");
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  expect(await page.evaluate(() => window.exactResult)).toEqual({
    status: "superseded",
  });
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.focus();
  release();
  await expect(composer).toBeFocused();
  await expect(detail(page)).toHaveCount(0);
  await expect.poll(() => status(page)).toBe("opened");
});

test("same-scope replacement withdraws a held old session and reopens the exact row", async ({
  page,
  app,
}) => {
  await open(page, app);
  let release;
  let intercepted;
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      !first ||
      !filters?.some((filter) => filter.ids?.includes(app.exact.target.id))
    )
      return route.continue();
    first = false;
    intercepted();
    await held;
    await route.fulfill({ json: [app.exact.target] }).catch(() => {});
  });
  await page.evaluate((value) => {
    window.exactResult = window.fixtureNavigation.open(value);
  }, target(app));
  await seen;
  const generation = await page.evaluate(() => {
    const generation = window.fixtureRelay.snapshot().generation;
    window.fixtureRelay.disconnect();
    return generation;
  });
  await expect(detail(page)).toHaveCount(0);
  await page.evaluate(() => window.fixtureRelay.retry());
  release();
  await expect(
    detail(page).locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.fixtureRelay.snapshot().generation),
  ).toBeGreaterThan(generation);
  expect(await page.evaluate(() => window.exactResult)).toEqual({
    status: "opened",
  });
});

test("post-success membership loss removes detail and live updates do not snap it back to the target", async ({
  page,
  app,
}) => {
  await open(page, app);
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  const region = detail(page);
  const channelButton = page.getByRole("button", {
    name: "Open channel",
    exact: true,
  });
  await channelButton.focus();
  const before = await region.evaluate((element) => element.scrollTop);
  app.edit(
    "primary",
    "alpha",
    { ...app.exact.target, created_at: app.exact.target.created_at + 10 },
    "Live edited exact reply",
  );
  await expect(region).toContainText("Live edited exact reply");
  await expect(channelButton).toBeFocused();
  expect(await region.evaluate((element) => element.scrollTop)).toBe(before);
  app.omitChannel("alpha");
  await page.getByLabel("Conversation options", { exact: true }).click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  await expect(region).toHaveCount(0);
  await expect(
    page.locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toHaveCount(0);
});

const readingTest = test.extend({ tallMessages: true });
readingTest(
  "exact detail leaves the ordinary channel reading anchor unchanged",
  async ({ page, app }) => {
    const { settle, anchor, expectAnchor } = await import("./timeline.mjs");
    await open(page, app);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    await page.mouse.wheel(0, -650);
    await settle(page);
    const reading = await anchor(page);
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    await page
      .getByRole("button", { name: "Open channel", exact: true })
      .click();
    await expect(history).toBeVisible();
    await settle(page);
    await expectAnchor(page, reading);
  },
);

const readTest = test.extend({ productionBroker: true, readState: true });
readTest(
  "exact reveal uses ordinary dwell rather than marking read at open",
  async ({ page, app }) => {
    await open(page, app);
    await page.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.ensure(),
    );
    const before = app.report.readPublications.length;
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    expect(app.report.readPublications.length).toBe(before);
    await expect
      .poll(() => app.report.readPublications.length)
      .toBeGreaterThan(before);
  },
);
