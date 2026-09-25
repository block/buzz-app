import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test("channel settings owns its responsive side panel and returns keyboard focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", { name: "Conversation" });
  await expect(
    conversation.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  const trigger = page.getByRole("button", {
    name: "Channel settings",
    exact: true,
  });
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await trigger.click();
  await expect(panel).toBeVisible();
  // Diagnostics moved from a popup to this real shared Panel surface.
  const tokens = await page.addStyleTag({
    content: `:root, :root[data-color-mode] {
      --surface-panel: rgb(23, 45, 67);
      --border-standard: rgb(45, 67, 89);
      --radius-panel: 19px;
    }`,
  });
  try {
    await expect(panel).toHaveCSS("background-color", "rgb(23, 45, 67)");
    await expect(panel).toHaveCSS("border-top-color", "rgb(45, 67, 89)");
    await expect(panel).toHaveCSS("border-radius", "19px");
  } finally {
    await tokens.evaluate((node) => node.remove());
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const close = panel.getByRole("button", { name: "Close channel settings" });
  await expect(close).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeHidden();
  await panel.getByText("Diagnostics", { exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeVisible();
  const conversationBox = await conversation.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(
    conversationBox.x + conversationBox.width,
  );
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    panel.getByRole("button", { name: "Refresh channels", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 800 });
  await trigger.click();
  await expect(close).toBeFocused();
  const narrow = await panel.boundingBox();
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(600);
  expect(narrow.y + narrow.height).toBeLessThanOrEqual(800);
  await close.click();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await trigger.click();
  await expect(panel).toBeVisible();
  const messages = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator("summary")
    .filter({ hasText: /^Messages$/ });
  await messages.hover();
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "New message", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);
});
