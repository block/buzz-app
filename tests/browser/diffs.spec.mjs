import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Real table geometry/scroll containment, modal portal/focus return and theme
// rendering need a browser. Patch matrices and plugin failures stay in Vitest.
test("diff preview expands in both layouts and keeps focus and scroll containment", async ({
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
  try {
    await server.listen();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/diffs.html`,
    );
    const expand = page.getByRole("button", {
      name: "Expand diff",
      exact: true,
    });
    await expect(expand).toHaveCount(1);
    await expect(page.locator("table.diff-unified")).toBeVisible();
    await expand.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("table.diff-unified")).toBeVisible();
    const unified = dialog.getByRole("button", {
      name: "Unified",
      exact: true,
    });
    const split = dialog.getByRole("button", { name: "Split", exact: true });
    await expect(unified).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.locator("tr").first().locator("td")).toHaveCount(3);
    await split.click();
    await expect(split).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.locator("tr").first().locator("td")).toHaveCount(4);
    const cells = await dialog
      .locator("tr")
      .first()
      .locator("td")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
    expect(cells[3]).toBeGreaterThan(cells[1]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(expand).toBeFocused();
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expand.click();
    await split.click();
    await expect(dialog).toHaveAttribute("data-size", "expanded");
    await expect
      .poll(() => dialog.evaluate((e) => e.scrollWidth <= e.clientWidth))
      .toBe(true);
    const file = dialog.locator("section");
    await expect
      .poll(() => file.evaluate((e) => e.scrollWidth > e.clientWidth))
      .toBe(true);
    await file.evaluate((e) => {
      e.scrollLeft = e.scrollWidth;
    });
    await expect
      .poll(() => file.evaluate((e) => e.scrollLeft))
      .toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Close diff" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(expand).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
