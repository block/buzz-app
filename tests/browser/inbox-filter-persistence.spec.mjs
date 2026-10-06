import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("Inbox restores Activity, Sender, and Filters after reopening", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const choose = async (control, name) => {
    await inbox.getByRole("combobox", { name: control, exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };

  await choose("Activity type", "Mentions");
  await choose("Sender", "Humans");
  await choose("Filters", "Unread only");
  await expect(
    inbox.getByRole("combobox", { name: "Activity type" }),
  ).toHaveText("Mentions");
  await expect(inbox.getByRole("combobox", { name: "Sender" })).toHaveText(
    "Humans",
  );
  await expect(inbox.getByRole("combobox", { name: "Filters" })).toHaveText(
    "Unread only",
  );

  await openPage(page, "Agents");
  await expect(inbox).toHaveCount(0);
  await openPage(page, "Inbox");
  const reopened = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(
    reopened.getByRole("combobox", { name: "Activity type" }),
  ).toHaveText("Mentions");
  await expect(reopened.getByRole("combobox", { name: "Sender" })).toHaveText(
    "Humans",
  );
  await expect(reopened.getByRole("combobox", { name: "Filters" })).toHaveText(
    "Unread only",
  );
  await page.screenshot({
    path: testInfo.outputPath("inbox-restored-filters.png"),
  });

  // Reload proves restoration from durable browser storage rather than a kept
  // component or navigation-level state.
  await page.reload();
  await openPage(page, "Inbox");
  const afterReload = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(
    afterReload.getByRole("combobox", { name: "Activity type" }),
  ).toHaveText("Mentions");
  await expect(
    afterReload.getByRole("combobox", { name: "Sender" }),
  ).toHaveText("Humans");
  await expect(
    afterReload.getByRole("combobox", { name: "Filters" }),
  ).toHaveText("Unread only");
});
