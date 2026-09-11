import { test, expect } from "./fixture.mjs";
import { open, anchor, expectAnchor } from "./timeline.mjs";

const key = "buzz-appearance.v1";
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function settings(page) {
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Appearance").click();
}
async function expectMode(page, mode) {
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
  await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    mode === "dark" ? "rgb(17, 24, 29)" : "rgb(231, 240, 239)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    mode === "dark" ? "#11181d" : "#e7f0ef",
  );
}

test("Appearance changes and restores both modes, native keyboard controls, dialogs and narrow layout", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await expectMode(page, "light");
  await settings(page);
  const light = page.getByRole("radio", { name: "Light", exact: true });
  const dark = page.getByRole("radio", { name: "Dark", exact: true });
  await expect(light).toBeChecked();
  await light.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();
  await expectMode(page, "dark");
  expect(
    await page
      .locator(".shell-tab")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe("rgb(230, 237, 240)");
  await expect(button(page, "Appearance")).toHaveCSS(
    "background-color",
    "rgb(27, 37, 43)",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "dark",
  );
  for (const mode of ["dark", "light"]) {
    await page
      .getByRole("radio", {
        name: mode === "dark" ? "Dark" : "Light",
        exact: true,
      })
      .check();
    await expectMode(page, mode);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(
        page.getByRole("region", { name: "Appearance", exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`appearance-${mode}-${width}.png`),
      });
    }
    await button(page, "Find a page").click();
    const dialog = page.getByRole("dialog", { name: "Find a page" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS(
      "background-color",
      mode === "dark" ? "rgb(27, 37, 43)" : "rgb(255, 255, 255)",
    );
    await page.keyboard.press("Escape");
  }
  await dark.check();
  await page.reload();
  await expectMode(page, "dark");
  await settings(page);
  await expect(dark).toBeChecked();
});

test("storage denial is visible and retryable; another window updates a live conversation without remount", async ({
  page,
  context,
  app,
}, testInfo) => {
  await open(page, app);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Unsent appearance draft");
  const before = await anchor(page);
  const node = await composer.elementHandle();
  const sessions = [...app.report.sessions];
  await button(page, "Insert emoji").click();
  const emojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await emojiSearch.fill("grinning");
  const emojiNode = await emojiSearch.elementHandle();
  await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
    "data-theme",
    "light",
  );
  const other = await context.newPage();
  try {
    await other.goto(app.origin);
    await settings(other);
    await other.evaluate((key) => {
      const original = Storage.prototype.setItem;
      window.restoreStorage = () => {
        Storage.prototype.setItem = original;
      };
      Storage.prototype.setItem = function (k, v) {
        if (k === key) throw new DOMException("denied", "QuotaExceededError");
        return original.call(this, k, v);
      };
    }, key);
    await other.getByRole("radio", { name: "Dark", exact: true }).check();
    await expectMode(other, "dark");
    await expect(other.getByRole("alert")).toContainText("could not be saved");
    await expectMode(page, "light");
    await other.evaluate(() => window.restoreStorage());
    await button(other, "Retry saving appearance").click();
    await expect(other.getByRole("alert")).toHaveCount(0);
    await expectMode(page, "dark");
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await expect(emojiSearch).toHaveValue("grinning");
    expect(await emojiNode.evaluate((el) => el.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsent appearance draft");
    expect(await node.evaluate((el) => el.isConnected)).toBe(true);
    await expectAnchor(page, before);
    // The second window legitimately creates its own session; a mode change must not add a third.
    expect(app.report.sessions.length).toBe(sessions.length + 1);
    await page.screenshot({ path: testInfo.outputPath("messages-dark.png") });
    await other.getByRole("radio", { name: "Light", exact: true }).check();
    await expectMode(page, "light");
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "light",
    );
    await emojiSearch.press("Escape");
    await expectAnchor(page, before);
    await page.screenshot({ path: testInfo.outputPath("messages-light.png") });
  } finally {
    await other.close();
  }
});

test("saved dark document paints before the application module is allowed to execute", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.evaluate((key) => localStorage.setItem(key, "dark"), key);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(/\/assets\/.*\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(app.origin, { waitUntil: "commit" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      "rgb(17, 24, 29)",
    );
    expect(await page.locator("#root").innerHTML()).toBe("");
    // Observe the painted document for two frames with the entire React bundle still withheld.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      "rgb(17, 24, 29)",
    );
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expectMode(page, "dark");
});
