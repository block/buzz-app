import { test, expect } from "./fixture.mjs";
const views = (page, name) =>
  page
    .getByRole("navigation", { name: "Pulse views" })
    .getByRole("button", { name, exact: true });
const rail = (page, name) =>
  page
    .getByRole("navigation", { name: "Pulse conversations" })
    .getByRole("button", { name, exact: true });
const hostBack = (page) =>
  page.getByRole("button", { name: "Go back", exact: true });

test("Pulse host and local Back traverse real view, search, channel and thread visits without losing drafts", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some((filter) => filter.ids || filter.depth_limit !== undefined)
    ) {
      const root = app.histories.get("primary/alpha").at(-1);
      return route.fulfill({
        json: filters.some((filter) => filter.ids?.includes(root.id))
          ? [root]
          : [],
      });
    }
    return route.continue();
  });
  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Pulse", exact: true })
    .click();
  await views(page, "For you").click();
  await rail(page, "Alpha").click();
  const alpha = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await alpha.fill("Alpha fixture draft");
  await rail(page, "Beta").click();
  await page
    .getByRole("textbox", { name: "Message #Beta", exact: true })
    .fill("Beta fixture draft");
  await page.getByRole("button", { name: "Back to Pulse" }).click();
  await expect(alpha).toHaveValue("Alpha fixture draft");
  await hostBack(page).click();
  await expect(views(page, "For you")).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Go forward", exact: true }).click();
  await expect(alpha).toHaveValue("Alpha fixture draft");
  await hostBack(page).click();
  await views(page, "Search").click();
  const search = page.getByRole("searchbox", {
    name: "Search recent Pulse activity",
  });
  await search.fill("message 639");
  const searchUrl = page.url();
  await page.getByRole("button", { name: "Open thread / reply" }).click();
  const reply = page.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await reply.fill("Thread fixture draft");
  await hostBack(page).click();
  await expect(search).toHaveValue("message 639");
  await expect(page).toHaveURL(searchUrl);
  await page.getByRole("button", { name: "Go forward", exact: true }).click();
  await expect(reply).toHaveValue("Thread fixture draft");
  // Reload retains the route, including the exact thread; browser Back does not push a loop.
  await page.reload();
  await expect(reply).toHaveValue("Thread fixture draft");
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(search).toHaveValue("message 639");
  await expect(page).toHaveURL(searchUrl);
  await hostBack(page).click();
  await expect(views(page, "For you")).toHaveAttribute("aria-current", "page");
});

test("Pulse feed and rail use the shared bounded intent heads before first open", async ({
  page,
  app,
}) => {
  const heads = (id) =>
    app.report.queries.filter(
      ({ filter }) =>
        filter.top_level &&
        filter["#h"]?.[0] === id &&
        filter.until === undefined,
    );
  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Pulse", exact: true })
    .click();
  await expect(page.getByRole("article")).toBeVisible();
  expect(heads("alpha")).toHaveLength(0);
  expect(heads("beta")).toHaveLength(0);
  const open = page.getByRole("button", { name: "Open conversation ↗" });
  const warmed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/query") &&
      response
        .request()
        .postDataJSON()
        ?.some((filter) => filter.top_level && filter["#h"]?.[0] === "alpha"),
  );
  await open.hover();
  await expect.poll(() => heads("alpha").length).toBe(1);
  // A completed intent head is reused by the authoritative channel window.
  await warmed;
  const before = performance.now();
  await open.click();
  await expect(
    page
      .getByRole("region", { name: "Channel message history" })
      .locator("[data-message-id]")
      .first(),
  ).toBeVisible();
  app.report.measurements.push({
    name: "Pulse intent-first-open",
    visibleUpperBoundMs: performance.now() - before,
  });
  expect(heads("alpha")).toHaveLength(1);
  const streams = app.report.streamConnections.length;
  await rail(page, "Beta").focus();
  await expect.poll(() => heads("beta").length).toBe(1);
  await rail(page, "Beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(heads("beta")).toHaveLength(1);
  await hostBack(page).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(heads("alpha")).toHaveLength(1);
  expect(app.report.streamConnections).toHaveLength(streams);
});

test("Pulse restores feed scroll and focus after host page traversal, and channel reading position after channel traversal", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 700, height: 420 });
  await page.goto(app.origin);
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  await pages.getByRole("button", { name: "Pulse", exact: true }).click();
  const open = page.getByRole("button", { name: "Open conversation ↗" });
  await expect(open).toBeVisible();
  const feed = page.locator('[class*="feed_"]').filter({ has: open });
  await open.focus();
  await feed.evaluate((el) => {
    el.scrollTop = 60;
  });
  await expect
    .poll(() => feed.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  const top = await feed.evaluate((el) => el.scrollTop);
  await pages.getByRole("button", { name: "Home", exact: true }).click();
  await hostBack(page).click();
  await expect(open).toBeFocused();
  await expect
    .poll(() => feed.evaluate((el, top) => Math.abs(el.scrollTop - top), top))
    .toBeLessThan(2);
  await page.setViewportSize({ width: 1440, height: 950 });
  await open.click();
  const { settle, anchor, expectAnchor } = await import("./timeline.mjs");
  await settle(page);
  const history = page.getByRole("region", { name: "Channel message history" });
  await history.evaluate((el) => {
    el.scrollTop -= 500;
  });
  await settle(page);
  const before = await anchor(page);
  await rail(page, "Beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await hostBack(page).click();
  await settle(page);
  await expectAnchor(page, before);
});

test.describe("nested thread visits", () => {
  test.use({ productionBroker: true, threadUnread: true, dmLabels: true });
  test("Pulse channel to thread to channel keeps reading position and separate drafts", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Pulse", exact: true })
      .click();
    await rail(page, "Alpha").click();
    const { settle, anchor, expectAnchor } = await import("./timeline.mjs");
    await settle(page);
    const channel = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await channel.fill("Channel draft before thread");
    const control = page.getByRole("button", { name: /^View thread:/ }).last();
    await control.scrollIntoViewIfNeeded();
    await settle(page);
    const before = await anchor(page);
    await control.click();
    const reply = page.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await reply.fill("Nested thread draft");
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(channel).toHaveValue("Channel draft before thread");
    await settle(page);
    await expectAnchor(page, before);
    await page.getByRole("button", { name: "Go forward", exact: true }).click();
    await expect(reply).toHaveValue("Nested thread draft");
  });
});
