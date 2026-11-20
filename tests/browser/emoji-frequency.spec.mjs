import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Real composer selection, keyboard acceptance and durable state across reloads.
test("emoji autocomplete learns accepted choices and picker selections", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/emoji.html?separator-collision");
  const input = page.getByRole("textbox", { name: "Message #general" });
  const options = page.getByRole("option");
  await input.fill(":party-parrot");
  await expect(options.first()).toHaveAttribute(
    "data-completion-id",
    "custom/party-parrot",
  );
  await input.press("Escape");
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

  // A learned separator variant cannot steal the literal shortcode on Tab.
  await input.fill(":party");
  await page.locator('[data-completion-id="custom/party-parrot"]').click();
  await expect(input).toHaveJSProperty("value", ":party-parrot: ");
  for (const key of ["Tab", ":"]) {
    await input.fill(":party_parrot");
    await expect(options.first()).toHaveAttribute(
      "data-completion-id",
      "custom/party_parrot",
    );
    await input.press(key);
    await expect(input).toHaveJSProperty("value", ":party_parrot: ");
  }
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

// Native focus crosses Mart's shadow root and the host's slotted footer.
test("a rejected first skin-tone pick restores keyboard focus without learning", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/emoji.html");
  const input = page.getByRole("textbox", { name: "Message #general" });
  // Exercise the real composer's insertion limit.
  const fullDraft = "x".repeat(16000);
  await input.fill(fullDraft);
  await page
    .getByRole("button", { name: "Emoji and GIFS", exact: true })
    .click();
  await page.getByRole("searchbox", { name: "Search emoji" }).fill("thumbs up");
  await page
    .locator(
      'em-emoji-picker .category:not([data-id]) button[aria-posinset="1"]',
    )
    .click();
  const menu = page.locator("em-emoji-picker #root > .menu");
  await expect(menu).toBeVisible();
  await menu.locator('input[value="4"]').focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", fullDraft);
  await expect(
    page.getByRole("button", { name: "Choose default skin tone" }),
  ).toBeFocused();
  expect(
    await page.evaluate(() =>
      localStorage.getItem('buzz-view.v1:["a","emoji:usage:v1"]'),
    ),
  ).toBeNull();
  expect(errors.unexplained()).toEqual([]);
});
