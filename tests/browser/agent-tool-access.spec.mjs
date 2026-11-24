import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

test.use({ video: "on" });

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-agent-tool-access-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/agent-tool-access.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/agent-tool-access.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("starts Custom from a role, adjusts tools and a connected server, then saves", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  const role = page.getByRole("combobox", { name: "Tool access role" });
  await role.click();
  await page.getByRole("option", { name: /^Super-agent/ }).click();
  await expect(page.getByRole("switch", { name: "Shell" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Subagents" })).toBeChecked();
  await role.click();
  await page.getByRole("option", { name: /^Custom/ }).click();
  await page.getByRole("switch", { name: "Subagents" }).click();
  await page
    .getByRole("textbox", { name: "Connected server name" })
    .fill("github");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("switch", { name: "github" })).toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.toolSave))
    .toEqual({
      config: {
        model: "sonnet",
        instructions: "Keep these",
        toolPreset: "custom",
        toolAllow:
          "buzz:coordinate,buzz:message,buzz:read,connected:github,native:meta,native:read,native:web",
      },
    });
  expect(errors).toEqual([]);
});

for (const { name, width, height, query } of [
  { name: "light wide", width: 1280, height: 900, query: "" },
  { name: "light narrow", width: 420, height: 760, query: "" },
  { name: "dark narrow", width: 420, height: 760, query: "?theme=dark" },
  {
    name: "dark enlarged narrow",
    width: 480,
    height: 760,
    query: "?theme=dark&large",
  },
]) {
  test(`keeps controls usable without horizontal overflow: ${name}`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width, height });
    await page.goto(`${url}${query}`);
    await expect(
      page.getByRole("combobox", { name: "Tool access role" }),
    ).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "Files: read", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Advanced:/ })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
