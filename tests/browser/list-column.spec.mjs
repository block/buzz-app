import { test, expect } from "./fixture.mjs";

// Browser contract for the shell's three columns: real routing and history
// keep one list beside the reader, and Activity is Team's list on All.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("Activity lands on Team's list, and its rows open in the reader beside it", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const view = (name) => rail.locator(`[data-rail-team-view="${name}"]`);
  const list = page.locator("[data-activity-sidebar]");
  const rows = list.locator("[data-activity-row]");
  const events = list.locator("[data-activity-event]");

  // Landing: the Activity row is current, the list is on All, nothing is open.
  await expect(view("all")).toHaveAttribute("aria-current", /.+/);
  await expect(page.getByText("No conversation selected")).toBeVisible();
  await expect(rows.first()).toBeVisible();
  await expect(events.first()).toBeVisible();
  // One mixed list: a DM, thread replies and a channel together.
  const dm = rows.filter({ hasText: "Inbox DM fixture reply" });
  await expect(dm).toHaveCount(1);
  expect(await events.count()).toBeGreaterThan(1);
  await expect(list.locator('[data-activity-row="beta"]')).toHaveCount(1);
  // A thread reply is listed once, not again as its channel's row.
  const shown = await list
    .locator("[data-activity-row], [data-activity-event]")
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => node.dataset.activityRow ?? node.dataset.activityEvent,
      ),
    );
  expect(new Set(shown).size).toBe(shown.length);

  // A thread row opens its thread in the reader; the list stays in place.
  const listBox = await list.boundingBox();
  await events.first().locator("[data-conversation-row]").click();
  await expect(
    page.locator('section[data-channel-timeline="alpha"]'),
  ).toBeVisible();
  await expect(list).toBeVisible();
  expect((await list.boundingBox()).x).toBeCloseTo(listBox.x, 0);
  expect((await list.boundingBox()).width).toBeCloseTo(listBox.width, 0);
  await expect(page.getByText("No conversation selected")).toHaveCount(0);

  // A DM row opens the DM in the same reader.
  await dm.locator("[data-conversation-row]").click();
  await expect(
    page.getByRole("textbox", { name: /Message/ }).first(),
  ).toBeVisible();
  await expect(
    page.locator('section[data-channel-timeline="alpha"]'),
  ).toHaveCount(0);

  // The rail's other views narrow the same list.
  await view("threads").click();
  await expect(rows).toHaveCount(0);
  await expect(events.first()).toBeVisible();
  await view("dms").click();
  await expect(events).toHaveCount(0);
  await expect(dm).toHaveCount(1);

  // From narrows by sender and is remembered with the list's other choices.
  await view("all").click();
  await expect(events.first()).toBeVisible();
  const total = await list
    .locator("[data-activity-row], [data-activity-event]")
    .count();
  const filters = page.getByRole("button", {
    name: "Filter and sort conversations",
    exact: true,
  });
  await filters.click();
  await page
    .getByRole("menuitemradio", { name: "Agents", exact: true })
    .click();
  await expect
    .poll(() =>
      list.locator("[data-activity-row], [data-activity-event]").count(),
    )
    .toBeLessThan(total);
  await filters.click();
  await page
    .getByRole("menuitemradio", { name: "Anyone", exact: true })
    .click();
  await expect
    .poll(() =>
      list.locator("[data-activity-row], [data-activity-event]").count(),
    )
    .toBe(total);

  // Activity is its own visit: Back reopens the conversation, Forward returns.
  await expect(page.getByText("No conversation selected")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("No conversation selected")).toHaveCount(0);
  await expect(list).toBeVisible();
  await page.goForward();
  await expect(page.getByText("No conversation selected")).toBeVisible();
  await expect(list).toBeVisible();
});

test("an Activity link's filters apply to Team's list", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const list = page.locator("[data-activity-sidebar]");
  await expect(list.locator("[data-activity-row]").first()).toBeVisible();
  // The shortcut opens Activity with Mentions selected.
  await page.keyboard.press("ControlOrMeta+Shift+M");
  await expect(
    page
      .getByRole("navigation", { name: "Apps", exact: true })
      .locator('[data-rail-team-view="mentions"]'),
  ).toHaveAttribute("aria-current", /.+/);
  await expect(list.locator("[data-activity-row]")).toHaveCount(0);
  await expect(list.locator("[data-activity-event]").first()).toBeVisible();
});
