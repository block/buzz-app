import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Picker and colon suggestions learn from one usage history that survives reload.
test("emoji chosen in the picker or suggestions rise in both, after reload too", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html");
  const input = page.getByRole("textbox", { name: "Message #general" });
  const choices = page.getByRole("option");
  const labels = () =>
    choices.locator("[data-completion-label]").allTextContents();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  const frequent = page.locator(
    'em-emoji-picker .category[data-id="frequent"] button',
  );
  const openPicker = async () => {
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await expect(search).toBeVisible();
  };
  const openFrequent = async () => {
    await openPicker();
    await search.fill("");
    await expect(frequent.first()).toBeVisible();
  };
  const counts = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "{}"),
    );
  const closePicker = async () => {
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  };

  // New users get the query order.
  await input.fill(":sm");
  await expect(choices.first()).toHaveText(/:smile:/);
  await input.fill(":hate");
  await expect(choices.first()).toHaveText(/:rage:/);
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot:", ":party-parrot-wave:"]);
  // Highlighting a suggestion is not choosing it.
  await input.press("ArrowDown");
  await expect(choices.nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("Escape");
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot:", ":party-parrot-wave:"]);

  // A picker choice ranks first among its prefix matches.
  await input.fill("");
  await openPicker();
  // A fresh picker shows one row of defaults, as Emoji Mart seeds it.
  await expect(frequent).toHaveCount(8);
  await search.fill("smirk");
  await expect(
    page.locator('em-emoji-picker .category button[aria-label="😏"]').first(),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(input).toHaveJSProperty("value", "😏 ");
  await input.fill(":sm");
  await expect(choices.first()).toHaveText(/:smirk:/);
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "😏 ");
  // The closing colon chooses the exact name too.
  await input.fill(":smirk");
  await expect(choices.first()).toHaveText(/:smirk:/);
  await input.press(":");
  await expect(input).toHaveJSProperty("value", "😏 ");
  // The picker's default row is not usage: never-chosen 😍 stays behind
  // the keyword match for `hate`.
  await input.fill(":hate");
  await expect(choices.first()).toHaveText(/:rage:/);

  // A keyboard suggestion choice of a community emoji teaches suggestions and
  // the picker's Frequently used row, once.
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot:", ":party-parrot-wave:"]);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", ":party-parrot-wave: ");
  // Recording finishes once Emoji Mart's module resolves.
  await expect.poll(counts).toMatchObject({
    "buzz-custom/a/party-parrot-wave": 1,
  });
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot-wave:", ":party-parrot:"]);
  await input.press("Escape");
  await input.fill("");
  const stored = await counts();
  expect(stored).toMatchObject({
    smirk: 3,
    "buzz-custom/a/party-parrot-wave": 1,
  });
  expect(stored.heart_eyes).toBeLessThan(1);
  await openFrequent();
  await expect(frequent.locator('img[src*="wave.png"]')).toHaveCount(1);
  await expect(frequent.and(page.locator('[aria-label="😏"]'))).toHaveCount(1);
  await closePicker();

  await page.reload();
  await input.fill(":sm");
  await expect(choices.first()).toHaveText(/:smirk:/);
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot-wave:", ":party-parrot:"]);
  await input.press("Escape");
  await input.fill("");
  await openFrequent();
  await expect(frequent.locator('img[src*="wave.png"]')).toHaveCount(1);
  await closePicker();
  expect(errors.unexplained()).toEqual([]);
});

test("the default row follows the picker's width across reloads", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const frequent = page.locator(
    'em-emoji-picker .category[data-id="frequent"] button',
  );
  const openPicker = async () => {
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await expect(frequent.first()).toBeVisible();
  };
  await page.setViewportSize({ width: 240, height: 844 });
  await page.goto("/tests/fixtures/emoji.html");
  await openPicker();
  await expect(frequent).toHaveCount(4);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await openPicker();
  await expect(frequent).toHaveCount(8);
  await page.setViewportSize({ width: 240, height: 844 });
  await page.reload();
  await openPicker();
  await expect(frequent).toHaveCount(4);
  expect(errors.unexplained()).toEqual([]);
});
