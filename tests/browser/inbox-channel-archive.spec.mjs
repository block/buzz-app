import { test, expect } from "./fixture.mjs";
import { channelRow, conversationList, openPage, rail } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
test.use({
  productionBroker: true,
  readState: true,
  channelLifecycle: true,
  inboxThreadWindow: true,
  channelIds: ["alpha", channel],
  historyCounts: { alpha: 1, [channel]: 0 },
});

// Real lifecycle publication, search routing and IndexedDB reload must agree
// with the shared Activity projection. Live selection permutations stay mounted.
test("excludes a channel-archived conversation across reload without clearing local unread", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const list = conversationList(page);
  const rows = list.locator("[data-activity-event]");
  await expect(rows).toHaveCount(1);
  await rows.locator("[data-conversation-row]").click();
  // A day's first row is wrapped by one that carries the day label.
  const root = page
    .locator(`[data-message-id="${app.inboxWindow.root.id}"]`)
    .last();
  await expect(root).toBeVisible();
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // Mark the channel unread on this device, then archive it from its row
  // without opening it, which would read it.
  await rail(page).locator('[data-rail-team-view="channels"]').click();
  const lifecycle = channelRow(page, channel);
  const unread = lifecycle.getByRole("img", { name: "Unread" });
  await lifecycle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await expect(unread).toBeVisible();
  await lifecycle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive channel" }).click();
  await page
    .getByRole("dialog", {
      name: "Archive channel: Lifecycle channel",
      exact: true,
    })
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Archive channel: Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await openPage(page, "Activity");
  await expect(channelRow(page, "alpha")).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(channelRow(page, channel)).toHaveCount(0);
  await expect(root).toHaveCount(0);
  await page.reload();
  await openPage(page, "Activity");
  await expect(channelRow(page, "alpha")).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(channelRow(page, channel)).toHaveCount(0);

  // Archive is not access loss. Restore through the actual search/settings path.
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  await search.getByRole("combobox").fill("Lifecycle channel");
  await search
    .getByRole("option", {
      name: "Lifecycle channel Archived channel · 1 member",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Archived channel", exact: true }),
  ).toHaveText("This channel is archived");
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(root).toBeVisible();
  await openChannelDetails(page);
  await page
    .getByRole("button", { name: "Unarchive channel", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "Unarchive channel: Lifecycle channel",
      exact: true,
    })
    .getByRole("button", { name: "Unarchive channel", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Unarchive channel: Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await openPage(page, "Activity");
  await expect(rows).toHaveCount(1);
  await rail(page).locator('[data-rail-team-view="channels"]').click();
  await expect(unread).toBeVisible();
  await expect(root).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.tags)).toEqual([
    [
      ["h", channel],
      ["archived", "true"],
    ],
    [
      ["h", channel],
      ["archived", "false"],
    ],
  ]);
});
