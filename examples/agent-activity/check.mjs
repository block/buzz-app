// Ad-hoc prototype check against the running offline preview, not product E2E.
import { chromium, webkit, expect } from "@playwright/test";
async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}
for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:1451/examples/agent-activity/index.html");
    const conversation = page.getByRole("region", {
      name: "Agent conversation thread",
      exact: true,
    });
    const source = conversation
      .getByRole("button", { name: "Running composer tests", exact: true })
      .first();
    await expect(
      conversation.getByRole("button", {
        name: "Open in side panel",
        exact: true,
      }),
    ).toHaveCount(0);
    await source.click();
    await expect(source).toHaveAttribute("aria-expanded", "true");
    const read = conversation.getByRole("button", {
      name: "Read MessageComposer.tsx",
      exact: true,
    });
    await expect(read).toBeVisible();
    await read.click();
    await expect(conversation.locator("pre")).toContainText("const recipients");
    await expect(
      conversation.getByRole("button", {
        name: "Open in side panel",
        exact: true,
      }),
    ).toHaveCount(0);
    async function dragOut() {
      await settle(page);
      const box = await source.boundingBox();
      await page.mouse.move(box.x + 70, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 95, box.y + box.height / 2, { steps: 8 });
      const target = page.getByRole("region", {
        name: "Drop activity here to open a side panel",
      });
      await expect(target).toBeVisible();
      const drop = await target.boundingBox();
      await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, {
        steps: 15,
      });
      // Native dragover is dispatched on the next move after entering in WebKit.
      await page.mouse.move(
        drop.x + drop.width / 2 + 1,
        drop.y + drop.height / 2,
        { steps: 2 },
      );
      await page.mouse.up();
    }
    await dragOut();
    const panel = page.getByRole("region", {
      name: "Agent activity side panel",
      exact: true,
    });
    await expect(panel).toBeVisible();
    await expect(source).toHaveAttribute("aria-expanded", "false");
    await expect(
      conversation
        .locator(".activity-disclosure .buzz-accordion-panel")
        .first(),
    ).toBeHidden();
    await expect(
      panel.getByRole("heading", { name: "Activity", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("region", { name: "Channel context", exact: true }),
    ).toBeVisible();
    await expect(conversation).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `/tmp/buzz-activity-${engine}-panel.png` });
    await page.getByRole("button", { name: "Close activity panel" }).click();
    await expect(source).toBeFocused();
    await page.getByRole("button", { name: "Completed", exact: true }).click();
    const view = conversation.getByRole("button", {
      name: "View activity",
      exact: true,
    });
    await expect(view).toBeVisible();
    const reply = conversation.getByText(
      "Fixed. The selected agent now stays",
      { exact: false },
    );
    await expect(reply).toBeVisible();
    expect((await view.boundingBox()).y).toBeLessThan(
      (await reply.boundingBox()).y,
    );
    await view.focus();
    await page.keyboard.press("Enter");
    await expect(view).toHaveAttribute("aria-expanded", "true");
    await expect(
      conversation.getByRole("button", { name: "Ran composer tests" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Working", exact: true }).click();
    const box = await source.boundingBox();
    await page.mouse.move(box.x + 70, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 95, box.y + box.height / 2, { steps: 8 });
    await expect(
      page.getByRole("region", {
        name: "Drop activity here to open a side panel",
      }),
    ).toBeVisible();
    await page.mouse.move(1270, 420, { steps: 15 });
    await page.mouse.up();
    await expect(panel).toBeVisible();
    await expect(source).toHaveAttribute("aria-expanded", "false");
    await expect(
      conversation
        .locator(".activity-disclosure .buzz-accordion-panel")
        .first(),
    ).toBeHidden();
    await page.getByRole("button", { name: "Preview dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    await settle(page);
    await page.screenshot({ path: `/tmp/buzz-activity-${engine}-dark.png` });
    await page.getByRole("button", { name: "Close activity panel" }).click();
    await page.getByRole("button", { name: "Unknown", exact: true }).click();
    await expect(conversation.getByRole("status")).toContainText(
      "current status is unknown",
    );
    await page.getByRole("button", { name: "Preview light mode" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Expanded", exact: true }).click();
    await expect(conversation.locator("pre")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await settle(page);
    await page.screenshot({
      path: `/tmp/buzz-activity-${engine}-narrow.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1024, height: 900 });
    await dragOut();
    await settle(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(1024);
    await expect(panel).toBeVisible();
    expect(errors).toEqual([]);
    console.log(
      `${engine}: inline/detail, panel/focus, completed/keyboard, native drag, unknown, dark and narrow checks passed`,
    );
  } finally {
    await browser.close();
  }
}
