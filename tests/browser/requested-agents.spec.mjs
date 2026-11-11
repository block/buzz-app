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

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-requested-agents-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/requested-agents.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/requested-agents.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const scoutRow = (page) =>
  page.getByRole("listitem").filter({ hasText: "Scout" });

for (const { theme, large, width } of [
  { theme: "light", large: false, width: 900 },
  { theme: "dark", large: true, width: 420 },
]) {
  test(`a requested agent is approved with edited instructions and rejected after confirmation (${theme}, ${width}px)`, async ({
    page,
  }, info) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${url}?theme=${theme}${large ? "&large" : ""}`);
    const row = scoutRow(page);
    await expect(row).toContainText("Requested by Helper");
    await expect(
      page
        .getByRole("listitem")
        .filter({ has: page.getByText("Helper", { exact: true }) })
        .getByRole("button", { name: "Approve" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`requested-${theme}-${width}.png`),
    });

    await row.getByRole("button", { name: "Approve" }).click();
    const approve = page.getByRole("dialog", { name: "Approve Scout?" });
    const instructions = approve.getByRole("textbox", { name: "Instructions" });
    await expect(instructions).toHaveValue(
      "Watch the build and report when it breaks.",
    );
    await instructions.fill("Watch the build.");
    await approve.getByRole("button", { name: "Approve" }).click();
    await expect(
      approve.getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await expect(instructions).toBeDisabled();
    await page.screenshot({
      path: info.outputPath(`approve-pending-${theme}-${width}.png`),
    });
    await page.evaluate(() => window.release("approve"));
    await expect(approve).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => window.calls)).toEqual([
      ["approve", "scout", "Watch the build."],
    ]);
    expect(errors).toEqual([]);
  });

  test(`rejecting a requested agent asks first (${theme}, ${width}px)`, async ({
    page,
  }, info) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${url}?theme=${theme}${large ? "&large" : ""}`);
    await scoutRow(page)
      .getByRole("button", { name: "More actions for Scout" })
      .click();
    await page.getByRole("menuitem", { name: "Reject" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Reject Scout?" });
    await expect(confirm).toContainText("Helper asked for this agent");
    expect(await page.evaluate(() => window.calls)).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`reject-confirm-${theme}-${width}.png`),
    });
    await confirm.getByRole("button", { name: "Reject" }).click();
    await expect(
      confirm.getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await page.evaluate(() => window.release("reject"));
    await expect(confirm).toHaveCount(0);
    await expect(scoutRow(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.calls)).toEqual([
      ["reject", "scout"],
    ]);
    expect(errors).toEqual([]);
  });
}
