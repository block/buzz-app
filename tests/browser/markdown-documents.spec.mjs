import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

const SHOTS = fileURLToPath(
  new URL("../../test-results/markdown-documents/", import.meta.url),
);

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-markdown-documents-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/markdown-documents.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/markdown-documents.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const role = (page, name) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.fontSize = `var(--text-${name})`;
    document.body.append(probe);
    const size = getComputedStyle(probe).fontSize;
    probe.remove();
    return size;
  }, name);

// Layout and interaction: jsdom resolves neither type roles nor hover.
test("document screens share heading roles, list markers and code frames", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Screenshots are Chromium's.");
  const errors = watchPageErrors(page);
  await mkdir(SHOTS, { recursive: true });
  for (const mode of ["light", "dark"])
    for (const width of [360, 1100])
      for (const size of ["default", "larger"]) {
        await page.setViewportSize({ width: width + 32, height: 900 });
        await page.goto(`${url}?mode=${mode}&width=${width}&size=${size}`);
        const canvas = page.locator('[data-screen="canvas"]');
        await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
        const label = `${mode} ${width}px ${size}`;
        const styles = await canvas.evaluate((section) => {
          const read = (selector, name) =>
            getComputedStyle(section.querySelector(selector)).getPropertyValue(
              name,
            );
          return {
            h1: read("h1", "font-size"),
            h2: read("h2", "font-size"),
            nested: read("ul ul", "list-style-type"),
            deepest: read("ul ul ul", "list-style-type"),
            ordered: read("ol", "list-style-type"),
            frame: read("pre", "border-top-width"),
            chip: read(":not(pre) > code", "background-color"),
            header: read("th", "background-color"),
          };
        });
        expect(styles.h1, label).toBe(await role(page, "title"));
        expect(styles.h2, label).toBe(await role(page, "heading"));
        expect(styles, label).toMatchObject({
          nested: "circle",
          deepest: "square",
          ordered: "decimal",
          frame: "1px",
        });
        expect(styles.chip, label).not.toBe("rgba(0, 0, 0, 0)");
        expect(styles.header, label).not.toBe("rgba(0, 0, 0, 0)");
        // Attention keeps label roles for its headings.
        const attention = page.locator('[data-screen="attention"]');
        expect(
          await attention
            .locator("h1")
            .evaluate((h) => getComputedStyle(h).fontSize),
          label,
        ).toBe(await role(page, "label"));
        // Copy: on pointer hover and on keyboard focus.
        const pre = canvas.locator("pre");
        const copy = pre.getByRole("button", { name: "Copy code block" });
        // `toBeVisible` passes at opacity 0, so read the actions' opacity.
        const actions = copy.locator("..");
        await pre.hover();
        await expect(actions).toHaveCSS("opacity", "1");
        await page.mouse.move(0, 0);
        await expect(actions).toHaveCSS("opacity", "0");
        await copy.focus();
        await expect(copy).toBeFocused();
        await expect(actions).toHaveCSS("opacity", "1");
        // A line that cannot wrap scrolls inside its block, not the Canvas.
        const host = await page
          .locator('[data-screen="canvas-host"]')
          .evaluate((section) => {
            const code = section.querySelector("pre code");
            return {
              host: section.getBoundingClientRect().width,
              article: section.firstElementChild.getBoundingClientRect().width,
              client: code.clientWidth,
              scroll: code.scrollWidth,
            };
          });
        expect(host.article, label).toBeLessThanOrEqual(host.host);
        expect(host.scroll, label).toBeGreaterThan(host.client);
        // A rejected document's source still wraps.
        const source = page.locator('[data-screen="canvas-source"] pre code');
        await expect(source).toHaveCSS("white-space", "pre-wrap");
        expect(
          await source.evaluate((code) => code.scrollWidth <= code.clientWidth),
          label,
        ).toBe(true);
        await page.screenshot({
          path: `${SHOTS}${mode}-${width}-${size}.png`,
          fullPage: true,
        });
      }
  expect(errors.unexplained()).toEqual([]);
});
