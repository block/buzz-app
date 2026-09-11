import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("real xterm retains output across detach, handles input and resize, and releases app shortcut", async ({
  page,
}) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal.html`,
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    const input = page.getByLabel("Input", { exact: true });
    const splash = page.locator("[data-terminal-splash]");
    await expect(splash).toHaveCount(0); // Wait for actual shell output.
    await button("Paint terminal").click();
    await expect(splash).toBeVisible();
    await expect(splash.locator('[data-layer="head"]')).not.toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    const rightEdge = await splash.evaluate((element) => {
      const xs = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        for (let i = 0; i < text.length; i++) {
          if (!"▜▐▟".includes(text.textContent[i])) continue;
          const range = document.createRange();
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          xs.push(range.getBoundingClientRect().x);
        }
      }
      return xs;
    });
    expect(rightEdge.length).toBeGreaterThan(5);
    expect(Math.max(...rightEdge) - Math.min(...rightEdge)).toBeLessThan(1);

    const colors = await splash
      .locator('[data-layer="head"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).color),
      );
    expect(new Set(colors).size).toBeGreaterThan(8);
    await expect(splash).toHaveCSS("--splash-lightness", "72%");
    await expect(splash).toHaveCSS("--splash-chroma", "0.12");
    await page.screenshot({
      path: test.info().outputPath("buzzterm-light.png"),
    });
    const xterm = page.locator(".xterm-viewport");
    const assertAnsiContrast = async () => {
      for (const text of [
        "ANSI_WHITE_ON_BLACK",
        "ANSI_WHITE_ON_GRAY",
        "ANSI_WHITE_ON_DEFAULT",
        "ANSI_BLACK_ON_DEFAULT",
      ]) {
        const ratio = await page
          .getByText(text, { exact: true })
          .evaluate((el) => {
            const css = getComputedStyle(el);
            const luminance = (color) => {
              const rgb = color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number)
                .map((v) => {
                  const s = v / 255;
                  return s <= 0.04045
                    ? s / 12.92
                    : ((s + 0.055) / 1.055) ** 2.4;
                });
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const fg = luminance(css.color);
            const background =
              css.backgroundColor === "rgba(0, 0, 0, 0)"
                ? getComputedStyle(document.querySelector(".xterm-viewport"))
                    .backgroundColor
                : css.backgroundColor;
            const bg = luminance(background);
            return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
          });
        expect(ratio, `${text} foreground/background contrast`).toBeGreaterThan(
          4.5,
        );
      }
    };
    await assertAnsiContrast();
    const lightBackground = await xterm.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await button("Toggle theme").click();
    await expect
      .poll(() => xterm.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(lightBackground);
    await expect(splash).toHaveCSS("--splash-lightness", "80%");
    await expect(splash).toHaveCSS("--splash-chroma", "0.16");
    await assertAnsiContrast();
    await page.screenshot({
      path: test.info().outputPath("buzzterm-dark.png"),
    });
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);

    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("hello");
    await expect(splash).toHaveCount(0);

    await page.keyboard.press("Control+c");
    await expect(input).toHaveText('"hello\\u0003"');
    await button("Alternate screen").click();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    const fontSize = await page
      .locator(".xterm-rows")
      .evaluate((el) => getComputedStyle(el).fontSize);
    await button("Enlarge text").click();
    await expect
      .poll(() =>
        page
          .locator(".xterm-rows")
          .evaluate((el) => getComputedStyle(el).fontSize),
      )
      .not.toBe(fontSize);
    const dimensions = await page.getByLabel("Dimensions").textContent();
    await page.setViewportSize({ width: 800, height: 600 });
    await expect(page.getByLabel("Dimensions")).not.toHaveText(dimensions);
    await button("Toggle mount").click();
    await expect(page.locator(".xterm")).toHaveCount(0);
    await button("Paint terminal").click(); // Parse output while detached.
    await button("Toggle theme").click(); // Reopen must pick up hidden appearance changes.
    await button("Toggle mount").click();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    await expect(splash).toHaveCount(0);
    await expect
      .poll(() => xterm.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(lightBackground);
    await page.locator(".xterm-helper-textarea").focus();
    const before = await input.textContent();
    const modifier = (await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform),
    ))
      ? "Meta"
      : "Control";
    await page.evaluate(() => {
      window.terminalChord = false;
      window.addEventListener("keydown", (e) => {
        if (e.key === "j") window.terminalChord = !e.defaultPrevented;
      });
    });
    await page.keyboard.press(`${modifier}+j`);
    expect(await page.evaluate(() => window.terminalChord)).toBe(true);
    await expect(input).toHaveText(before);
    // Fresh dark startup, bounded static splash (including reduced motion).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await button("Toggle theme").click();
    await button("Paint terminal").click();
    await expect(splash).toBeVisible();
    await expect(splash).toHaveCSS("animation-name", "none");
    await page.waitForTimeout(2000);
    await expect(splash).toBeVisible();
    await expect(splash).toHaveCount(0, { timeout: 1700 }); // 3s, not the old 4.5s.
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    // Small terminals retain readable branding instead of clipped block art.
    await page.setViewportSize({ width: 400, height: 600 });
    await page.reload();
    await button("Paint terminal").click();
    await expect(splash).toHaveText("buzz term");
    await button("Toggle mount").click();
    await button("Toggle theme").click();
    await button("Toggle mount").click();
    await expect(splash).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
