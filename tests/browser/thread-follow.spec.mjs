import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Real Virtua measurement, wheel scrolling, and delayed row growth require a browser.
test("thread follow respects a small upward gesture, indicates arrivals, and resumes at the end", async ({
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
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html`,
    );
    const history = page.getByRole("region", { name: "Thread messages" });
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect(history).not.toHaveAttribute("data-positioning");
    await expect.poll(gap).toBeLessThan(2);
    // Cross Virtua's 150ms retained target lifetime; this duration is the behavior
    // boundary, not a substitute for waiting on visible positioning above.
    await history.evaluate(
      () =>
        new Promise((resolve) => {
          const start = performance.now();
          const sample = () =>
            performance.now() - start > 250
              ? resolve()
              : requestAnimationFrame(sample);
          sample();
        }),
    );
    await history.hover();
    await page.mouse.wheel(0, -40);
    await expect(
      history.getByRole("button", { name: "Jump to latest" }),
    ).toBeVisible();
    await expect.poll(gap).toBeGreaterThan(30);
    const before = await history.evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
    }));
    // Synthetic geometry deliberately exercises late growth with no React update.
    await history.evaluate((el) => {
      const row = [...el.querySelectorAll("ol [data-message-id]")].at(-1);
      const media = document.createElement("div");
      media.style.height = "200px";
      row.appendChild(media);
    });
    await expect
      .poll(() => history.evaluate((el) => el.scrollHeight))
      .toBeGreaterThan(before.height + 150);
    await page.evaluate(() =>
      window.messagesFixture.live("A reply while reading"),
    );
    const jump = history.getByRole("button", { name: "1 new message" });
    await expect(jump).toBeVisible();
    expect(await history.evaluate((el) => el.scrollTop)).toBe(before.top);
    await jump.click();
    await expect.poll(gap).toBeLessThan(2);
    await expect(
      history.getByText("A reply while reading", { exact: true }),
    ).toBeInViewport();
    await page.evaluate(() =>
      window.messagesFixture.live("A reply while following"),
    );
    await expect(
      history.getByText("A reply while following", { exact: true }),
    ).toBeInViewport();
    await expect.poll(gap).toBeLessThan(2);
    await expect(
      history.getByRole("button", { name: /Jump to latest|new message/ }),
    ).toHaveCount(0);
  } finally {
    await server.close();
  }
});
