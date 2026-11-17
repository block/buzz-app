import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { conversationList, openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
  developmentReact: true,
});

// Browser-only: the production build can opt into development React. Effects
// replay there; an inline reveal must retain a live signal and reveal the
// exact target in a newly opened tab.
test("reveals an exact thread target after effect cleanup and setup replay", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Activity");
  const opener = conversationList(page)
    .locator("[data-activity-event] [data-conversation-row]")
    .filter({ hasText: "Unread reply 1" });
  await opener.click();
  const target = page
    .getByRole("region", { name: "Conversation in Alpha", exact: true })
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 1" });
  await expect(target).toBeInViewport();
});
