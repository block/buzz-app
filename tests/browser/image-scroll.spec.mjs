import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { settle, anchor, expectAnchor } from "./timeline.mjs";

// Setup only: callers hold image responses until navigation has finished, then
// release them and assert stability without any corrective scrolling.
async function navigate(page, direction) {
  const feed = page.getByRole("region", { name: "Channel message history" });
  const gap = () =>
    feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  const reached = (distance) =>
    direction < 0 ? distance > 5000 : distance < 4;
  await feed.hover();
  for (let gesture = 0; gesture < 8; gesture++) {
    const before = await gap();
    if (reached(before)) break;
    const remaining = direction < 0 ? 6000 - before : before;
    await page.mouse.wheel(0, direction * Math.min(2000, remaining));
    // Drain a timed-out DOM read before the caller tears down its page.
    let pendingRead;
    try {
      await expect
        .poll(
          () =>
            (pendingRead = gap().then((after) => direction * (before - after))),
          { message: "image navigation gesture makes progress" },
        )
        .toBeGreaterThan(0);
    } finally {
      await pendingRead;
    }
    await settle(page);
  }
  expect(
    reached(await gap()),
    "bounded image navigation reaches its setup",
  ).toBe(true);
}

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
    const waiting = [...pending];
    pending.clear();
    await Promise.all(waiting.map((resume) => resume()));
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
    await navigate(page, -1);
    await expect.poll(() => pending.size).toBeGreaterThan(0);
    await settle(page);
    const reading = await anchor(page);
    await release();
    await loaded();
    await settle(page);
    await expectAnchor(page, reading);
    for (let i = 0; i < 3; i++) {
      held = true;
      await navigate(page, 1);
      await release();
      await loaded();
      await settle(page);
      expect(await gap()).toBeLessThan(4);
      held = true;
      await navigate(page, -1);
      await release();
      await loaded();
      await settle(page);
    }
    held = true;
    await navigate(page, 1);
    await release();
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

// Isolate the setup helper from image loading: partial input must converge, but
// blocked input must fail instead of turning the preservation checks into retries.
test("image navigation handles partial gestures and rejects blocked input", async ({
  page,
}) => {
  await page.setContent(`
    <section role="region" aria-label="Channel message history"
      style="height:700px;overflow:auto"><div style="height:14000px"></div></section>
  `);
  const wheel = page.mouse.wheel.bind(page.mouse);
  let gestures = 0;
  page.mouse.wheel = (x, y) => {
    gestures++;
    return wheel(x, Math.sign(y) * Math.min(1800, Math.abs(y)));
  };
  try {
    await navigate(page, 1);
    expect(gestures).toBeGreaterThan(1);
    expect(gestures).toBeLessThanOrEqual(8);
    gestures = 0;
    await navigate(page, -1);
    expect(gestures).toBeGreaterThan(1);
    expect(gestures).toBeLessThanOrEqual(8);
    await page.getByRole("region").evaluate((element) => {
      element.addEventListener("wheel", (event) => event.preventDefault(), {
        passive: false,
      });
    });
    gestures = 0;
    await expect(navigate(page, 1)).rejects.toThrow(
      "image navigation gesture makes progress",
    );
    expect(gestures).toBe(1);
  } finally {
    page.mouse.wheel = wheel;
  }
});
