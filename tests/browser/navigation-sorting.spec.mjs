import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true, sortingSidebar: true });
// Native details/menu nesting, submenu focus/viewport placement and row reorder
// through the built app + real broker are browser contracts. Matrices live below.
test("section sort applies immediately, rolls back on failure, and persists retry independently", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const channels = sidebar.locator('[data-sidebar-section="channels"]');
  const work = sidebar.locator('[data-sidebar-section="group:work"]');
  const trigger = channels.getByRole("button", {
    name: "More actions for Channels",
  });
  const rows = channels.locator("[data-channel-id]");
  const order = () =>
    rows.evaluateAll((elements) => elements.map((el) => el.dataset.channelId));
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(rows.first()).toBeVisible();
  const alphaOrder = await order();
  expect(alphaOrder.length).toBeGreaterThan(2);
  const activity = app.report.queries.filter((q) =>
    q.filter.kinds?.includes(45003),
  );
  expect(activity).toEqual([]);
  async function openSort() {
    await trigger.click();
    await expect(channels).toHaveAttribute("open", "");
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("menu", { name: "Sort", exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-alpha.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  await openSort();
  const menu = page.getByRole("menu", { name: "Sort", exact: true });
  await expect(
    menu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-sort", async (route) => {
    started();
    await held;
    app.report.sidebarSortFailures ??= [];
    app.report.sidebarSortFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "sort save failed" }),
    });
  });
  try {
    await menu.getByRole("menuitemradio", { name: "Recent" }).click();
    await requestStarted;
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    await openSort();
    await expect(
      menu.getByRole("menuitemradio", { name: "A–Z" }),
    ).toBeEnabled();
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect.poll(order).not.toEqual(alphaOrder);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } finally {
    release();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the sort order for Channels" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect.poll(order).toEqual(alphaOrder);
  await page.unroute("**/sidebar-sort");
  // Error ownership is session-scoped, not coupled to the dismissed menu/page.
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect(error).toBeVisible();
  async function confirmedSort(action) {
    const response = page.waitForResponse("**/sidebar-sort");
    await action();
    expect((await response).ok()).toBe(true);
    await (await response).finished();
  }
  await confirmedSort(() =>
    error.getByRole("button", { name: "Retry sort" }).click(),
  );
  await expect(error).toHaveCount(0);
  await expect.poll(order).not.toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-sort",
    blob: { groups: { channels: "recent" } },
  });
  const recentOrder = await order();
  await openSort();
  await expect(
    menu.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-menu.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  const box = await menu.boundingBox(),
    viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).not.toBeVisible();
  await work.getByRole("button", { name: "More actions for Work" }).click();
  await page
    .getByRole("menu", { name: "More actions for Work", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const workMenu = page.getByRole("menu", { name: "Sort", exact: true });
  await expect(
    workMenu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  await confirmedSort(() =>
    workMenu.getByRole("menuitemradio", { name: "Recent" }).click(),
  );
  await expect(workMenu).not.toBeVisible();
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    channels: "recent",
    "section:work": "recent",
  });
  await expect.poll(order).toEqual(recentOrder);
  await openSort();
  await confirmedSort(() =>
    menu.getByRole("menuitemradio", { name: "A–Z" }).click(),
  );
  await expect(menu).not.toBeVisible();
  await expect.poll(order).toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    "section:work": "recent",
  });
  expect(app.report.unexpected).toEqual([]);
});

// Cold-start paint is a composition contract: real saved sort, activity response,
// and independent conversation opening. Timer/order permutations live in RTL.
test.describe("cold sidebar presentation", () => {
  test.use({ initialSidebarSort: { channels: "recent" } });
  test("reveals saved placement and Recent together without blocking the conversation", async ({
    page,
    app,
  }, testInfo) => {
    let releasePreferences, releaseActivity;
    const preferences = new Promise((resolve) => {
      releasePreferences = resolve;
    });
    const activity = new Promise((resolve) => {
      releaseActivity = resolve;
    });
    let preferencesStarted, activityStarted;
    const decoding = new Promise((resolve) => {
      preferencesStarted = resolve;
    });
    const ordering = new Promise((resolve) => {
      activityStarted = resolve;
    });
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.addInitScript(() =>
      localStorage.setItem("buzz-appearance.v1", "dark"),
    );
    await page.route("**/sidebar-preferences", async (route) => {
      const response = await route.fetch();
      preferencesStarted();
      await preferences;
      await route.fulfill({ response });
    });
    await page.route("**/channel-activity", async (route) => {
      const response = await route.fetch();
      activityStarted();
      await activity;
      await route.fulfill({ response });
    });
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    try {
      await page.goto(app.origin);
      await page
        .getByRole("button", { name: "Messages", exact: true })
        .first()
        .click();
      await decoding;
      await expect(sidebar.getByRole("status")).toHaveText(
        "Loading your sidebar…",
      );
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("sidebar-cold-loading.png"),
        clip: { x: 0, y: 0, width: 540, height: 460 },
      });
      releasePreferences();
      await ordering;
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      releaseActivity();
      const rows = sidebar.locator(
        '[data-sidebar-section="channels"] [data-channel-id]',
      );
      await expect(rows.first()).toBeVisible();
      expect(
        await rows.evaluateAll((elements) =>
          elements.slice(0, 3).map((el) => el.dataset.channelId),
        ),
      ).toEqual(["willow", "maple", "cedar"]);
      await expect(
        sidebar.locator(
          '[data-sidebar-section="group:work"] [data-channel-id="beta"]',
        ),
      ).toBeVisible();
      await expect(sidebar.getByRole("status")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("sidebar-cold-revealed.png"),
        clip: { x: 0, y: 0, width: 540, height: 460 },
      });
    } finally {
      releasePreferences();
      releaseActivity();
      // Remove the gates before resumed timers can start a fresh intercepted read.
      await page.unroute("**/sidebar-preferences");
      await page.unroute("**/channel-activity");
      await page.clock.resume();
    }
  });
});

// Different schema, not another ordering matrix: the new group ID is absent
// from legacy sections. The host decoder and displayed-group write must agree.
test.describe("personal-group sorting", () => {
  test.use({ personalSidebar: true });
  test("persists a displayed personal group without rewriting its recipe", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "Messages", exact: true })
      .first()
      .click();
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const group = sidebar.locator(
      '[data-sidebar-section="group:personal-work"]',
    );
    await expect(
      group.getByText("Personal work", { exact: true }),
    ).toBeVisible();
    await group
      .getByRole("button", { name: "More actions for Personal work" })
      .click();
    await page
      .getByRole("menu", {
        name: "More actions for Personal work",
        exact: true,
      })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    const menu = page.getByRole("menu", { name: "Sort", exact: true });
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/sidebar-sort") && response.ok(),
    );
    await menu.getByRole("menuitemradio", { name: "Recent" }).click();
    await (await saved).finished();
    await expect(menu).not.toBeVisible();
    expect(app.report.sidebarPublications).toHaveLength(1);
    expect(app.report.sidebarPublications[0]).toMatchObject({
      coordinate: "channel-sort",
      blob: { groups: { "section:personal-work": "recent" } },
    });
    await page.reload();
    await expect(
      group.getByText("Personal work", { exact: true }),
    ).toBeVisible();
    await group
      .getByRole("button", { name: "More actions for Personal work" })
      .click();
    await page
      .getByRole("menu", {
        name: "More actions for Personal work",
        exact: true,
      })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(app.report.sidebarPublications).toHaveLength(1);
    expect(app.report.unexpected).toEqual([]);
  });
});
