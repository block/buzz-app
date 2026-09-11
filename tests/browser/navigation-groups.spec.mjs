import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true });

test("row menu moves and removes a channel through the confirmed saved-group writer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const work = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Work$/ }) });
  const channels = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();

  await work.getByLabel("Actions for Beta", { exact: true }).click();
  const menu = page.getByRole("menu", { name: "Group for Beta" });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: "Work" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitem", { name: "Remove from group" }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitemradio", { name: "Work" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Remove from group" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    channels.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveCount(0);
  expect(app.report.sidebarPublications).toHaveLength(1);
  expect(app.report.sidebarPublications[0].blob.assignments).toEqual({});

  await channels.getByLabel("Actions for Beta", { exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Work" }).click();
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(
    channels.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveCount(0);
  expect(app.report.sidebarPublications).toHaveLength(2);
  expect(app.report.sidebarPublications[1].blob.assignments).toEqual({
    beta: "work",
  });
  expect(app.report.unexpected).toEqual([]);
});

test.use({
  productionBroker: true,
  savedSidebar: true,
  largeSidebar: true,
  developmentReact: true,
});
test("Home → Messages keeps saved groups and scroll on every visible frame without re-decoding", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  await expect(sidebar.locator("summary", { hasText: /^Work$/ })).toBeVisible();
  await expect(
    sidebar.locator("summary", { hasText: /Starred$/ }),
  ).toBeVisible();
  const scroll = await sidebar.evaluate((element) => {
    element.scrollTop = 1000;
    return element.scrollTop;
  });
  expect(scroll).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await expect(sidebar).toHaveCount(0);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let decodes = 0;
  await page.route("**/sidebar-preferences", async (route) => {
    decodes++;
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    window.sidebarFrames = [];
    window.captureSidebar = true;
    const frame = () => {
      const list = document.querySelector(
        'nav[aria-label="Subscribed channels"]',
      );
      if (list)
        window.sidebarFrames.push({
          top: list.scrollTop,
          groups: Array.from(list.querySelectorAll("summary"), (el) =>
            el.textContent.replace("★", "").trim(),
          ),
        });
      if (window.captureSidebar) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  try {
    await page
      .getByRole("button", { name: "Messages", exact: true })
      .first()
      .click();
    await expect(sidebar).toBeVisible();
    await page.waitForTimeout(300); // Measure the held interval, not eventual success.
    const frames = await page.evaluate(() => {
      window.captureSidebar = false;
      return window.sidebarFrames;
    });
    expect(frames.length).toBeGreaterThan(3);
    expect(
      frames.filter(
        (frame) =>
          !frame.groups.includes("Work") ||
          !frame.groups.includes("Starred") ||
          Math.abs(frame.top - scroll) > 1,
      ),
      "No fallback grouping or top-of-list frame on warm return",
    ).toEqual([]);
    expect(
      decodes,
      "Remount must reuse the engine snapshot, not fetch/decode again",
    ).toBe(0);
  } finally {
    release();
    await page.unroute("**/sidebar-preferences");
  }
});
