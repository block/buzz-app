import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });

// Native caret motion and composer focus after history traversal require real
// browser engines. The modifier/input eligibility matrix lives in Vitest.
test("Command arrows traverse empty composers and move the caret in a draft", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await open(page, app);
  const composer = (name) =>
    page.getByRole("textbox", { name: `Message #${name}`, exact: true });
  const alpha = composer("Alpha");
  const beta = composer("Beta");
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await sidebar.locator('button[data-channel-id="beta"]').click();
  await expect(beta).toBeFocused();
  await sidebar.locator('button[data-channel-id="alpha"]').click();
  await expect(alpha).toBeFocused();

  for (const [key, destination] of [
    ["ArrowLeft", beta],
    ["ArrowLeft", alpha],
    ["ArrowRight", beta],
    ["ArrowRight", alpha],
  ]) {
    await page.keyboard.press(`Meta+${key}`);
    await expect(destination).toBeFocused();
    await expect(destination).toHaveJSProperty("value", "");
  }

  await alpha.pressSequentially("hello world");
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.type("start ");
  await expect(alpha).toHaveJSProperty("value", "start hello world");
  await expect(alpha).toBeFocused();
  await alpha.evaluate((input) => input.setSelectionRange(0, 0));
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type(" end");
  await expect(alpha).toHaveJSProperty("value", "start hello world end");

  await alpha.fill("");
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(beta).toBeFocused();
});
