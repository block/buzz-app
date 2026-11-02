import { test, expect } from "./source-fixture.mjs";

// CSS overflow, resting hover and editor focus require a rendered browser.
test("long emoji suggestions expose their full names and preserve keyboard and pointer insertion", async ({
  page,
}) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html");
  const draft = page.getByRole("textbox", { name: "Message #general" });
  const name = ":very-long-community-emoji-name-that-does-not-fit:";
  const option = page.getByRole("option", { name, exact: true });
  const searching = page.getByText("Searching emoji…");

  // Use the same real composer at normal and enlarged text sizes, in both themes.
  for (const mode of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        ({ mode, width }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.fontSize = width === 390 ? "32px" : "";
        },
        { mode, width },
      );
      await draft.fill(":very-long");
      await expect(option).toBeVisible();
      await expect(searching).toHaveCount(0);
      await option.hover();
      const hint = page.getByRole("tooltip");
      await expect(hint).toHaveText(name);
      await expect(hint).toBeInViewport();
      await expect(draft).toBeFocused();
      expect(
        await option.evaluate((row) => {
          const bounds = row.getBoundingClientRect();
          return (
            row.scrollWidth <= row.clientWidth &&
            bounds.left >= 0 &&
            bounds.right <= innerWidth
          );
        }),
      ).toBe(true);
      await option.click();
      await expect(draft).toHaveJSProperty("value", name);
      await expect(draft).toBeFocused();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(hint).toHaveCount(0);
    }
  }

  // The fixture includes three similar names up to the existing 64-character limit.
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.mouse.move(0, 0);
  await draft.fill(`:${"a".repeat(60)}`);
  await expect(page.getByRole("option")).toHaveCount(3);
  await expect(searching).toHaveCount(0);
  const options = page.getByRole("option");
  await draft.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(draft).toHaveAttribute(
    "aria-activedescendant",
    await options.nth(1).getAttribute("id"),
  );
  await draft.press("Tab");
  await expect(draft).toHaveJSProperty("value", `:${"a".repeat(63)}:`);
  await expect(draft).toBeFocused();
  await draft.fill(`:${"a".repeat(60)}`);
  await expect(options).toHaveCount(3);
  await expect(searching).toHaveCount(0);
  await draft.press("ArrowUp");
  await draft.press("Enter");
  await expect(draft).toHaveJSProperty("value", `:${"a".repeat(64)}:`);
  await expect(draft).toBeFocused();
  await draft.fill(`:${"a".repeat(60)}`);
  await expect(options).toHaveCount(3);
  await expect(searching).toHaveCount(0);
  await options.nth(1).hover();
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tooltip")).toHaveText(`:${"a".repeat(63)}:`);
  await options.nth(1).click();
  await expect(draft).toHaveJSProperty("value", `:${"a".repeat(63)}:`);
  await expect(draft).toBeFocused();
  await draft.fill(":very-long");
  await expect(option).toBeVisible();
  await expect(searching).toHaveCount(0);
  await option.hover();
  await expect(page.getByRole("tooltip")).toHaveText(name);
  await draft.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(draft).toHaveJSProperty("value", ":very-long");
});
