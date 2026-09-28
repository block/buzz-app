import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

// Browser boundary: actual layout/scroll anchoring and user demand over the real
// StrictMode session and ThreadPanel. Protocol permutations stay in owner tests.
test("older-page cue stays between root and replies while the request is held", async ({
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
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    await expect(replies).toHaveCount(10);
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    await history.hover();
    await page.mouse.wheel(0, -4000);
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(2);
    const cue = history.getByText("Loading older replies…", { exact: true });
    await cue.scrollIntoViewIfNeeded();
    await expect(cue).toBeVisible({ timeout: 2_000 });
    const position = await history.evaluate((element) => {
      const root = element.querySelector("[data-message-id]");
      const cue = element.querySelector('[role="status"]');
      const reply = element.querySelector("ol [data-message-id]");
      if (!root || !cue || !reply) return undefined;
      const rootBottom = root.getBoundingClientRect().bottom;
      const cueTop = cue.getBoundingClientRect().top;
      const cueBottom = cue.getBoundingClientRect().bottom;
      const replyTop = reply.getBoundingClientRect().top;
      const viewport = element.getBoundingClientRect();
      return {
        rootBottom,
        cueTop,
        cueBottom,
        replyTop,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
      };
    });
    expect(position).toBeDefined();
    expect(position.cueTop).toBeGreaterThanOrEqual(position.rootBottom);
    expect(position.cueBottom).toBeLessThanOrEqual(position.replyTop);
    expect(position.cueTop).toBeGreaterThanOrEqual(position.viewportTop);
    expect(position.cueBottom).toBeLessThanOrEqual(position.viewportBottom);
    expect(await replies.count()).toBe(10);
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    await expect(replies).toHaveCount(60);
    await expect(cue).toHaveCount(0);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseOlderPage())
      .catch(() => {});
    await server.close();
  }
});

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
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1`,
    );
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    await expect(replies).toHaveCount(10);
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
    await expect(replies).toHaveCount(60);
    await expect
      .poll(() =>
        history
          .locator(`[data-message-id="${id}"]`)
          .evaluate((el) => el.getBoundingClientRect().top),
      )
      .toBeCloseTo(before, 0);
    const top = await history.evaluate((el) => el.scrollTop);
    await page.evaluate(() => window.messagesFixture.live());
    await expect(replies).toHaveCount(61);
    await expect
      .poll(() => history.evaluate((el) => el.scrollTop))
      .toBeCloseTo(top, 0);
    // Demand each remaining older page. No automatic full-history waterfall.
    for (const count of [111, 161, 211, 261, 305]) {
      await history.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      await history.hover();
      await page.mouse.wheel(0, -300);
      await expect(replies).toHaveCount(count);
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
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("older page reveals a reparented visible reply without moving its viewport anchor", async ({
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
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?threadWindow=1&nestedWindow=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const child = history.getByText("Nested window child", { exact: true });
    await expect(history.locator("ol [data-message-id]")).toHaveCount(10);
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    await history.hover();
    await page.mouse.wheel(0, -4000);
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(2);
    await child.scrollIntoViewIfNeeded();
    await expect(child).toBeInViewport();
    const before = await child.evaluate((el) => el.getBoundingClientRect().top);
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    const parent = history.getByText("First root reply 292", { exact: true });
    await expect(parent).toBeVisible();
    await expect(child).toBeVisible();
    await expect(child).toBeInViewport();
    await expect
      .poll(() => child.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(before, -1);
    // Verify the reply moved under its real parent, not just that it remained flat.
    expect(
      await parent.evaluate((el) =>
        el.closest("li")?.textContent.includes("Nested window child"),
      ),
    ).toBe(true);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseOlderPage())
      .catch(() => {});
    await server.close();
  }
});
