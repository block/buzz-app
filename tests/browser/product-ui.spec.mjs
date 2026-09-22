import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/product-ui.html`;
});
test.afterAll(async () => {
  await server?.close();
});

// Browser-only: actual text/control geometry, focus and source selection.
test("production composer catalogue preserves source and controls at responsive widths", async ({
  page,
}, testInfo) => {
  await page.goto(url);
  const playground = page.getByRole("region", { name: "Composer playground" });
  const input = playground.getByRole("textbox");
  const source = "**Markdown** [label](https://example.com/path)";
  await input.fill(source);
  await expect(
    playground.getByRole("button", { name: "Mention a member", exact: true }),
  ).toBeVisible();
  await expect(
    playground.getByRole("button", { name: "Toggle formatting" }),
  ).toHaveCount(0);
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    const form = playground.getByRole("form");
    const bounds = await form.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    for (const control of await form.getByRole("button").all()) {
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    }
    await expect(input).toHaveJSProperty("value", source);
    await page.screenshot({
      path: testInfo.outputPath(`composer-${width}.png`),
    });
  }
  await input.focus();
  await page.keyboard.press("ControlOrMeta+a");
  const copied = await input.evaluate((element) => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  expect(copied).toBe(source);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("solid");
});

test("catalogue preserves disabled, read-only and failed-send recovery examples", async ({
  page,
}) => {
  await page.goto(url);
  await expect(
    page
      .getByRole("region", { name: "Unavailable", exact: true })
      .getByRole("textbox"),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("region", { name: "Read only", exact: true }),
  ).toContainText("supports reading only");
  const recovery = page.getByRole("region", {
    name: "Validation and recovery",
  });
  await recovery.getByRole("button", { name: "Send message" }).click();
  await expect(recovery.getByRole("alert")).toContainText(
    "Your message is still here",
  );
  await expect(recovery.getByRole("textbox")).toHaveJSProperty(
    "value",
    "Retry this message",
  );
  const video = page.getByRole("region", {
    name: "Video reply with typing",
    exact: true,
  });
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    const typing = await video
      .getByRole("status", { name: "Typing activity" })
      .boundingBox();
    const editor = await video.getByRole("textbox").boundingBox();
    const remove = await video
      .getByRole("button", { name: "Remove video time" })
      .boundingBox();
    expect(typing.y + typing.height).toBeLessThanOrEqual(editor.y);
    expect(typing.y + typing.height).toBeLessThanOrEqual(remove.y);
  }
  await video.getByRole("button", { name: "Remove video time" }).click();
  await expect(
    video.getByRole("button", { name: "Remove video time" }),
  ).toHaveCount(0);
  await expect(
    video.getByRole("status", { name: "Typing activity" }),
  ).toContainText("Alice is typing");
});

// Placeholder is visible copy, not the stable accessible editing label.
test("context examples distinguish channel, thread and DM prompts", async ({
  page,
}) => {
  await page.goto(url);
  const playground = page.getByRole("region", { name: "Composer playground" });
  for (const [option, copy, label] of [
    [
      "Channel · New message",
      "Send a message in #buzz-design",
      "Message #buzz-design",
    ],
    ["Thread · Reply", "Reply in thread", "Reply to thread"],
    [
      "Direct message · New message",
      "Start a new message",
      "Message #buzz-design",
    ],
    ["Direct message · Reply", "Message...", "Message #buzz-design"],
  ]) {
    await page.getByRole("combobox", { name: "Preview context" }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
    await expect(
      playground.getByRole("textbox", { name: label, exact: true }),
    ).toHaveAttribute("data-placeholder", copy);
  }
});
