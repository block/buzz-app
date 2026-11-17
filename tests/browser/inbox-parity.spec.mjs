import { test, expect } from "./fixture.mjs";
import { conversationList, openChannel, openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Exercises the registered Inbox plugin, real profile contribution and portal focus.
// Leaf renderer tests cannot prove that the page supplies the host services.
test("the same signed mention opens its profile in Inbox and Channels", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const message = app.append(
    "primary",
    "alpha",
    "@Fixture Reader shared mention",
    true,
    false,
    root.id,
    undefined,
    [["p", app.viewer]],
  );
  // The thread's preview follows whichever reply loaded last.
  await conversationList(page)
    .locator("[data-activity-event] [data-conversation-row]")
    .filter({ hasText: "in #Alpha" })
    .click();
  const detail = page.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  const row = detail.locator(`[data-message-id="${message.id}"]`);
  // A pending exact reveal would move the reader under the profile tab below.
  await expect(row).toBeInViewport();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const mention = row.getByRole("button", {
    name: "View Fixture Reader profile",
    exact: true,
  });
  await expect(row).toContainText("shared mention");
  await expect(mention).toBeVisible();
  const composer = detail.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await composer.fill("Preserved Inbox reply");
  // Inbox hosts the profile as a tab beside the thread, as Channels' tabs do.
  const side = page.getByRole("tablist", { name: "Panel tabs" });
  const profileTab = side.getByRole("tab", {
    name: "Fixture Reader",
    exact: true,
  });
  const threadTab = side.getByRole("tab", {
    name: "Thread root 0",
    exact: true,
  });
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await mention.focus();
  await mention.press("Enter");
  await expect(profileTab).toHaveAttribute("aria-selected", "true");
  await expect(profile).toContainText("Fixture Reader");
  await threadTab.click();
  await expect(mention).toBeVisible();
  await expect(composer).toHaveJSProperty("value", "Preserved Inbox reply");
  await page.setViewportSize({ width: 560, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addStyleTag({ content: "html { font-size: 125%; }" });
  await mention.click();
  await expect(profileTab).toHaveAttribute("aria-selected", "true");
  await expect(profile).toContainText("Fixture Reader");
  await side
    .getByRole("button", { name: "Close Fixture Reader tab", exact: true })
    .click();
  await expect(profileTab).toHaveCount(0);
  await expect(threadTab).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveJSProperty("value", "Preserved Inbox reply");
  // Channels shows the same signed reply in its own thread.
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, "Team");
  await openChannel(page, "alpha");
  // The thread stays open beside the channel; reopen it from the channel.
  await page
    .getByRole("button", { name: "Close Thread root 0 tab", exact: true })
    .click();
  await page
    .locator(`[data-message-id="${root.id}"]`)
    .filter({ visible: true })
    .getByRole("button", { name: /^View thread/ })
    .click();
  const channelRow = page
    .locator(`[data-message-id="${message.id}"]`)
    .filter({ visible: true });
  await channelRow
    .getByRole("button", { name: "View Fixture Reader profile", exact: true })
    .click();
  await expect(
    page.getByText("Fixture Reader", { exact: true }).last(),
  ).toBeVisible();
});
