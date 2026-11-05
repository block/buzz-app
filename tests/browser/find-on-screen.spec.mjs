import { expect, test } from "./playwright-test.mjs";
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

// Immutable build/server per worker; each test owns its page and fixture state.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-find-on-screen-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/find-on-screen.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/find-on-screen.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const bar = (page) => page.locator("search");
const field = (page) => page.getByRole("searchbox", { name: "Find on screen" });
const box = (locator) =>
  locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
// Layout: inside a dialog, the dialog's floating material becomes the
// containing block for fixed descendants and clips them; jsdom has no layout.
test("the bar keeps the window's top-right corner inside a dialog", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(url);
  await page.evaluate(() => window.openFind());
  await expect(field(page)).toBeFocused();
  const outside = await box(bar(page));
  await field(page).press("Escape");

  await page.evaluate(() => window.setModal(true));
  const dialog = page.getByRole("dialog", { name: "Members" });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.openFind());
  await expect(dialog.locator("search")).toHaveCount(1);
  await expect(field(page)).toBeFocused();
  expect(await box(bar(page))).toEqual(outside);

  // The dialog's own field stays clear of the bar and takes a click.
  const input = dialog.getByRole("textbox", { name: "Dialog field" });
  await input.click();
  await expect(input).toBeFocused();
  await expect(dialog).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});
