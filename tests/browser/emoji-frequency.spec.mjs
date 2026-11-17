import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Real composer selection, keyboard acceptance and durable state across reloads.
test("emoji autocomplete learns accepted choices and picker selections", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/emoji.html");
  const input = page.getByRole("textbox", { name: "Message #general" });
  const options = page.getByRole("option");
  await input.fill(":jo");
  await expect(
    page.locator('[data-completion-id="unicode/joy"]'),
  ).toBeVisible();
  await expect(options.first()).toHaveAttribute(
    "data-completion-id",
    "custom/job",
  );
  await page.locator('[data-completion-id="unicode/joy"]').click();
  await expect(input).toHaveJSProperty("value", "😂 ");
  await input.fill(":jo");
  await expect(options.first()).toHaveAttribute(
    "data-completion-id",
    "unicode/joy",
  );
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "😂 ");

  // Exact-name conversion still selects job even when joy is more frequent.
  await input.fill(":job");
  await expect(options.first()).toHaveAttribute(
    "data-completion-id",
    "custom/job",
  );
  await input.press(":");
  await expect(input).toHaveJSProperty("value", ":job: ");
  await page.reload();
  await input.fill(":jo");
  await expect(options.first()).toHaveAttribute(
    "data-completion-id",
    "unicode/joy",
  );
  await input.press("Escape");
  await input.fill("");

  // Picker selections feed the same ranking.
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("job");
    const job = page.locator(
      'em-emoji-picker .category button:has(img[alt=":job:"])',
    );
    await expect(job).toHaveCount(1);
    await job.click();
    await expect(input).toHaveJSProperty("value", ":job: ");
    await input.fill("");
  }
  await input.fill(":jo");
  await expect(options.first()).toHaveAttribute(
    "data-completion-id",
    "custom/job",
  );
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", ":job: ");
  for (const [mode, width, scale] of [
    ["light", 1280, 1],
    ["dark", 390, 1.5],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(
      ({ mode, scale }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.setProperty("--buzz-text-scale", scale);
      },
      { mode, scale },
    );
    await input.fill(":jo");
    await expect(options.first()).toHaveAttribute(
      "data-completion-id",
      "custom/job",
    );
    await expect(options.first()).toBeInViewport();
    await expect(input).toBeFocused();
    await input.press("Escape");
  }
  expect(errors.unexplained()).toEqual([]);
});
