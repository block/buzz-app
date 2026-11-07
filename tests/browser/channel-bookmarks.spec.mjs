import { test, expect } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-bookmarks-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/channel-bookmarks.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/channel-bookmarks.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});
// Browser-only: the real narrow overlay hides its launcher; native wheel scrolling
// must reach the editor while the close control remains fixed and pointer-usable.
test("a narrow tall bookmark panel scrolls its content and closes through its own header", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.setViewportSize({ width: 360, height: 420 });
  await page.goto(url);
  const launcher = page.getByRole("button", {
    name: "Toggle channel bookmarks",
  });
  await launcher.click();
  const panel = page.getByRole("region", {
    name: "Bookmarks panel",
    exact: true,
  });
  const close = panel.getByRole("button", { name: "Close bookmarks" });
  await expect(close).toBeVisible();
  const closeTop = (await close.boundingBox()).y;
  const scroll = panel.locator("[data-bookmarks-scroll]");
  await expect
    .poll(() =>
      scroll.evaluate((node) => node.scrollHeight > node.clientHeight),
    )
    .toBe(true);
  await scroll.hover();
  await page.mouse.wheel(0, 5000);
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await panel
    .getByRole("button", { name: "Add bookmark", exact: true })
    .click();
  const input = panel.getByRole("textbox", { name: "Bookmark URL" });
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeInViewport();
  expect((await close.boundingBox()).y).toBe(closeTop);
  await close.click();
  await expect(panel).toHaveCount(0);
  await expect(launcher).toBeFocused();
  await launcher.click();
  await expect(
    panel.getByRole("link", { name: "Bookmark 12", exact: true }),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});
