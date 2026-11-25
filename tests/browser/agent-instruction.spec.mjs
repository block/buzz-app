import { test, expect } from "./source-fixture.mjs";

test.use({ video: "on" });

test("instruction review keeps cancel and send reachable for long payloads", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto("/tests/fixtures/agent-instruction.html");
  await page.getByRole("button", { name: "Request instruction" }).click();
  const review = page.getByRole("alertdialog");
  const cancel = review.getByRole("button", { name: "Cancel", exact: true });
  const send = review.getByRole("button", {
    name: "Send instruction",
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await expect(review).toContainText("Link only synthetic A to synthetic B.");
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 600 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
      }, theme);
      await expect(cancel).toBeInViewport();
      await expect(send).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`${theme}-${width}.png`),
      });
    }
  }
  await cancel.click();
  await expect(page.getByLabel("Receipt")).toHaveText("refused; deliveries=0");
  await page.getByRole("button", { name: "Request instruction" }).click();
  await expect(cancel).toBeFocused();
  await send.click();
  await expect(page.getByLabel("Receipt")).toHaveText(
    "delivered; deliveries=1",
  );
  await expect(review).toHaveCount(0);
});
