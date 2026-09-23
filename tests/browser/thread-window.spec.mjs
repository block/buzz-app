import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Browser boundary: actual layout/scroll anchoring and user demand over the real
// StrictMode session and ThreadPanel. Protocol permutations stay in owner tests.
test("newest window positions immediately; scrollback preserves the visible reply and live following", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1`,
    );
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", { name: "Thread messages" });
    await expect(
      panel.getByText("50 replies shown", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(
      panel.getByText("First root reply 302", { exact: true }),
    ).toBeInViewport();
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect.poll(gap).toBeLessThan(2);
    const initial = await page.evaluate(
      () => window.messagesFixture.report.filters,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0].thread_window).toBe(true);
    // A user gesture, not mounting or live reflow, asks for older history.
    await history.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    const anchor = history.locator("ol [data-message-id]").first();
    const id = await anchor.getAttribute("data-message-id");
    const before = await anchor.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    await history.hover();
    await page.mouse.wheel(0, -300);
    await expect(
      panel.getByText("100 replies shown", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        history
          .locator(`[data-message-id="${id}"]`)
          .evaluate((el) => el.getBoundingClientRect().top),
      )
      .toBeCloseTo(before, 0);
    const top = await history.evaluate((el) => el.scrollTop);
    await page.evaluate(() => window.messagesFixture.live());
    await expect(
      panel.getByText("101 replies shown", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => history.evaluate((el) => el.scrollTop))
      .toBeCloseTo(top, 0);
    // Demand each remaining older page. No automatic full-history waterfall.
    for (const count of [151, 201, 251, 301, 305]) {
      await history.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      await history.hover();
      await page.mouse.wheel(0, -300);
      await expect(
        panel.getByText(`${count} replies shown`, { exact: true }),
      ).toBeVisible();
    }
    expect(await history.locator("ol [data-message-id]").count()).toBe(305);
    const ids = await history
      .locator("ol [data-message-id]")
      .evaluateAll((rows) => rows.map((r) => r.dataset.messageId));
    expect(new Set(ids).size).toBe(305);
    expect(
      (await page.evaluate(() => window.messagesFixture.report.filters)).every(
        (f) => f.thread_window && f.thread_cursor === undefined,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
