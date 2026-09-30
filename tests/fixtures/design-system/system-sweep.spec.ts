import { expect, test } from "@playwright/test";

const viewer = "/tests/fixtures/design-system.html#/design/";

// Browser-only: real CSS cascade, hover paint, root rem geometry and portalled
// menus cannot be established by a DOM emulator. Token matrices stay in Vitest.
test("surface playground keeps content readable and menus usable in both themes", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}surface-playground`);
  for (const dark of [false, true]) {
    if (dark) await page.getByRole("button", { name: "Use dark mode" }).click();
    const floating = page.getByRole("article", { name: "Floating surface" });
    await expect(floating).toHaveCSS(
      "background-color",
      dark ? "rgb(40, 40, 40)" : "rgb(255, 255, 255)",
    );
    const button = floating.getByRole("button", {
      name: "Subtle",
      exact: true,
    });
    await button.hover();
    await expect(button).toHaveCSS(
      "background-color",
      dark ? "rgb(46, 46, 46)" : "rgb(241, 241, 242)",
    );
    await expect(button).toHaveCSS(
      "color",
      dark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
    );
    await floating.getByRole("button", { name: "Open floating menu" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    if (browserName === "webkit") {
      // Playwright WebKit sends zero movementX/Y even when coordinates change.
      // Base UI intentionally ignores these events to protect keyboard selection.
      // Check its highlighted paint through keyboard input; native button hover
      // is checked above. Actual WebKit pointer highlighting needs an attended run.
      await page.keyboard.press("Home");
    } else {
      await page.getByRole("menuitem", { name: "View details" }).hover();
    }
    await expect(
      page.getByRole("menuitem", { name: "View details" }),
    ).toHaveAttribute("data-highlighted", "");
    await expect(
      page.getByRole("menuitem", { name: "View details" }),
    ).toHaveCSS(
      "background-color",
      dark ? "rgb(46, 46, 46)" : "rgb(241, 241, 242)",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    for (const width of [390, 900, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`surfaces-${dark ? "dark" : "light"}-${width}.png`),
        fullPage: true,
      });
    }
  }
});

test("rem playground separates root and text scale, preserves drafts, and cleans up on navigation", async ({
  page,
}) => {
  await page.goto(`${viewer}rem-playground`);
  const draft = page.getByLabel("Project name", { exact: true });
  await draft.fill("Keep this draft while sizing");
  const choose = async (label: string, option: string) => {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  await choose("Root size", "150% root");
  await expect(page.locator(".system-rem-ruler")).toHaveCSS("width", "240px");
  await expect(page.locator(".system-px-ruler")).toHaveCSS("width", "160px");
  await expect(draft).toHaveCSS("font-size", "21px");
  await choose("Text scale", "200% text");
  await expect(draft).toHaveCSS("font-size", "42px");
  await expect(page.locator(".system-rem-ruler")).toHaveCSS("width", "240px");
  await expect(draft).toHaveValue("Keep this draft while sizing");
  await expect
    .poll(() =>
      draft.evaluate(
        (el) =>
          el.clientHeight >= Number.parseFloat(getComputedStyle(el).lineHeight),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Reset sizing" }).click();
  await expect(draft).toHaveCSS("font-size", "14px");
  await page.setViewportSize({ width: 390, height: 900 });
  await choose("Text scale", "200% text");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("rem-narrow-large-text.png"),
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Colors & surfaces", exact: true })
    .click();
  await expect(page.locator("html")).toHaveCSS("font-size", "16px");
  await expect(page.getByLabel("Raised name")).toHaveCSS("font-size", "14px");
});

test("production reaction counts grow with host text size without clipping", async ({
  page,
}) => {
  await page.goto("http://localhost:1445/tests/fixtures/emoji.html?reactions");
  const reactions = page
    .locator("[data-message-id]")
    .filter({ hasText: "Historic" });
  const count = reactions.locator('[class*="_reactionCountMotion_"]').first();
  await expect(count).toBeVisible();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await expect(count).toHaveCSS("font-size", "24px");
  await expect
    .poll(() =>
      count.evaluate(
        (el) =>
          el.clientHeight >= Number.parseFloat(getComputedStyle(el).fontSize),
      ),
    )
    .toBe(true);
});
