import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { settle, anchor, expectAnchor, end } from "./timeline.mjs";

test("delayed and failed images preserve bottom and reading anchors across remounts", async ({
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
  const pending = new Set();
  const requests = new Map();
  let held = true;
  async function release() {
    held = false;
    await Promise.all([...pending].map((resume) => resume()));
  }
  await page.route("https://image.test/**", async (route) => {
    const url = route.request().url();
    requests.set(url, (requests.get(url) ?? 0) + 1);
    if (held) await new Promise((resolve) => pending.add(resolve));
    // Routing deliberately disables HTTP cache: each remount can load late.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill(
      url.endsWith("/96.svg")
        ? { status: 404, body: "missing" }
        : {
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900"><rect width="700" height="900" fill="orange"/></svg>',
          },
    );
  });
  const feed = page.getByRole("region", { name: "Channel message history" });
  const gap = () =>
    feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  const loaded = () =>
    expect
      .poll(() =>
        feed.locator('a[aria-label="Open image attachment"] img').evaluateAll(
          (images) =>
            images.length > 0 &&
            images.every((img) => {
              const rect = img.getBoundingClientRect();
              const feed = img
                .closest("[data-channel-timeline]")
                .getBoundingClientRect();
              return (
                rect.bottom <= feed.top ||
                rect.top >= feed.bottom ||
                img.complete
              );
            }),
        ),
      )
      .toBe(true);
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/image-scroll.html`,
    );
    await expect.poll(() => pending.size).toBeGreaterThan(0);
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    const before = await feed.evaluate((el) => el.scrollHeight);
    await release();
    await loaded();
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    expect(await feed.evaluate((el) => el.scrollHeight)).toBe(before);
    // Reading above bottom survives decode; this must not be a force-bottom fix.
    held = true;
    pending.clear();
    await feed.hover();
    await page.mouse.wheel(0, -6000);
    await expect.poll(gap).toBeGreaterThan(5000);
    await expect.poll(() => pending.size).toBeGreaterThan(0);
    await settle(page);
    const reading = await anchor(page);
    await release();
    await loaded();
    await settle(page);
    await expectAnchor(page, reading);
    for (let i = 0; i < 3; i++) {
      await end(page);
      await loaded();
      await settle(page);
      expect(await gap()).toBeLessThan(4);
      await feed.hover();
      await page.mouse.wheel(0, -6000);
      await expect.poll(gap).toBeGreaterThan(5000);
      await loaded();
      await settle(page);
    }
    await end(page);
    await loaded();
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    expect(
      [...requests.values()].some((count) => count > 1),
      "images actually remounted and reloaded",
    ).toBe(true);
    // Responsive reservation stays bounded, including missing-metadata fallback.
    await page.setViewportSize({ width: 420, height: 950 });
    await settle(page);
    expect(await gap()).toBeLessThan(4);
    const bounds = await feed
      .locator('a[aria-label="Open image attachment"]')
      .evaluateAll((links) =>
        links.map((link) => ({
          width: link.getBoundingClientRect().width,
          parent: link.parentElement.getBoundingClientRect().width,
          height: link.getBoundingClientRect().height,
        })),
      );
    expect(bounds.length).toBeGreaterThan(0);
    for (const box of bounds) {
      expect(box.width).toBeLessThanOrEqual(box.parent);
      expect(box.height).toBeLessThanOrEqual(320);
      expect(box.height).toBeGreaterThan(0);
    }
  } finally {
    await release();
    await page.unrouteAll({ behavior: "wait" });
    await server.close();
  }
});
