import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
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
  const formattingEditor = page.locator(".message-composer-editor");
  await formattingEditor.fill("selected tail");
  await formattingEditor.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.querySelector("p").firstChild, 0);
    range.setEnd(element.querySelector("p").firstChild, 2);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect
    .poll(() =>
      formattingEditor.evaluate((element) => ({
        start: element.richComposer.snapshot().selectionStart,
        end: element.richComposer.snapshot().selectionEnd,
      })),
    )
    .toEqual({ start: 0, end: 2 });
  const toggle = page.getByRole("button", {
    name: "Toggle formatting",
    exact: true,
  });
  await toggle.focus();
  await toggle.press("Enter");
  const closeFormatting = page.getByRole("button", {
    name: "Close formatting",
    exact: true,
  });
  await expect(closeFormatting).toBeFocused();
  await closeFormatting.press("Tab");
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  await expect(bold).toBeFocused();
  await bold.press("Enter");
  await expect(formattingEditor.locator("strong")).toHaveText("se");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await formattingEditor.evaluate((element) => {
    const selection = window.getSelection();
    selection.selectAllChildren(element);
    selection.collapseToEnd();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Link", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Link text").fill("_filename_");
  await dialog.getByLabel("Address").fill("javascript:alert(1)");
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("HTTPS");
  await expect(formattingEditor).toHaveText("selected tail");
  await dialog.getByLabel("Address").fill("https://example.com/hello world");
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(formattingEditor).toHaveText("selected tail");
  await dialog.getByLabel("Address").fill("buzz://channel/design");
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(formattingEditor.locator("a")).toHaveText("_filename_");
  await expect(formattingEditor.locator("a")).toHaveAttribute(
    "href",
    "buzz://channel/design",
  );
  await expect(formattingEditor.locator("a em")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close formatting", exact: true })
    .click();
  const composer = page.getByRole("form");
  await expect(composer).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(
    composer.getByRole("button", { name: "Mention a member" }),
  ).toHaveCount(0);
  await expect(composer.getByText("Shift + Enter for a new line")).toHaveCount(
    0,
  );
  const editor = composer.getByRole("textbox");
  await editor.fill("@Ali");
  await page
    .getByRole("option", { name: `Alice ${"a".repeat(64)}`, exact: true })
    .click();
  await expect(
    composer.getByRole("region", { name: "Notification recipients" }),
  ).toBeVisible();
  const send = composer.getByRole("button", { name: "Send message" });
  await expect(send).toHaveAttribute("data-icon-variant", "tint");
  await expect(send).toHaveCSS("background-color", "rgb(247, 237, 254)");
  for (const name of [
    "Attach file (not connected)",
    "Insert emoji",
    "Toggle formatting",
    "Record voice note (not connected)",
    "Send message",
  ]) {
    const button = composer.getByRole("button", { name, exact: true });
    await expect(button).toHaveAttribute("data-icon-size", "toolbar");
    await expect(button.locator("svg")).toHaveAttribute("width", "16");
  }
  await expect(
    composer.getByRole("button", { name: "Insert emoji" }),
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
