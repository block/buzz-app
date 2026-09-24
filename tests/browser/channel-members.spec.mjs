import { test, expect } from "./fixture.mjs";

// Browser-only contract: real header composition, modal focus and responsive geometry.
// Write/search failure matrices live in the mounted component and session tests.
test("channel members opens from the header, fits each viewport, and returns keyboard focus", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  const conversation = page.getByRole("article", { name: "Conversation" });
  await expect(
    conversation.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  const trigger = conversation.getByRole("button", {
    name: "Channel members",
    exact: true,
  });
  for (const [width, mode] of [
    [1440, "light"],
    [800, "dark"],
    [390, "light"],
  ]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect(dialog.getByText(/Members ·/)).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(850);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`channel-members-${width}-${mode}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});
