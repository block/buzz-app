import { test, expect } from "./fixture.mjs";
test.use({
  productionBroker: true,
  enabledPlugins: ["buzz.drafts-and-sent"],
  readState: true,
  inboxDm: true,
  historyCounts: { alpha: 3, beta: 2 },
});

// The Team card names Team's views instead of previewing conversations, and
// the open list's rows drag onto the cards beside it.
test("Team card opens its views and list rows drag onto sidebar cards", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 950 });
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const card = rail.locator('[data-rail-section="messages"]');
  for (const name of ["Activity", "Threads", "DMs", "Mentions", "Channels"])
    await expect(
      card.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await expect(
    card.getByRole("list", { name: "Recent conversations" }),
  ).toHaveCount(0);

  // Team starts as one row of icons. Its list control waits beside the card's
  // create action, clear of the icons, and shows the rows.
  const icons = card.locator("[data-rail-team-icons]");
  await expect(icons).toBeVisible();
  // Team's own page sits last, after its views.
  await expect(icons.getByRole("button")).toHaveCount(6);
  await expect(icons.getByRole("button").last()).toHaveAttribute(
    "data-rail-team-view",
    "buzz.drafts-and-sent/drafts-sent",
  );
  await page.screenshot({ path: testInfo.outputPath("team-icons.png") });
  await card.hover();
  const expand = card.locator("[data-rail-team-expand]");
  await expect(expand).toBeVisible();
  await expect(card.locator("[data-rail-card-actions]")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.screenshot({ path: testInfo.outputPath("team-icons-hover.png") });
  await expand.click();
  await expect(icons).toHaveCount(0);
  await expect(card.getByText("Channels", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("team-list.png") });
  await expand.click();
  await expect(icons).toBeVisible();

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
  // Opening the unread DM clears it from the card's count.
  const dmCount = dms.locator("xpath=..").getByRole("img");
  await expect(dmCount).toHaveText("1");
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
});
