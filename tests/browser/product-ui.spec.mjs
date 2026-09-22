import { test, expect } from "@playwright/test";
import { createServer } from "vite";
let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    configFile: "vite.product-ui.config.ts",
    server: { port: 0, strictPort: false, open: false },
  });
  await server.listen();
  url = `${server.resolvedUrls.local[0]}tests/fixtures/product-ui.html`;
});
test.afterAll(async () => {
  await server?.close();
});
test("product catalogue uses the production composer and shared navigation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}#/design/product-ui/composer`);
  await expect(
    page.getByRole("heading", { name: "Product UI", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Composer", exact: true, level: 1 }),
  ).toBeVisible();
  const preview = page.getByRole("region", {
    name: "Composer playground",
    exact: true,
  });
  const previewInput = preview.getByRole("textbox");
  await expect(previewInput).toHaveAttribute(
    "aria-label",
    "Message #buzz-design",
  );
  await preview.getByRole("combobox", { name: "Preview context" }).click();
  await page
    .getByRole("option", { name: "Session · Reply", exact: true })
    .click();
  await expect(previewInput).toHaveAttribute("aria-label", "Reply to thread");
  await previewInput.fill("Hello from the production composer");
  await preview.getByRole("button", { name: "Send message" }).click();
  await expect(previewInput).toHaveText("");
  await page
    .getByRole("link", { name: "Text formatting", exact: true })
    .click();
  const composer = page.getByRole("form");
  const editor = composer.getByRole("textbox");
  await editor.fill("@Ali");
  await page
    .getByRole("option", { name: `Alice ${"a".repeat(64)}`, exact: true })
    .click();
  await expect(
    composer.getByRole("region", { name: "Notification recipients" }),
  ).toBeVisible();
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  expect(errors).toEqual([]);
});

test("navigation retains breathing room after its final link", async ({
  page,
}) => {
  await page.goto(`${url}#/design/product-ui/composer`);
  await page.setViewportSize({ width: 1440, height: 800 });
  const nav = page.getByRole("navigation", { name: "Design system" });
  await expect(
    nav.getByRole("link", { name: "Emoji and expressions", exact: true }),
  ).toBeVisible();
  await nav.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      nav.evaluate((element) => {
        const last = element.querySelector('a[href$="/expressions"]');
        return last
          ? element.getBoundingClientRect().bottom -
              last.getBoundingClientRect().bottom
          : 0;
      }),
    )
    .toBeGreaterThanOrEqual(72);
  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
});

test("dark navigation selection contrasts with the rail and survives hover", async ({
  page,
}) => {
  await page.goto(`${url}#/design/product-ui/composer`);
  const selected = page
    .getByRole("navigation")
    .getByRole("link", { name: "Overview", exact: true })
    .last();
  await expect(selected).toHaveCSS("background-color", "rgb(232, 232, 232)");
  await page
    .getByRole("button", { name: "Use dark mode", exact: true })
    .click();
  await expect(selected).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await selected.hover();
  await expect(selected).toHaveCSS("background-color", "rgb(51, 51, 51)");
  const other = page.getByRole("link", { name: "Inline chips", exact: true });
  await other.hover();
  await expect(other).toHaveCSS("background-color", "rgb(35, 35, 35)");
});

test("product page hierarchy separates its three levels", async ({ page }) => {
  await page.goto(`${url}#/design/product-ui/composer`);
  const states = page.getByRole("region", { name: "States", exact: true });
  await expect(states).toBeVisible();
  // Level 2 heading vs level 3 specimen heading: different size and weight.
  const section = states.getByRole("heading", { level: 2, name: "States" });
  const specimen = states.getByRole("heading", {
    level: 3,
    name: "Unavailable",
  });
  const sizeOf = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.fontSize}/${style.fontWeight}`;
    });
  expect(await sizeOf(section)).not.toBe(await sizeOf(specimen));
  // A specimen title and its description read as one pair.
  const pairGap = await specimen.evaluate((heading) => {
    const description = heading.nextElementSibling;
    return description
      ? description.getBoundingClientRect().top -
          heading.getBoundingClientRect().bottom
      : Number.NaN;
  });
  expect(pairGap).toBeLessThan(12);
  // Sibling states are separated by more space than that pair.
  const stateGap = await states.evaluate((region) => {
    const [first, second] = region.querySelectorAll(".product-specimen");
    return (
      second.getBoundingClientRect().top - first.getBoundingClientRect().bottom
    );
  });
  expect(stateGap).toBeGreaterThan(pairGap * 2);
  // Sections are the only boundary that earns a rule.
  await expect(states).toHaveCSS("border-top-width", "1px");
});
