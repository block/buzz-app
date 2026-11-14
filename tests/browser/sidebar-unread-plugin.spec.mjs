import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { holdReadingFocus } from "./reading.mjs";
import {
  openSettings,
  closeSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";

// Proves the installed plugin reaches the shell's real scroll geometry and
// that revealing an eligible DM focuses it without selecting or reading it.
// Eligibility permutations and lifecycle transitions live in Vitest.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  readState: true,
  largeSidebar: true,
  sidebarUnread: true,
  historyCounts: { alpha: 2, beta: 2 },
});

test("mentions-and-DMs plugin filters the real sidebar and restores it on disable", async ({
  page,
  app,
}, info) => {
  await holdReadingFocus(page);
  await open(page, app);
  const list = page.getByRole("navigation", { name: "Subscribed channels" });
  const pill = page.locator('button[data-edge="above"]');
  const beta = list.locator('button[data-channel-id="beta"]');
  await expect(beta.locator("[data-channel-unread]")).toHaveCount(1);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      beta.evaluate(
        (element) =>
          element.getBoundingClientRect().bottom <=
          element.closest("nav").getBoundingClientRect().top,
      ),
    )
    .toBe(true);
  await expect(pill).toBeVisible();
  const baseline = Number((await pill.innerText()).match(/(\d+) unread/)[1]);
  const toggle = async (enabled) => {
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Mentions and DMs only", enabled);
    await closeSettings(page);
  };
  await toggle(true);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => Number((await pill.innerText()).match(/(\d+) unread/)[1]))
    .toBeLessThan(baseline);
  await expect(pill).toBeVisible();
  await pill.focus();
  await page.keyboard.press("Enter");
  await expect(
    list.locator('button[data-channel-type="dm"]:focus'),
  ).toHaveCount(1);
  await expect(list.locator('button[aria-current="page"]')).toHaveAttribute(
    "data-channel-id",
    "alpha",
  );
  await expect(
    list.locator('button[data-channel-type="dm"]:focus [data-channel-unread]'),
  ).toHaveCount(1);
  await expect(beta.locator("[data-channel-unread]")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("mentions-and-dms.png") });
  await toggle(false);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => Number((await pill.innerText()).match(/(\d+) unread/)[1]))
    .toBe(baseline);
});
