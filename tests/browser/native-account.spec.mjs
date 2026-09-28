import { test, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createServer } from "./vite-server.mjs";

// Browser-only boundary: modal focus/Escape restoration and painted narrow/wide
// light/dark geometry. Credential rules, cancellation matrices and IPC live in unit/native tests.
test("existing-account prerequisite keeps focus and disclosure honest across layouts", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    envDir: false,
    plugins: [react()],
    optimizeDeps: { entries: ["tests/fixtures/native-account.html"] },
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/native-account.html`,
    );
    const open = page.getByRole("button", {
      name: "Connect existing account",
      exact: true,
    });
    await expect(open).toBeVisible();
    expect(await page.evaluate(() => window.accountFixture.calls)).toEqual([]);
    await open.click();
    const dialog = page.getByRole("dialog", {
      name: "Use an existing Buzz account",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Expected public key", { exact: true })
      .fill("a".repeat(64));
    await dialog
      .getByLabel("Relay URL", { exact: true })
      .fill("https://relay.example");
    await dialog
      .getByRole("button", { name: "Connect existing account", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.accountFixture.calls))
      .toEqual(["begin", "run"]);
    await expect(
      dialog.getByRole("button", { name: "Cancel check" }),
    ).toBeEnabled();
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const submit = dialog.getByRole("button", {
          name: "Connect existing account",
        });
        await submit.scrollIntoViewIfNeeded();
        await expect(submit).toBeInViewport();
        const box = await dialog.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`native-account-${mode}-${width}.png`),
        });
      }
    }
    await dialog.getByRole("button", { name: "Cancel check" }).focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    await page.evaluate(() => window.accountFixture.finish());
    await open.click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("Native connection open for this session."),
    ).toHaveCount(0);
    await dialog
      .getByLabel("Expected public key", { exact: true })
      .fill("a".repeat(64));
    await dialog
      .getByLabel("Relay URL", { exact: true })
      .fill("https://relay.example");
    await dialog
      .getByRole("button", { name: "Connect existing account" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.accountFixture.calls.filter((s) => s === "run").length,
        ),
      )
      .toBe(2);
    await page.evaluate(() => window.accountFixture.finish());
    await expect(
      dialog.getByText("Native connection open for this session."),
    ).toBeVisible();
    await expect(
      dialog.getByText(/Membership is checked by the relay/),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
