import { activityRow, conversationList, openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
  enabledPlugins: ["buzz.reminders"],
});

// Real shell/plugin routing and visible retained reader, beyond direct remount tests.
test("Activity restores its conversation after visiting Messages and another page", async ({
  page,
  app,
}) => {
  await open(page, app);
  const inboxTab = activityRow(page);
  await inboxTab.click();
  const row = conversationList(page)
    .locator("[data-activity-event] [data-conversation-row]")
    .filter({ hasText: "Unread reply 1" });
  await row.click();
  const tab = page.getByRole("tab", { name: "Thread root 1", exact: true });
  const reader = page.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(reader).toBeVisible();
  for (const destination of ["Reminders", "Team"]) {
    await openPage(page, destination);
    // Team's own page keeps its list; another app's page replaces it.
    if (destination === "Reminders")
      await expect(conversationList(page)).toHaveCount(0);
    // Back returns to Activity with the conversation it had open.
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(reader).toBeVisible();
    await expect(row).toHaveAttribute("aria-current", "page");
  }
  await page
    .getByRole("button", { name: "Close Thread root 1 tab", exact: true })
    .click();
  await expect(tab).toHaveCount(0);
  await openPage(page, "Reminders");
  await expect(conversationList(page)).toHaveCount(0);
  await inboxTab.click();
  await expect(conversationList(page)).toBeVisible();
  await expect(tab).toHaveCount(0);
});
