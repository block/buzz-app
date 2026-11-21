import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { cleanWebp } from "../../src/features/messages/image-metadata.ts";
import { test, expect } from "./source-fixture.mjs";

const animationPath = fileURLToPath(
  new URL("../fixtures/attachment-media/animated.webp", import.meta.url),
);
// The source fixture carries nested metadata; real uploads prepare it first.
const animationBytes = Buffer.from(
  await cleanWebp(
    new Uint8Array(readFileSync(animationPath)),
    true,
  ).arrayBuffer(),
);

// jsdom cannot prove native blob image decoding or the shared Avatar's visible
// still/foreground switching. Container and budget permutations stay in Vitest.
test("decodes a validated avatar blob and restores the still when motion stops", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/avatar-animation-original.webp", async (route) => {
    await held;
    await route.fulfill({ body: animationBytes, contentType: "image/webp" });
  });
  await page.goto("/tests/fixtures/avatar-animation.html");
  const avatar = page.getByRole("img", {
    name: "Responding agent",
    exact: true,
  });
  const still = avatar.locator('img[src$="/assets/avatar.png"]');
  await expect(still).toHaveAttribute("data-loaded", "true");
  await expect(still).toHaveCSS("opacity", "1");

  const originalRequested = page.waitForRequest(
    "**/avatar-animation-original.webp",
  );
  try {
    await page.getByRole("button", { name: "Start response" }).click();
    expect((await originalRequested).resourceType()).toBe("fetch");
    await expect(avatar.locator('img[src^="blob:"]')).toHaveCount(0);
    await expect(still).toHaveCSS("opacity", "1");
  } finally {
    release();
  }

  const animation = avatar.locator('img[src^="blob:"]');
  await expect(animation).toHaveAttribute("data-loaded", "true");
  await expect(animation).toHaveAttribute("data-avatar-foreground", "true");
  await expect
    .poll(() => animation.evaluate((image) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(animation).toHaveCSS("opacity", "1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(animation).toHaveCount(0);
  await expect(still).toHaveAttribute("data-loaded", "true");
  await expect(still).toHaveCSS("opacity", "1");
  await expect(still).toBeVisible();
});
