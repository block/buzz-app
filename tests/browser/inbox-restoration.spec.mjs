import { activityRow } from "./navigation.mjs";
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
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const row = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click();
  const tab = inbox.getByRole("tab", { name: "Thread root 1", exact: true });
  const reader = inbox.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(reader).toBeVisible();
  // Messages is the owner of every page listed in its sidebar, so "visiting
  // Messages" is opening a conversation and Reminders is another listed row.
  // Alpha has unread replies, so its row's name ends with the count; the
  // channel id names it either way.
  const alpha = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator('button[data-channel-id="alpha"]');
  const reminders = page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Reminders", exact: true });
  for (const destination of [alpha, reminders]) {
    await destination.click();
    await expect(inbox).toHaveCount(0);
    await inboxTab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(reader).toBeVisible();
    await expect(row).toHaveAttribute("data-selected");
  }
  await inbox
    .getByRole("button", { name: "Close Thread root 1 tab", exact: true })
    .click();
  await expect(tab).toHaveCount(0);
  await reminders.click();
  await expect(inbox).toHaveCount(0);
  await inboxTab.click();
  await expect(
    inbox.getByRole("list", { name: "Activity", exact: true }),
  ).toBeVisible();
  await expect(tab).toHaveCount(0);
});
