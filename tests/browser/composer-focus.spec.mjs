import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, dmLabels: true });

// Browser boundary: real sidebar navigation must hand focus to the mounted
// ProseMirror editor, including after a warm return; typing must need no click.
test("selecting a channel or DM focuses its composer and retains drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const conversation = page.getByRole("article", { name: "Conversation" });
  const input = conversation.getByRole("textbox");
  for (const [index, name] of [
    "Beta",
    "Alice Fixture",
    "Beta",
    "Alice Fixture",
  ].entries()) {
    await sidebar.getByRole("button", { name, exact: true }).click();
    await expect(input).toBeFocused();
    if (index < 2) {
      await page.keyboard.type(`Draft for ${name}`);
    }
    await expect(input).toHaveText(`Draft for ${name}`);
  }
  const settings = page.getByRole("button", {
    name: "Channel settings",
    exact: true,
  });
  await settings.click();
  await expect(
    page.getByRole("button", { name: "Close channel settings" }),
  ).toBeFocused();
});
