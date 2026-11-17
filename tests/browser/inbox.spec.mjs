import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  activityRow,
  conversationList,
  hideNarrowConversationList,
  openPage,
} from "./navigation.mjs";

// Browser-only contract: Activity's list routes to exact thread targets and
// real media dismissal. Matrices stay in RTL/unread tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Newest-first integration: exact Inbox selection must not be replaced by the
// newest ten replies; the saved draft context is exercised by PR5.
test.describe("signed newest-first Inbox windows", () => {
  const channel = "00000000-0000-0000-0000-000000000123";
  test.use({
    threadUnread: false,
    threadUnreadMentions: false,
    inboxDm: false,
    inboxThreadWindow: true,
    channelIds: ["alpha", channel],
    channelNames: { [channel]: "Window room" },
    historyCounts: { alpha: 1, [channel]: 0 },
  });
  test("reveals an older exact unread anchor in newest-first context", async ({
    page,
    app,
  }) => {
    const { root, replies } = app.inboxWindow;
    const oldest = replies[0],
      newest = replies.at(-1);
    await page.goto(app.origin);
    await openPage(page, "Activity");

    // The thread's own row; the channel's row previews its top-level posts.
    const rows = conversationList(page).locator(
      `[data-activity-event$=":${root.id}"]`,
    );
    const row = rows.filter({ hasText: "Window room" });
    await row.locator("[data-conversation-row]").click();
    const detail = page.getByRole("region", {
      name: "Conversation in Window room",
      exact: true,
    });
    const target = detail.locator(`[data-message-id="${oldest.id}"]`);
    await expect(target).toBeInViewport();
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) =>
            filter.thread_window &&
            filter.limit === 10 &&
            filter["#h"]?.includes(channel),
        ),
      )
      .toBe(true);
    await expect(
      detail.locator(`[data-message-id="${newest.id}"]`),
    ).toBeAttached();
    // The selected anchor survives a later arrival; no fresh click/reveal was requested.
    const arrival = app.reply(root.id);
    await expect(
      detail.getByText("New peer reply", { exact: true }),
    ).toBeAttached();
    await expect(target).toBeInViewport();
    // Re-clicking the selected row reveals its current message in the same tab.
    const again = rows.filter({ hasText: "Window room" });
    await expect(again).toContainText("New peer reply");
    await again.locator("[data-conversation-row]").click();
    await expect(
      page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab"),
    ).toHaveCount(1);
    const current = detail
      .locator("[data-message-id]")
      .filter({ hasText: "New peer reply" });
    await expect(current).toBeInViewport();
    await expect(current).toBeFocused();
    // This removal is signed by the synthetic author and arrives through the
    // actual shared relay stream. It cannot turn a vanished target into a tail reveal.
    app.deleteInboxAnchor(arrival);
    await expect(current).toHaveCount(0);
    // Other participating replies keep the conversation in the list, and its
    // tab stays open on the thread.
    await expect(again).toHaveCount(1);
    await expect(again).not.toContainText("New peer reply");
    await expect(
      detail.locator(`[data-message-id="${root.id}"]`),
    ).toBeAttached();
  });
});

// Browser-only: a DM opens its whole conversation at narrow width, where real
// portalled video dismissal must stay with its document-level owner.
test("a narrow DM tab keeps portalled media dismissal inside the tab", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, app);
  await openPage(page, "Activity");
  const team = page.getByRole("region", { name: "Team list", exact: true });
  const videoUrl = "https://primary.example/media/inbox-review.mp4";
  await page.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: "tests/fixtures/message-gallery/assets/sample.mp4",
      contentType: "video/mp4",
    }),
  );
  app.append(
    "primary",
    "dm-peer",
    "Inbox video",
    false,
    false,
    undefined,
    undefined,
    [["imeta", `url ${videoUrl}`, "m video/mp4"]],
  );
  await team.getByRole("tab", { name: "DMs", exact: true }).click();
  const list = team.getByRole("list", { name: "Conversations", exact: true });
  const row = list.getByRole("listitem").first();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await row.locator("[data-conversation-row]").click();
  // The narrow list lays over the reader; close it to read the DM.
  await hideNarrowConversationList(page);
  const detail = page.getByRole("region", {
    name: "Alice Fixture",
    exact: true,
  });
  await expect(
    detail
      .locator("[data-message-id]")
      .filter({ hasText: "Inbox DM fixture reply" }),
  ).toBeVisible();
  await expect(detail.getByRole("form")).toHaveCount(1);
  const mediaOpener = detail.getByRole("button", {
    name: "Open video fullscreen",
  });
  await detail.locator("[data-video-preview]").hover();
  await expect(mediaOpener).toHaveCSS("pointer-events", "auto");
  await mediaOpener.click();
  const media = page.getByRole("dialog", { name: "Video review" });
  await expect(media).toBeVisible();
  await media.getByRole("button", { name: "Close fullscreen viewer" }).focus();
  await page.keyboard.press("Escape");
  await expect(media).toHaveCount(0);
  await expect(detail).toBeVisible();
  await expect(mediaOpener).toBeFocused();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
});

// Browser-only: leaving a channel releases its profile room in a layout effect
// and shrinks the cache a task later, after the Inbox's mount effect has asked
// for names. The shrink must not cancel that read.
test.describe("Inbox names after leaving a channel", () => {
  const launch = "5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
  test.use({
    threadUnread: false,
    threadUnreadMentions: false,
    inboxDm: false,
    channelIds: ["alpha", launch],
    channelNames: { [launch]: "Launch" },
    historyCounts: { alpha: 1, [launch]: 0 },
  });
  test("names an author seen only in the Inbox", async ({ page, app }) => {
    const key = generateSecretKey();
    const author = getPublicKey(key);
    app.serveProfile(key, { name: "Priya Shah" });
    app.histories.get(`primary/${launch}`).push(
      finalizeEvent(
        {
          kind: 9,
          created_at: Math.floor(Date.now() / 1000) - 3600,
          tags: [
            ["h", launch],
            ["p", app.viewer],
          ],
          content: "Can you check the release notes?",
        },
        key,
      ),
    );
    await open(page, app);
    await activityRow(page).click();
    // She mentioned the viewer, so Mentions lists it.
    await page
      .getByRole("tablist", { name: "Conversation view" })
      .getByRole("tab", { name: "Mentions", exact: true })
      .click();
    const row = conversationList(page)
      .locator("[data-activity-event]")
      .filter({ hasText: "release notes" });
    // The row's avatar says who wrote it: her name's initial, not her key's.
    await expect(row.locator("[data-avatar-fallback]")).toHaveText("P");
    // Her name came from the first read; nothing cancelled it and asked again.
    expect(
      app.report.queries.filter(
        ({ filter }) =>
          filter.kinds?.includes(0) && filter.authors?.includes(author),
      ),
    ).toHaveLength(1);
  });
});
