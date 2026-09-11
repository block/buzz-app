import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Independent source consumer proves safe ordinary-prop reuse, with real React,
// thread reader and durable outbox. No developer env, broker, credentials or relay.
test("media review hands off the thread draft, contains focus and keeps narrow controls reachable", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const draft = thread.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await draft.fill("Draft handoff");
    const trigger = page.getByRole("button", {
      name: "Review image",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect(dialog).toBeVisible();
    await expect(thread).toHaveCount(0);
    const reviewDraft = dialog.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(reviewDraft).toHaveValue("Draft handoff");
    await reviewDraft.press("Enter");
    await expect(reviewDraft).toHaveValue("");
    const close = dialog.getByRole("button", {
      name: "Close fullscreen viewer",
    });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(
      dialog.getByRole("button", { name: "Next image" }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole("link", { name: "Download image" }),
    ).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(
      page
        .getByRole("complementary", { name: "Thread", exact: true })
        .getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toHaveValue("");
  } finally {
    await server.close();
  }
});

test("shared thread UI auto-loads, follows live replies, retries and isolates retargeted drafts", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", { name: "Thread messages" });
    const draft = panel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    const choose = (name) =>
      page.getByRole("button", { name, exact: true }).click();
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect(
      panel.getByText("60 replies shown", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Load more replies", exact: true }),
    ).toHaveCount(0);
    await expect.poll(gap).toBeLessThan(2);
    await history.evaluate((el) => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(() => window.messagesFixture.live());
    await expect(
      panel.getByText("61 replies shown", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
    await draft.fill("keep first draft");
    await choose("Second root");
    await expect(draft).toHaveValue("");
    await expect(
      panel.getByText("60 replies shown", { exact: true }),
    ).toBeVisible();
    await expect.poll(gap).toBeLessThan(2);
    await draft.fill("reject second reply");
    await draft.press("Enter");
    await expect(draft).toHaveValue("");
    await expect(
      panel.getByText("Couldn’t send this message.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByText("reject second reply", { exact: true }),
    ).toHaveCount(1);
    // Retry removes its control while queued; wait for the actual second publish.
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(2);
    const delivery = await page.evaluate(() => window.messagesFixture.report);
    expect(delivery.signings).toHaveLength(1);
    expect(delivery.publications).toHaveLength(2);
    expect(delivery.publications[0]).toEqual(delivery.publications[1]);
    await choose("First root");
    await expect(draft).toHaveValue("keep first draft");
    await page
      .getByRole("textbox", { name: "Message #one", exact: true })
      .fill("keep channel draft");
    await choose("Other channel root");
    await expect(draft).toHaveValue("");
    await expect(
      page.getByRole("textbox", { name: "Message #two", exact: true }),
    ).toHaveValue("");
    await choose("First root");
    await expect(draft).toHaveValue("keep first draft");
    await expect(
      page.getByRole("textbox", { name: "Message #one", exact: true }),
    ).toHaveValue("keep channel draft");
    await choose("Switch scope");
    await expect(draft).toHaveValue("");
    await choose("Switch scope");
    await expect(draft).toHaveValue("keep first draft");
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
