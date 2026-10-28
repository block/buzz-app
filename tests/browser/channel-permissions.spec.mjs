import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "guest",
  historyCounts: { alpha: 1, beta: 1 },
});

// The real broker -> signed roster -> sidebar -> conversation wiring and
// keyboard menu handoff are browser boundaries; role matrices stay in Vitest.
test("a joined guest can read and leave without receiving a composer or Join prompt", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.getByRole("button", {
    name: "Lifecycle channel",
    exact: true,
  });
  await row.click();
  await expect(
    page.getByRole("region", { name: "Read-only channel" }),
  ).toHaveText("You have read-only access to this channel.");
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Join", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Channel history" }),
  ).toBeVisible();
  await expect(
    page.getByText("Start the conversation below.", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Channel actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Leave channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Channel actions", exact: true }),
  ).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toEqual([]);
  expect(app.report.unexpected).toEqual([]);
});
