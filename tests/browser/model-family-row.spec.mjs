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
  directory = await mkdtemp(join(tmpdir(), "buzz-model-family-row-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/model-family-row.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/model-family-row.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Layout: the model and effort labels each keep their own width, so a short
// model name is not cut to share space evenly with the effort.
test("a family model row shows the whole model and effort", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(`${url}?width=760`);
  const model = page.getByRole("button", {
    name: "Claude default model: Opus 5.5, Low",
  });
  await expect(model).toBeEnabled();
  const truncated = await model.evaluate((button) =>
    [...button.querySelectorAll(".buzz-select-value, .buzz-select-value ~ *")]
      .filter((label) => label.textContent)
      .map((label) => [
        label.textContent,
        label.scrollWidth > label.clientWidth,
      ]),
  );
  expect(truncated).toEqual([
    ["Opus 5.5", false],
    ["Low", false],
  ]);
  expect(errors.unexplained()).toEqual([]);
});
