import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

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
  await openPage(page, "Inbox");
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
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const conversation = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: "Broadcast reply" });
  await conversation.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  const row = detail.locator(`[data-message-id="${message.id}"]`);
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
  await mention.focus();
  await mention.press("Enter");
  const profile = page.getByRole("dialog", { name: "Profile", exact: true });
  await expect(profile).toBeVisible();
  await expect(profile).toContainText("Fixture Reader");
  await page.keyboard.press("Escape");
  await expect(mention).toBeFocused();
  await expect(composer).toHaveJSProperty("value", "Preserved Inbox reply");
  await detail
    .getByRole("button", { name: "Open in channel", exact: true })
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
