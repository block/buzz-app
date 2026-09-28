import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createHost, community, viewer } from "./host.mjs";
import { startServer } from "./server.mjs";
import { scenarios } from "./scenarios.mjs";

const out = resolve(process.env.DEMO_OUTPUT ?? "artifacts/native-recovery");
await mkdir(out, { recursive: true });
const { server, url } = await startServer();
const browser = await chromium.launch();
const selected = process.argv.slice(2);
const completed = [];
const metadata = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runtime: `Playwright Chromium ${browser.version()}, Vite source app, mocked native IPC/relay; no development broker`,
  capturedAt: new Date().toISOString(),
};
// Pauses pace the video for a reader. Assertions and fixture gates own synchronization.
const hold = (ms = 1800) => new Promise((done) => setTimeout(done, ms));
try {
  for (const { id, options, run } of scenarios) {
    if (selected.length && !selected.includes(id)) continue;
    // A failed rerun must not retain an older success manifest for its new video.
    await writeFile(
      `${out}/${id}.json`,
      JSON.stringify({ id, ...metadata, result: "recording" }),
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: out, size: { width: 1440, height: 1000 } },
      colorScheme: "light",
    });
    const began = performance.now();
    const page = await context.newPage();
    const host = createHost(options);
    await host.install(page);
    const errors = [],
      chapters = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const mark = async (label) => {
      chapters.push({ seconds: (performance.now() - began) / 1000, label });
      console.log(id, label);
      await hold();
    };
    const click = async (locator) => {
      await locator.hover();
      await hold(450);
      await locator.click();
      await hold(650);
    };
    const button = (name) => page.getByRole("button", { name, exact: true });
    const fill = async (label, value) => {
      const field = page.getByLabel(label, { exact: true });
      await field.fill("");
      await field.pressSequentially(value, { delay: 42 });
    };
    const add = async (restored = false) => {
      await click(button("Add a community"));
      if (restored)
        await expect(page.getByLabel("Relay URL")).toHaveValue(community);
      else await fill("Relay URL", community);
      await click(button("Continue"));
    };
    const open = async () => {
      await click(button("Open community"));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator('[data-channel-id="launch"]')).toBeVisible();
      await click(page.locator('[data-channel-id="launch"]'));
      await expect(
        page.getByText(
          "Welcome, Alex. The launch checklist is ready for review.",
          { exact: true },
        ),
      ).toBeVisible();
    };
    const published = async () => {
      await click(button("Publish profile & open"));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(button("Switch to Harbour Studio")).toHaveAttribute(
        "aria-current",
        "true",
      );
      await expect.poll(() => journal()).toEqual([]);
    };
    const invite = async () => {
      await fill("Invite code (if required)", "v2.harbour-studio");
      await expect(button("Continue")).toBeDisabled();
      await click(page.getByRole("checkbox", { name: /I agree/ }));
      await click(page.getByRole("checkbox", { name: /at least 18/ }));
    };
    const reload = async () => {
      await page.reload();
      await expect(button("Add a community")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => window.recordingServices.communities.snapshot().status,
          ),
        )
        .toBe("ready");
      assert.equal(
        await page.evaluate(
          () => window.recordingServices.communities.snapshot().viewer,
        ),
        viewer,
      );
      await hold();
    };
    const error = async (text) => {
      await expect(page.getByRole("alert")).toContainText(text);
      await hold(2500);
    };
    const send = async (text) => {
      const input = page.getByRole("textbox", {
        name: "Message #launch-planning",
        exact: true,
      });
      await input.pressSequentially(text, { delay: 48 });
      await hold(800);
      await input.press("Enter");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await hold();
    };
    const journal = () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
        `buzz-community-joins.v1:${viewer}`,
      );
    let passed = false;
    try {
      await page.goto(url);
      await expect(button("Add a community")).toBeVisible();
      await mark("Restored fixture identity; real Buzz UI");
      await run({
        page,
        host,
        mark,
        click,
        button,
        fill,
        add,
        open,
        published,
        invite,
        reload,
        error,
        send,
        journal,
      });
      assert.deepEqual(errors, []);
      assert(!host.state.calls.some((c) => c.command === "identity_export"));
      await page.screenshot({ path: `${out}/${id}-end.png` });
      await hold(2200);
      passed = true;
      completed.push(id);
    } catch (reason) {
      await page.screenshot({ path: `${out}/${id}-failed.png` });
      await writeFile(
        `${out}/${id}-failed.json`,
        JSON.stringify(
          {
            errors,
            body: await page.locator("body").innerText(),
            calls: host.state.calls,
          },
          null,
          2,
        ),
      );
      throw reason;
    } finally {
      await context.close();
      await page.video().saveAs(`${out}/${id}.webm`);
      await page.video().delete();
      if (passed)
        await writeFile(
          `${out}/${id}.json`,
          JSON.stringify(
            {
              id,
              ...metadata,
              chapters,
              errors,
              result: "passed",
              calls: host.state.calls,
              publications: host.state.publications,
              signatures: host.state.signatures,
            },
            null,
            2,
          ),
        );
    }
  }
} finally {
  await writeFile(
    `${out}/capture-run.json`,
    JSON.stringify({ ...metadata, completed }, null, 2),
  );
  await browser.close();
  await server.close();
}
