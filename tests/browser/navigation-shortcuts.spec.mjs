import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });

// Composer focus after history traversal and native line movement need real
// browser engines. Draft eligibility and rebindings live in Vitest.
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
  }

  // The caret starts on the second line, so the keys must stop at line edges.
  await alpha.fill("first line\nsecond line");
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(alpha).toHaveJSProperty("selectionStart", "first line\n".length);
  await page.keyboard.press("Meta+ArrowRight");
  await expect(alpha).toHaveJSProperty(
    "selectionStart",
    "first line\nsecond line".length,
  );
  await expect(alpha).toBeFocused();

  await alpha.fill("");
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(beta).toBeFocused();
});
