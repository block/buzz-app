import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

// Computed styles of message Markdown, captured before the shared renderer
// existed. Set BUZZ_MARKDOWN_PARITY_CAPTURE=1 only to record that baseline.
const EXPECTED = fileURLToPath(
  new URL("./markdown-parity.expected.json", import.meta.url),
);
// Each element's box within its bubble, from the same code and fixture.
const BOXES = fileURLToPath(
  new URL("./markdown-parity.boxes.json", import.meta.url),
);
const PROPERTIES = [
  "font-size",
  "line-height",
  "font-weight",
  "letter-spacing",
  "font-family",
  "font-style",
  "color",
  "margin-top",
  "margin-bottom",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "list-style-type",
  "border-top-width",
  "border-left-width",
  "border-left-color",
  "border-top-color",
  "border-radius",
  "background-color",
  "white-space",
  "overflow-x",
  "position",
  "display",
  "opacity",
];
const ELEMENTS = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  p: "p",
  ul: "ul",
  "ul ul": "ul ul",
  ol: "ol",
  li: "li",
  checkbox: "input[type=checkbox]",
  blockquote: "blockquote",
  hr: "hr",
  "inline code": ":not(pre) > code",
  pre: "pre",
  "pre code": "pre > code",
  "plugin frame": ":has(> figure)",
  "code actions": ":has(> [aria-label='Copy code block'])",
  table: "table",
  th: "th",
  td: "td",
  link: "a",
  "large emoji": "[data-single-emoji]",
};

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-markdown-parity-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/markdown-parity.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/markdown-parity.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function measureBoxes(page) {
  return page.evaluate((elements) => {
    const round = (value) => Math.round(value * 100) / 100;
    return Object.fromEntries(
      ["received", "own"].map((side) => {
        const bubble = document.querySelector(`[data-side="${side}"]`);
        const origin = bubble.getBoundingClientRect();
        return [
          side,
          Object.fromEntries(
            Object.entries(elements).map(([name, selector]) => {
              const box = bubble
                .querySelector(selector)
                .getBoundingClientRect();
              return [
                name,
                {
                  x: round(box.x - origin.x),
                  y: round(box.y - origin.y),
                  width: round(box.width),
                  height: round(box.height),
                },
              ];
            }),
          ),
        ];
      }),
    );
  }, ELEMENTS);
}

async function measure(page) {
  return page.evaluate(
    ({ elements, properties }) => {
      const read = (element) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(
          properties.map((name) => [name, style.getPropertyValue(name)]),
        );
      };
      return Object.fromEntries(
        ["received", "own"].map((side) => {
          const bubble = document.querySelector(`[data-side="${side}"]`);
          return [
            side,
            Object.fromEntries(
              Object.entries(elements).map(([name, selector]) => {
                const element = bubble.querySelector(selector);
                if (!element) throw new Error(`Missing ${name} in ${side}`);
                return [name, read(element)];
              }),
            ),
          ];
        }),
      );
    },
    { elements: ELEMENTS, properties: PROPERTIES },
  );
}

test("message Markdown keeps its computed styles", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "The baseline is Chromium's.");
  const errors = watchPageErrors(page);
  const observed = {};
  const boxes = {};
  for (const density of ["default", "compact"]) {
    await page.goto(`${url}?density=${density}`);
    await expect(page.locator("figure").first()).toBeVisible();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    observed[density] = await measure(page);
    boxes[density] = await measureBoxes(page);
    // The pinned copy action shows on hover and on keyboard focus.
    const pre = page.locator('[data-side="received"] pre').first();
    await pre.hover();
    observed[density].hover = await pre
      .locator("[aria-label='Copy code block']")
      .evaluate((button) => getComputedStyle(button.parentElement).opacity);
    await page.mouse.move(0, 0);
    await pre.locator("[aria-label='Copy code block']").focus();
    observed[density].focus = await pre
      .locator("[aria-label='Copy code block']")
      .evaluate((button) => getComputedStyle(button.parentElement).opacity);
  }
  if (process.env.BUZZ_MARKDOWN_PARITY_CAPTURE === "1") {
    await writeFile(EXPECTED, `${JSON.stringify(observed, null, 2)}\n`);
    await writeFile(BOXES, `${JSON.stringify(boxes, null, 2)}\n`);
  }
  expect(observed).toEqual(JSON.parse(await readFile(EXPECTED, "utf8")));
  expect(boxes).toEqual(JSON.parse(await readFile(BOXES, "utf8")));
  expect(errors.unexplained()).toEqual([]);
});
