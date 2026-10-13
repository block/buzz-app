import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { openPage, settleShellToggle } from "./navigation.mjs";

test.use({
  profilePicture: "https://images.example/avatar.png",
  historyCounts: { alpha: 1, beta: 1 },
});

// Real image scheduling, rendering frames and menu portals need browser coverage.
test("chat switches and profile menu openings show artwork or initials on the first frame", async ({
  page,
  app,
}) => {
  let release;
  let started = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("https://images.example/avatar.png", async (route) => {
    started++;
    await held;
    await route.fulfill({
      path: fileURLToPath(
        new URL("../fixtures/design-system/assets/avatar.png", import.meta.url),
      ),
      contentType: "image/png",
    });
  });
  await page.addInitScript(() => {
    window.avatarFirstFrames = [];
    const seen = new WeakSet();
    const observer = new MutationObserver(() => {
      for (const image of document.querySelectorAll(
        "[data-avatar-shape] > img",
      )) {
        if (seen.has(image)) continue;
        seen.add(image);
        requestAnimationFrame(() => {
          if (!image.isConnected) return;
          window.avatarFirstFrames.push({
            scope: image.closest("[data-message-id]")
              ? "message"
              : image.closest("[data-profile-menu]")
                ? "profile-menu"
                : "other",
            blank:
              getComputedStyle(image).opacity === "0" &&
              !image.parentElement.textContent.trim(),
          });
        });
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  try {
    await page.goto(app.origin, { waitUntil: "domcontentloaded" });
    await openPage(page, "Messages");
    await expect.poll(() => started).toBeGreaterThan(0);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const author = history.locator(".buzz-avatar").first();
    await expect(author).toHaveText("F");
    const profile = page.getByRole("button", {
      name: "Your profile",
      exact: true,
    });
    await profile.click();
    const menu = page.getByRole("menu", {
      name: "Fixture Reader",
      exact: true,
    });
    await expect(menu.locator(".buzz-avatar")).toHaveText("F");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.locator(".buzz-avatar img").first()).toHaveCSS(
    "opacity",
    "1",
  );

  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    for (const width of [1280, 600]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        (size) => {
          document.documentElement.style.fontSize = `${size}px`;
        },
        width === 600 ? 20 : 16,
      );
      await settleShellToggle(page);
      const show = page.getByRole("button", {
        name: "Show navigation",
        exact: true,
      });
      if (await show.isVisible()) await show.click();
      for (const channel of ["Beta", "Alpha"]) {
        await page.getByRole("button", { name: channel, exact: true }).click();
        await expect(
          page.getByRole("textbox", {
            name: `Message #${channel}`,
            exact: true,
          }),
        ).toBeVisible();
        const avatar = page
          .getByRole("region", { name: "Channel message history" })
          .locator(".buzz-avatar")
          .first();
        await expect(avatar.locator("img")).toHaveCSS("opacity", "1");
        await expect(avatar).toHaveText("");
        if (width === 600 && channel === "Beta") {
          await page
            .getByRole("button", { name: "Show navigation", exact: true })
            .click();
        }
      }
      const profile = page.getByRole("button", {
        name: "Your profile",
        exact: true,
      });
      await profile.focus();
      await profile.press("Enter");
      const menu = page.getByRole("menu", {
        name: "Fixture Reader",
        exact: true,
      });
      await expect(menu.locator(".buzz-avatar img")).toHaveCSS("opacity", "1");
      await expect(menu.locator(".buzz-avatar")).toHaveText("");
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(profile).toBeFocused();
    }
  }
  const frames = await page.evaluate(() => window.avatarFirstFrames);
  expect(frames.some((frame) => frame.scope === "message")).toBe(true);
  expect(frames.some((frame) => frame.scope === "profile-menu")).toBe(true);
  expect(frames.every((frame) => !frame.blank)).toBe(true);
  app.report.avatarFirstFrames = frames;
});
