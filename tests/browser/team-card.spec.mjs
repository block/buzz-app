import { test, expect } from "./fixture.mjs";
import { showRail } from "./rail-helpers.mjs";
test.use({
  productionBroker: true,
  enabledPlugins: ["buzz.drafts-and-sent"],
  readState: true,
  inboxDm: true,
  historyCounts: { alpha: 3, beta: 2 },
});

// Team keeps view shortcuts above recent conversations; list rows still drag
// onto the cards beside it.
test("Team card opens its views and list rows drag onto sidebar cards", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 950 });
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const card = rail.locator('[data-rail-section="team"]');
  for (const name of ["Activity", "Threads", "DMs", "Mentions", "Channels"])
    await expect(
      card.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  const recent = card.getByRole("list", { name: "Recent conversations" });
  await expect(recent).toBeVisible();
  await expect(recent.locator('[data-rail-row="channel:alpha"]')).toBeVisible();
  const icons = card.locator("[data-rail-team-icons]");
  await expect(icons).toBeVisible();
  await expect(icons.getByRole("button")).toHaveCount(6);
  await page
    .getByRole("separator", { name: "Resize app sidebar" })
    .press("Home");
  // The minimum sidebar width must fit all Team shortcuts in one row.
  await expect
    .poll(() =>
      icons
        .getByRole("button")
        .evaluateAll(
          (buttons) =>
            new Set(
              buttons.map((button) =>
                Math.round(button.getBoundingClientRect().top),
              ),
            ).size,
        ),
    )
    .toBe(1);
  await expect(icons.getByRole("button").last()).toHaveAttribute(
    "data-rail-team-view",
    "buzz.drafts-and-sent/drafts-sent",
  );
  await page.screenshot({ path: testInfo.outputPath("team-card-recents.png") });

  const channels = card.locator('[data-rail-team-view="channels"]');
  await channels.click();
  const index = page.getByRole("region", { name: "Team", exact: true });
  const alpha = index.locator(
    '[data-activity-row="alpha"] [data-conversation-row]',
  );
  await expect(alpha).toBeVisible();
  await expect(channels).toHaveAttribute("aria-current", "page");
  await expect(index.getByRole("tab", { name: "Channels" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Nothing is selected: the reader says so instead of starting a message.
  await expect(
    page.getByRole("heading", { name: "No conversation selected" }),
  ).toBeVisible();
  await expect(page.getByText("New message", { exact: true })).toHaveCount(0);
  // A view with nothing in it says so.
  await card.locator('[data-rail-team-view="mentions"]').click();
  await expect(
    index.getByRole("heading", { name: "No mentions yet" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("team-empty.png") });
  const dms = card.locator('[data-rail-team-view="dms"]');
  await dms.click();
  await expect(alpha).toHaveCount(0);
  // The shortcut's context menu changes only its own view. Keyboard users
  // reach the same menu without navigating away from the selected list.
  const dmCount = dms.locator("xpath=..").getByRole("img");
  await expect(dmCount).toHaveAccessibleName("1 unread conversation");
  await dms.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Mark as read", exact: true })
    .click();
  await expect(dmCount).toHaveCount(0);
  await dms.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Mark as unread", exact: true })
    .click();
  await expect(dmCount).toHaveAccessibleName("1 unread conversation");
  await index.locator("[data-activity-row] [data-conversation-row]").click();
  await expect(dmCount).toHaveCount(0);
  await channels.click();
  await expect(alpha).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("team-card.png") });

  // Drop the list's row on the Pins card.
  const pins = rail.locator('[data-rail-section="pins"]');
  const from = await alpha.boundingBox();
  const to = await pins.boundingBox();
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 12,
  });
  await expect(pins).toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();
  await expect(pins.locator('[data-rail-row="channel:alpha"]')).toBeVisible();

  // All shortcuts stay reachable in a narrow drawer with enlarged text.
  // Geometry and native keyboard activation require a real browser.
  for (const mode of ["light", "dark"]) {
    for (const width of [1920, 480]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        ({ mode, width }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.fontSize = width === 480 ? "200%" : "";
        },
        { mode, width },
      );
      await showRail(page);
      await card.scrollIntoViewIfNeeded();
      for (const control of await icons.getByRole("button").all())
        await expect(control).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`team-${mode}-${width}.png`),
      });
    }
  }
  await channels.focus();
  await page.keyboard.press("Enter");
  await expect(index.getByRole("tab", { name: "Channels" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
