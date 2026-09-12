import { test, expect } from "./fixture.mjs";
import { anchor, expectAnchor, settle } from "./timeline.mjs";

test.use({ membershipActivity: true, productionBroker: true });

// Do not let the shared fixture's legacy WebKit exception mask timeline reflow
// errors. These journeys must preserve the reader without observer-loop errors.
test.afterEach(async ({ app }) => {
  expect(app.report.errors).toEqual([]);
});

test("Channels renders grouped history and live membership without turning activity into messages", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await page
    .getByLabel("Pages")
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  const feed = page.getByRole("region", { name: "Channel message history" });
  const groups = feed.locator("[data-membership-row]");
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toContainText(
    "Pinky added by you, along with Brain",
  );
  await expect(groups.locator("button")).toHaveCount(0);
  const centered = await groups.first().evaluate((row) => {
    const content = row.querySelector("p");
    const avatars = row.querySelector('[aria-hidden="true"]');
    const bounds = row.getBoundingClientRect();
    return Math.abs(
      (avatars.getBoundingClientRect().left +
        content.getBoundingClientRect().right) /
        2 -
        (bounds.left + bounds.right) / 2,
    );
  });
  expect(centered).toBeLessThan(2);
  expect(
    app.report.queries
      .filter(({ filter }) => filter.top_level)
      .every(({ filter }) => filter.kinds.includes(40099)),
  ).toBe(true);
  await groups
    .first()
    .screenshot({ path: testInfo.outputPath("grouped-members.png") });
  await testInfo.attach("grouped-members", {
    path: testInfo.outputPath("grouped-members.png"),
    contentType: "image/png",
  });
  // The real stream subscriber/filter/session must deliver additions and departures.
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  app.membership("member_left", 0, 0);
  app.membership("member_left", 1, 1);
  await expect(groups).toHaveCount(2);
  await expect(groups.last()).toContainText(
    "Pinky, along with Brain, left the channel",
  );
  app.membership("member_removed", 0);
  await expect(groups).toHaveCount(3);
  await expect(groups.last()).toContainText("Pinky was removed by you");
  app.membership("member_joined", 0, -1, true);
  // Place a genuine message after the forgery: seeing it proves the batch was processed.
  const after = app.append("primary", "alpha", "After membership activity");
  await expect(feed.locator(`[data-message-id="${after.id}"]`)).toBeVisible();
  await expect(groups).toHaveCount(3);
  // A normal message is a grouping barrier, never swallowed by an activity cohort.
  app.membership("member_joined", 0);
  await expect(groups).toHaveCount(4);
  await expect(groups.last()).toContainText("Pinky added by you");
  await expect(groups.last()).toBeVisible();
  // Wait for the scheduled bottom-follow before leaving; an overscan count is
  // not evidence that the newly appended activity has reached the viewport.
  await expect
    .poll(() =>
      feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(2);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(groups).toHaveCount(4);
  await expect(groups.last()).toBeVisible();
});

test("one keyboard scroll leaves bottom follow and live membership preserves the reader", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page
    .getByLabel("Pages")
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  const feed = page.getByRole("region", { name: "Channel message history" });
  const distance = () =>
    feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(distance).toBeLessThan(2);
  await feed.focus();
  await feed.evaluate((el) => {
    window.keyboardScrolls = [];
    el.addEventListener("scroll", () =>
      window.keyboardScrolls.push(el.scrollTop),
    );
  });
  await page.keyboard.press("PageUp");
  await expect.poll(distance).toBeGreaterThan(200);
  await settle(page);
  const saved = await anchor(page);
  expect(
    await page.evaluate(() => new Set(window.keyboardScrolls).size),
  ).toBeGreaterThan(1);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  app.membership("member_left", 0);
  const after = app.append(
    "primary",
    "alpha",
    "Activity while reading above bottom",
  );
  await expect(feed.locator(`[data-message-id="${after.id}"]`)).toBeAttached();
  await settle(page);
  await expectAnchor(page, saved);
  expect(await distance()).toBeGreaterThan(200);
});
