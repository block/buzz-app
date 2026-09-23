import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("reaction plus opens a visible emoji-only picker, restores focus and publishes custom emoji", async ({
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
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/emoji-media/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
      }),
    );
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/emoji.html?reactions`,
    );
    const root = page
      .locator("[data-message-id]")
      .filter({ hasText: "Historic" });
    const plus = root.getByRole("button", {
      name: "Add reaction",
      exact: true,
    });
    // Every message exposes first-reaction controls, not just previously reacted rows.
    await expect(
      page.getByRole("button", { name: "Add reaction", exact: true }),
    ).toHaveCount(6);
    await root.hover();
    await plus.click();
    const search = page.locator('em-emoji-picker input[type="search"]');
    await expect(search).toBeVisible();
    await search.hover();
    await search.focus();
    await expect(
      root.getByRole("group", { name: "Message actions" }),
    ).toHaveCSS("opacity", "1");
    const padding = await search.evaluate((input) => {
      const field = input.getBoundingClientRect();
      const picker = input
        .getRootNode()
        .querySelector("#root")
        .getBoundingClientRect();
      return {
        top: field.top - picker.top,
        left: field.left - picker.left,
        right: picker.right - field.right,
      };
    });
    expect(padding.top).toBeCloseTo(padding.left, 1);
    expect(padding.top).toBeCloseTo(padding.right, 1);
    await expect(search).toHaveCSS("border-radius", "10px");
    await expect(
      page.getByRole("tab", { name: "GIF", exact: true }),
    ).toHaveCount(0);
    await search.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(plus).toBeFocused();
    await root.hover();
    await plus.click();
    await search.fill("party");
    const custom = page
      .locator("em-emoji-picker button")
      .filter({ has: page.locator('img[src*="1.png"]') })
      .first();
    await expect(custom).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("reaction-picker.png"),
    });
    await custom.click();
    await expect(search).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.publications.length),
      )
      .toBe(1);
    const event = await page.evaluate(
      () => window.emojiFixture.report.publications[0].event,
    );
    expect(event.kind).toBe(7);
    expect(event.content).toBe(":party:");
    expect(event.tags).toContainEqual([
      "emoji",
      "party",
      "https://a.test/media/1.png",
    ]);
    expect(event.tags.filter(([name]) => name === "e")).toHaveLength(1);
    for (const length of [62, 63, 64]) {
      await root.hover();
      await plus.click();
      const boundarySearch = page.locator(
        'em-emoji-picker input[type="search"]',
      );
      const shortcode = "a".repeat(length);
      await boundarySearch.fill(shortcode);
      await page
        .getByRole("button", { name: `:${shortcode}:`, exact: true })
        .click();
    }
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.publications.length),
      )
      .toBe(4);
    await page.evaluate(() => window.emojiFixture.archive(true));
    await expect(plus).toHaveCount(0);
    await page.evaluate(() => window.emojiFixture.archive(false));
    await expect(plus).toHaveCount(1);
    await root.hover();
    const boundaryEvents = await page.evaluate(() =>
      window.emojiFixture.report.publications
        .slice(1)
        .map(({ event }) => event),
    );
    expect(boundaryEvents.map(({ content }) => content)).toEqual(
      [62, 63, 64].map((length) => `:${"a".repeat(length)}:`),
    );
    expect(boundaryEvents.every(({ kind }) => kind === 7)).toBe(true);
    await page.evaluate(() => window.emojiFixture.rejectReaction());
    await root.hover();
    await plus.click();
    await page
      .locator("em-emoji-picker button")
      .filter({ has: page.locator('img[src*="1.png"]') })
      .first()
      .click();
    const retry = page.getByRole("button", { name: "Retry reaction" });
    await expect(retry).toBeVisible();
    await page.evaluate(() => window.emojiFixture.remount());
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.publications.length),
      )
      .toBe(5);
    const removal = await page.evaluate(
      () => window.emojiFixture.report.publications[4].event,
    );
    expect(removal.kind).toBe(5);
    expect(removal.tags).toContainEqual(["e", event.id]);
    await expect(
      root.getByRole("button", {
        name: ":party:: 1 person, including you",
        exact: true,
      }),
    ).toHaveCount(0);
    // Joining an old custom-emoji group retains its event-local URL, not the new palette URL.
    await root
      .getByRole("button", { name: ":party:: 1 person", exact: true })
      .click();
    await expect(
      root.getByRole("button", {
        name: ":party:: 2 people, including you",
        exact: true,
      }),
    ).toBeVisible();
    const joined = await page.evaluate(
      () => window.emojiFixture.report.publications.at(-1).event,
    );
    expect(joined.tags).toContainEqual([
      "emoji",
      "party",
      "https://a.test/media/reaction.png",
    ]);
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await root.hover();
      const box = await root
        .getByRole("group", { name: "Message actions" })
        .boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
