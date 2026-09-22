import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Native :focus-visible and CSS cascade require a real browser, not jsdom.
test("composer focus is keyboard-only and never draws a container ring", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-messages.html`,
    );
    const editor = page.getByRole("textbox", {
      name: "Message #design",
      exact: true,
    });
    const composer = page.locator("form").filter({ has: editor });
    const legacyButton = page.getByRole("button", {
      name: "Plugin on",
      exact: true,
    });
    const frame = () =>
      composer.evaluate((el) => {
        const style = getComputedStyle(el);
        return { border: style.borderColor, shadow: style.boxShadow };
      });
    for (const dark of [false, true]) {
      await page.evaluate((dark) => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.dataset.colorMode = dark ? "dark" : "light";
      }, dark);
      for (const width of [390, 820, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        await legacyButton.click();
        await expect(legacyButton).toHaveCSS("outline-style", "none");
        // Theme changes animate the border; capture only its settled value.
        await composer.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          );
        });
        const baseline = await frame();
        await editor.click();
        await expect(editor).toBeFocused();
        await expect(editor).toHaveCSS("outline-style", "none");
        await expect.poll(frame).toEqual(baseline);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(editor).toBeFocused();
        await expect(editor).toHaveCSS("outline-style", "solid");
        await expect.poll(frame).toEqual(baseline);
        // Pointer use clears keyboard styling, including subsequent programmatic focus.
        await legacyButton.click();
        await editor.focus();
        await expect(editor).toHaveCSS("outline-style", "none");
        await expect.poll(frame).toEqual(baseline);
      }
    }
  } finally {
    await server.close();
  }
});
