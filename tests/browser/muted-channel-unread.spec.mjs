import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { holdReadingFocus } from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  savedSidebar: true,
  pluginFixtures: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// Real preference confirmation, live relay delivery and sidebar composition.
test("confirmed mute quiets ordinary channel unread without marking messages read", async ({
  page,
  app,
}, testInfo) => {
  // The next signed fixture event must be newer than the explicit read cutoff.
  const last = app.histories.get("primary/beta").at(-1);
  await page.clock.setFixedTime(new Date(last.created_at * 1000));
  await holdReadingFocus(page);
  await open(page, app);
  const beta = page.locator('button[data-channel-id="beta"]');
  const row = beta.locator("xpath=ancestor::*[@data-channel-sidebar-row]");
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  const actions = async () => {
    await beta.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
  };
  await actions();
  await menu
    .getByRole("menuitem", { name: "Mark as read", exact: true })
    .click();
  await expect(beta.locator("[data-channel-unread]")).toHaveCount(0);
  await actions();
  await menu.getByRole("menuitem", { name: "Mute", exact: true }).click();
  await expect
    .poll(() => app.report.sidebarPublications?.at(-1))
    .toMatchObject({
      coordinate: "channel-mutes",
      blob: { channels: { beta: { muted: true } } },
    });
  await actions();
  await expect(
    menu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  const event = app.append(
    "primary",
    "beta",
    "Ordinary message in muted channel",
    true,
    false,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .unread,
        event.id,
      ),
    )
    .toBe(true);
  await expect(row).not.toHaveAttribute("data-ordinary", "true");
  await expect(beta.locator("[data-channel-unread]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("muted-unread.png") });
  await actions();
  await menu.getByRole("menuitem", { name: "Unmute", exact: true }).click();
  await expect(row).toHaveAttribute("data-ordinary", "true");
  await expect(beta.locator("[data-channel-unread]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("unmuted-unread.png") });
});
