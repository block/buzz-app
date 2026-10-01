import { test, expect } from "./fixture.mjs";
import { openPage, selectSettingsSection } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

test.use({
  productionBroker: true,
  developmentReact: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// The production header, portal, management pane and persistent sidebar dialog
// share real browser focus/geometry. Permission permutations stay in Vitest.
test("header actions use the full-size menu and retain pane/dialog focus owners", async ({
  page,
  app,
  browserName,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await page.goto(app.origin);
  await openPage(page, "Settings");
  await selectSettingsSection(page, "Plugins");
  const templatesEnabled = page.getByRole("switch", {
    name: "Enable Templates & teams",
    exact: true,
  });
  await templatesEnabled.check();
  await openPage(page, "Messages");
  await page
    .locator('button[data-channel-id="11111111-1111-4111-8111-111111111111"]')
    .click();
  const trigger = page.getByRole("button", {
    name: "Channel actions",
    exact: true,
  });
  const menu = page.getByRole("menu", { name: "Channel actions", exact: true });
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(menu).toHaveAttribute("data-size", "default");
  await expect(menu.getByRole("menuitem").first()).toHaveText(
    "View channel details",
  );
  await expect(
    menu.getByRole("menuitem", { name: "View channel details", exact: true }),
  ).toBeFocused();
  await expect(
    menu.getByRole("menuitem", { name: "Edit details", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Leave channel", exact: true }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toHaveAttribute("data-tone", "danger");
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await menu.screenshot({
    path: testInfo.outputPath("channel-header-menu.png"),
  });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu).toBeVisible();
  // Click the real outside-dismiss layer, not a covered underlying control.
  await page.mouse.click(4, 4);
  await expect(menu).toHaveCount(0);
  await trigger.click();
  for (const label of [
    "View channel details",
    "View canvas",
    "Edit details",
    "Save as template…",
    "New session",
    "Archive channel",
    "Delete channel",
  ]) {
    const item = menu.getByRole("menuitem", { name: label, exact: true });
    await expect(item).toBeEnabled();
    const box = await item.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 5,
    });
    if (browserName === "webkit") {
      // Playwright WebKit reports zero movementX/Y even when client coordinates
      // change. Base UI intentionally ignores those events (stationary scrolling).
      // Supply the missing delta to exercise the real handler, not a CSS/focus shim.
      await item.dispatchEvent("mousemove", { movementX: 1, movementY: 1 });
    }
    await expect(item).toHaveAttribute("data-highlighted", "");
    await expect(menu.locator("[data-highlighted]")).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await openChannelDetails(page);
  await expect(settings).toBeVisible();
  await openChannelDetails(page);
  await expect(settings).toBeVisible();
  await expect(
    page
      .locator("[data-panel-workspace]")
      .getByRole("tab", { name: "Channel settings", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu
    .getByRole("menuitem", { name: "Edit details", exact: true })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Edit channel details",
    exact: true,
  });
  await expect(edit).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(
    edit.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeFocused();
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu
    .getByRole("menuitem", { name: "View canvas", exact: true })
    .click();
  const canvas = page.getByRole("dialog", {
    name: "Channel Canvas",
    exact: true,
  });
  await expect(canvas).toBeVisible();
  await expect(
    canvas.getByRole("button", { name: "Close Canvas", exact: true }),
  ).toBeEnabled();
  await expect(
    canvas.getByRole("textbox", { name: "Canvas Markdown", exact: true }),
  ).toBeEnabled();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu
    .getByRole("menuitem", { name: "Save as template…", exact: true })
    .click();
  const template = page.getByRole("dialog", {
    name: "Channel template",
    exact: true,
  });
  await expect(template).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(template).toHaveCount(0);
  await expect(trigger).toBeFocused();
  for (const label of ["Archive channel", "Delete channel"]) {
    await trigger.click();
    await menu.getByRole("menuitem", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: `${label}: Lifecycle channel`,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(menu).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel", exact: true }),
  ).toBeVisible();
  await expect(menu).toBeInViewport({ ratio: 1 });
  await menu.screenshot({
    path: testInfo.outputPath("channel-header-menu-narrow.png"),
  });
  await page.keyboard.press("Escape");
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  expect(app.report.unexpected).toEqual([]);
});

// Browser seam: sidebar-owned actions render under the header portal, move rows
// without stealing header focus, and hand modal/session focus to the existing owners.
test.describe("sidebar actions in the header", () => {
  test.use({ channelLifecycle: false, savedSidebar: true, readState: true });
  test("shares move, mute, read and session actions without transferring focus to the sidebar", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page.locator('button[data-channel-id="beta"]').click();
    const trigger = page.getByRole("button", {
      name: "Channel actions",
      exact: true,
    });
    const menu = page.getByRole("menu", {
      name: "Channel actions",
      exact: true,
    });
    const openMove = async () => {
      await trigger.click();
      const move = menu.getByRole("menuitem", {
        name: "Move channel",
        exact: true,
      });
      await move.focus();
      await page.keyboard.press("ArrowRight");
      return page.getByRole("menu", { name: "Move channel", exact: true });
    };
    let move = await openMove();
    await expect(move).toHaveAttribute("data-size", "default");
    await expect(
      move.getByRole("menuitemradio", { name: "Work", exact: true }),
    ).toBeChecked();
    await move
      .getByRole("menuitem", { name: "Create new…", exact: true })
      .click();
    const create = page.getByRole("dialog", {
      name: "Create new section",
      exact: true,
    });
    await expect(
      create.getByRole("textbox", { name: "Section name" }),
    ).toBeFocused();
    await expect(menu).toHaveCount(0);
    await create.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
    move = await openMove();
    const saved = page.waitForResponse("**/sidebar-star");
    await move
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await saved;
    await expect(menu).toHaveCount(0);
    await expect(
      page.locator(
        '[data-sidebar-section="starred"] button[data-channel-id="beta"]',
      ),
    ).toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    const muted = page.waitForResponse("**/sidebar-mute");
    await menu.getByRole("menuitem", { name: "Mute", exact: true }).click();
    await muted;
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(
      menu.getByRole("menuitem", { name: "Unmute", exact: true }),
    ).toBeVisible();
    await menu
      .getByRole("menuitem", { name: /^Mark as (Read|Unread)$/ })
      .click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu
      .getByRole("menuitem", { name: "New session", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message this session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message this session", exact: true }),
    ).toBeFocused();
    expect(app.report.unexpected).toEqual([]);
  });
});
