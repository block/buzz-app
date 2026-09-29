import { expect, test } from "@playwright/test";
import { preview } from "vite";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

// A real mounted member dialog and shared session, but no relay or external write.
test("identity copy preserves modal focus and addition returns focus only to its owner", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "buzz-focus-"));
  let server;
  try {
    const config = {
      root,
      configFile: false,
      envFile: false,
      logLevel: "error",
      plugins: [react()],
      build: {
        rollupOptions: {
          input: join(root, "tests/browser/channel-members-focus.html"),
        },
        outDir: join(directory, "dist"),
        emptyOutDir: true,
      },
    };
    await build(config);
    server = await preview({
      ...config,
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/channel-members-focus.html`;
    for (const moved of [false, true]) {
      await page.goto(url);
      await page.getByRole("button", { name: "Channel members" }).click();
      const dialog = page.getByRole("dialog", { name: "Channel members" });
      const search = dialog.getByRole("searchbox");
      await search.fill("Morgan");
      const add = dialog.getByRole("button", { name: /Add Morgan/ });
      await expect(add).toBeEnabled();
      if (!moved) {
        await page.evaluate(() => {
          window.copiedNpubs = [];
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (value) => window.copiedNpubs.push(value),
            },
          });
        });
        await dialog.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations({ subtree: true }).map((a) => a.finished),
          );
        });
        const before = await add.boundingBox();
        await add.hover({ position: { x: 20, y: 20 } });
        const card = page.getByRole("dialog", {
          name: "Morgan identity",
          exact: true,
        });
        await expect(card).toBeVisible();
        const npub = (await add.getAttribute("aria-label")).match(
          /npub1[a-z0-9]+/,
        )[0];
        await expect(card).toContainText(npub);
        await expect(card.getByText("Public key", { exact: true })).toHaveCount(
          0,
        );
        expect(await add.boundingBox()).toEqual(before);
        const copy = card.getByRole("button", {
          name: "Copy npub",
          exact: true,
        });
        // Hit testing proves the positioned portal is above the modal/backdrop.
        await copy.click();
        await expect
          .poll(() => page.evaluate(() => window.copiedNpubs))
          .toEqual([npub]);
        await expect(add).toBeEnabled();
        await page.mouse.move(0, 0);
        await search.focus();
        await expect(card).not.toBeVisible();
        // Hold the hover/focus delay: rapid Tab must not require a pause.
        await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
        await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
        try {
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          await expect(copy).toBeFocused();
        } finally {
          await page.clock.resume();
        }
        await expect(card).toBeVisible();
        await expect(add).toHaveAttribute(
          "aria-details",
          await card.getAttribute("id"),
        );
        await expect(add).toHaveAccessibleDescription(/Tab to reach Copy npub/);
        await expect(add).not.toHaveAttribute("aria-haspopup");
        await page.keyboard.press("Enter");
        await expect
          .poll(() => page.evaluate(() => window.copiedNpubs))
          .toEqual([npub, npub]);
        await page.keyboard.press("Shift+Tab");
        await expect(add).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(copy).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(
          dialog.getByRole("button", { name: "Close channel members" }),
        ).toBeFocused();
        await expect(card).not.toBeVisible();
        await page.keyboard.press("Shift+Tab");
        await expect(add).toBeFocused();
        await expect(card).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(copy).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(card).not.toBeVisible();
        await expect(dialog).toBeVisible();
        await expect(add).toBeFocused();
        await expect(add).not.toHaveAttribute("aria-details");
        await page.keyboard.press("Tab");
        await expect(
          dialog.getByRole("button", { name: "Close channel members" }),
        ).toBeFocused();
      }
      await add.focus();
      await page.keyboard.press("Enter");
      await page.evaluate(() => window.focusFixture.published);
      await expect(add).toHaveAttribute("aria-disabled", "true");
      await expect(add).toBeFocused();
      if (moved)
        await dialog
          .getByRole("button", { name: "Close channel members" })
          .focus();
      await page.evaluate(() => window.focusFixture.confirm());
      await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
      await expect(
        moved
          ? dialog.getByRole("button", { name: "Close channel members" })
          : search,
      ).toBeFocused();
    }
    await page.goto(url);
    await page.getByRole("button", { name: "Edit team", exact: true }).click();
    const team = page.getByRole("dialog", { name: "Team", exact: true });
    const checkbox = team.getByRole("checkbox", { name: /Morgan/ });
    const card = page.getByRole("dialog", {
      name: "Morgan identity",
      exact: true,
    });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.className = mode;
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      for (const width of [390, 800, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await checkbox.hover();
        await expect(card).toBeVisible();
        await expect(card).toContainText("Owner unavailable");
        await card.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((a) => a.finished));
        });
        const bounds = await card.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: testInfo.outputPath(`identity-${mode}-${width}.png`),
        });
        await page.mouse.move(0, 0);
        await team.getByRole("textbox").focus();
        await expect(card).not.toBeVisible();
      }
    }
    await team.getByRole("textbox").focus();
    await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
    try {
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(
        card.getByRole("button", { name: "Copy npub" }),
      ).toBeFocused();
    } finally {
      await page.clock.resume();
    }
    await expect(checkbox).toHaveAccessibleDescription(
      /Tab to reach Copy npub/,
    );
    await expect(checkbox).toHaveAttribute(
      "aria-details",
      await card.getAttribute("id"),
    );
    await expect(checkbox).not.toHaveAttribute("aria-haspopup");
    await page.keyboard.press("Escape");
    await expect(card).not.toBeVisible();
    await expect(checkbox).toBeFocused();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    if (server)
      await new Promise((resolve) => server.httpServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
