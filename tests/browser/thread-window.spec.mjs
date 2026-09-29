import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";
import { wheel } from "./timeline.mjs";

test("reconnect repair failure keeps retry reachable at the newest replies", async ({
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
    await expect
      .poll(() =>
        history.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(2);
    await page.evaluate(() => window.messagesFixture.holdReconnectRepair());
    // The held root read is the actual session reconnect repair, not scrollback.
    await expect(history.getByText("Loading thread…")).toBeVisible();
    await expect(history.getByText("Loading older replies…")).toHaveCount(0);
    await page.evaluate(() => window.messagesFixture.releaseReconnectRepair());
    const error = history.getByRole("alert");
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(error).toContainText("Retained range repair failed");
    await expect(retry).toBeInViewport();
    await expect(replies).toHaveCount(10);
    await retry.click();
    await expect(error).toHaveCount(0);
    // The click can scroll to the button and legitimately demand an older page;
    // recovery must retain the newest reply regardless of that extra request.
    await expect(
      history.getByText("First root reply 302", { exact: true }),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
  } finally {
    await page
      .evaluate(() => window.messagesFixture.releaseReconnectRepair())
      .catch(() => {});
    await server.close();
  }
});

test("older-page retry repeats the failed continuation at the scrollback cue", async ({
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
    await history.hover();
    await page.mouse.wheel(0, -4000);
    await expect(replies).toHaveCount(60);
    await page.evaluate(() => window.messagesFixture.failOlderPages(2));
    // Re-establish the scrollback boundary after the first page settles. One
    // wheel step alone can stop mid-history in WebKit's hosted viewport.
    await history.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await history.hover();
    await page.mouse.wheel(0, -300);
    const error = history.getByRole("alert");
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(error).toContainText("Older page failed");
    await expect(retry).toBeInViewport();
    await retry.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(4);
    await expect(error).toContainText("Older page failed");
    await expect(retry).toBeInViewport();
    await retry.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(5);
    await expect(replies).toHaveCount(110);
    await expect(retry).toHaveCount(0);
    const filters = await page.evaluate(
      () => window.messagesFixture.report.filters,
    );
    expect(filters).toHaveLength(5);
    expect(filters[2].until).toBeDefined();
    for (const filter of filters.slice(3)) {
      expect(filter.until).toBe(filters[2].until);
      expect(filter.before_id).toBe(filters[2].before_id);
    }
  } finally {
    await server.close();
  }
});

test("legacy continuation failure exposes recovery after retained replies", async ({
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
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html?failLegacyContinuation=1`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const replies = history.locator("ol [data-message-id]");
    // The first page is started on mount; the next page is a separate read.
    await expect(replies).toHaveCount(50);
    const error = history.getByRole("alert");
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(error).toContainText("Legacy continuation failed");
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(replies).toHaveCount(61);
    await expect(error).toHaveCount(0);
  } finally {
    await server.close();
  }
});

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
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    // The wheel may still move the viewport after dispatch. Measure only after
    // the continuation is pending, then release it to isolate prepend geometry.
    await history.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await history.hover();
    await wheel(page, -300, history);
    await expect(history.getByText("Loading older replies…")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(2);
    const continuation = await page.evaluate(
      () => window.messagesFixture.report.filters[1],
    );
    expect(continuation.thread_window).toBe(true);
    expect(continuation.until).toBeDefined();
    expect(continuation.before_id).toBeDefined();
    // Preserve the reader's place, not an exact CSS-pixel offset: browser scroll
    // rounding may move a row slightly, but a row-sized jump changes the reply
    // at this fixed reading point. Choose a row well inside the viewport.
    const reading = await history.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll("ol [data-message-id]")];
      const row = rows
        .filter((item) => {
          const bounds = item.getBoundingClientRect();
          return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
        })
        .reduce((nearest, item) => {
          const distance = (candidate) => {
            const bounds = candidate.getBoundingClientRect();
            return Math.abs(
              (bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2,
            );
          };
          return !nearest || distance(item) < distance(nearest)
            ? item
            : nearest;
        }, null);
      if (!row) throw new Error("No complete reply near the reading point");
      const bounds = row.getBoundingClientRect();
      return {
        id: row.dataset.messageId,
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
        before: { top: bounds.top, bottom: bounds.bottom },
      };
    });
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    await expect(replies).toHaveCount(60);
    await expect
      .poll(
        () =>
          history.evaluate((el, reading) => {
            const hit = document
              .elementFromPoint(reading.x, reading.y)
              ?.closest("ol [data-message-id]");
            const expected = [
              ...el.querySelectorAll("ol [data-message-id]"),
            ].find((row) => row.dataset.messageId === reading.id);
            const bounds = expected?.getBoundingClientRect();
            return {
              id: hit && el.contains(hit) ? hit.dataset.messageId : null,
              before: reading.before,
              after: bounds && { top: bounds.top, bottom: bounds.bottom },
            };
          }, reading),
        { message: `reply at fixed reading point remains ${reading.id}` },
      )
      .toMatchObject({ id: reading.id });
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
    await page
      .evaluate(() => window.messagesFixture.releaseOlderPage())
      .catch(() => {});
    await server.close();
  }
});

test("older-page retry reveals a late parent without hiding the reading anchor", async ({
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
    const replies = history.locator("ol [data-message-id]");
    const child = history.getByText("Nested window child", { exact: true });
    await expect(replies).toHaveCount(10);
    await page.evaluate(() => window.messagesFixture.failOlderPages(1));
    await history.hover();
    await wheel(page, -4000, history);
    const retry = history.getByRole("button", { name: "Retry thread" });
    await expect(history.getByRole("alert")).toContainText("Older page failed");
    await child.scrollIntoViewIfNeeded();
    await expect(child).toBeInViewport();
    await page.evaluate(() => window.messagesFixture.holdOlderPage());
    await retry.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.filters.length),
      )
      .toBe(3);
    await child.scrollIntoViewIfNeeded();
    await expect(child).toBeInViewport();
    const before = await child.evaluate((el) => el.getBoundingClientRect().top);
    await page.evaluate(() => window.messagesFixture.releaseOlderPage());
    const parent = history.getByText("First root reply 292", { exact: true });
    await expect(parent).toBeVisible();
    await expect(child).toBeInViewport();
    await expect(replies).toHaveCount(60);
    await expect
      .poll(() => child.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(before, -1);
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
    await wheel(page, -4000, history);
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
