import { test, expect } from "./fixture.mjs";
import {
  chooseViewOption,
  expectViewOption,
  openPage,
  closeMenus,
  openSortMenu,
} from "./navigation.mjs";

test.use({
  pluginFixtures: true,
  productionBroker: true,
  savedSidebar: true,
  largeSidebar: true,
  initialSidebarSort: { channels: "recent" },
  historyCounts: { alpha: 1, beta: 0 },
});

// Real scroll clamping, slot replacement and persisted Messages controls must
// agree through App routing; jsdom only proves the commit/lifetime ordering.
test("a replacement sidebar unmounts Messages and returning restores its view", async ({
  page,
  app,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 3,
        enabled: { "fixture.page-placement": true },
      }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const list = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect(
    list.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  const original = await list.elementHandle();
  await chooseViewOption(page, "Work", "A–Z");
  const work = page.locator('[data-sidebar-section="group:work"]');
  await work.locator("summary").click();
  await expect(work.locator("details").first()).not.toHaveAttribute("open");
  await expect
    .poll(() =>
      list.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 180,
      ),
    )
    .toBe(true);
  await list.evaluate(
    (element) =>
      new Promise((resolve) => {
        element.addEventListener("scroll", () => resolve(), { once: true });
        element.scrollTop = 180;
      }),
  );
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(180);
  await page.screenshot({
    path: info.outputPath("messages-before-replacement.png"),
  });
  await openPage(page, "Sidebar playground");
  await expect(
    page.getByRole("button", { name: "Fixture sidebar action" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-sidebar-slot="fixture.page-placement/sidebar"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-buzz-launch-pending="required"]'),
  ).toHaveCount(0);
  // The Messages owner saves the view on unmount.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) =>
            key.startsWith("buzz-view.v1:") &&
            key.includes("channel-sidebar") &&
            JSON.parse(value).scrollTop === 180,
        ),
      ),
    )
    .toBe(true);
  expect(await original.evaluate((element) => element.isConnected)).toBe(false);
  await expect(page.locator("[data-channel-id]")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("page-sidebar-replacement.png"),
  });
  // The retired rail was the way back; Messages is no longer a listed page.
  await openPage(page, "Messages");
  await expect(list).toBeVisible();
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(180);
  await expect(work.locator("details").first()).not.toHaveAttribute("open");
  await page.screenshot({ path: info.outputPath("messages-after-return.png") });
  const workOptions = await openSortMenu(page, "Work");
  await expectViewOption(workOptions, "A–Z");
  await closeMenus(page);
  await expect(workOptions).toHaveCount(0);
  const team = await openSortMenu(page, "Team");
  await expect(
    team.getByRole("menuitemradio", { name: "Recent", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});
