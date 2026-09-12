import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("presence: viewport demand, equal-status silence, conflict repair and teardown", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await server.listen();
  try {
    const started = Date.now();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/presence.html`,
    );
    const timeline = page.getByRole("region", { name: "Presence timeline" });
    await expect(timeline).toBeVisible();
    await expect(
      timeline.locator('[data-presence-status="online"]').first(),
    ).toBeVisible();
    const initial = await page.evaluate(() => ({
      ...window.presenceFixture.report,
      ...window.presenceFixture.diagnostics(),
    }));
    expect(initial.handles).toBe(1);
    expect(initial.authors).toBeGreaterThan(0);
    expect(initial.authors).toBeLessThanOrEqual(20);
    const before = initial.notifications;
    await page.evaluate(() => window.presenceFixture.heartbeat(10));
    const renewed = await page.evaluate(() => ({
      ...window.presenceFixture.report,
      ...window.presenceFixture.diagnostics(),
    }));
    expect(renewed.notifications).toBe(before);
    expect(renewed.reads).toBe(initial.reads);
    await page.evaluate(() => {
      window.presenceFixture.status("offline");
      window.presenceFixture.heartbeat(1, "offline");
    });
    await expect(
      timeline.locator('[data-presence-status="offline"]').first(),
    ).toBeVisible();
    await page.evaluate(() => window.presenceFixture.heartbeat(1, "online"));
    await expect(
      timeline.locator('[data-presence-status="online"]'),
    ).toHaveCount(0);
    await expect(
      timeline.locator('[data-presence-status="offline"]').first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Toggle timeline" }).click();
    await expect(timeline).toHaveCount(0);
    const disposed = await page.evaluate(() =>
      window.presenceFixture.diagnostics(),
    );
    expect(disposed.handles).toBe(0);
    expect(disposed.authors).toBe(0);
    await page.getByRole("button", { name: "Toggle timeline" }).click();
    await expect(timeline).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.presenceFixture.diagnostics().handles),
      )
      .toBe(1);
    await timeline.evaluate((element) => {
      element.scrollTop = 12000;
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.presenceFixture.diagnostics().authors),
      )
      .toBeGreaterThan(0);
    await testInfo.attach("presence-counters.json", {
      body: JSON.stringify(
        {
          elapsedMs: Date.now() - started,
          initial,
          renewed,
          disposed,
          final: await page.evaluate(() => window.presenceFixture.report),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    await page.evaluate(() => window.presenceFixture.dispose());
  } finally {
    await server.close();
  }
});
