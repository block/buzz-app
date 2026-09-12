import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/src/bundled/workflows/fixture.html`;
});
test.afterAll(async () => {
  await server?.close();
});

test("workflow editor preserves YAML, resolves exact saves, retains conflicts and purges access", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowFixture.definitions.active()),
    )
    .toBe(1);
  await button("Refresh configurations").click();
  await button("Message helper").click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  await expect
    .poll(() => yaml.inputValue())
    .toContain("# Keep this comment on opening");
  await page.getByRole("tab", { name: "Form", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect
    .poll(() => yaml.inputValue())
    .toContain("# Keep this comment on opening");
  await yaml.fill(
    (await yaml.inputValue()).replace("Hello from a fixture", "Edited text"),
  );
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  await button("Complete concurrent head").click();
  await expect
    .poll(() => page.getByText(/waiting for a readback/).count())
    .toBe(1);
  expect(await button("Save workflow").isDisabled()).toBe(true);
  expect(await yaml.inputValue()).toContain("Edited text");
  await button("Complete exact save").click();
  await expect.poll(() => button("Save workflow").isEnabled()).toBe(true);
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await yaml.fill(
    (await yaml.inputValue()).replace("Edited text", "Rejected draft"),
  );
  await button("Save workflow").click();
  await button("Reject operation").click();
  await expect
    .poll(() => page.getByText("Fixture conflict", { exact: true }).count())
    .toBe(1);
  expect(await yaml.inputValue()).toContain("Rejected draft");
  await button("Continue editing retained draft").click();
  expect(await button("Save workflow").isEnabled()).toBe(true);
  await button("Close editor").click();
  await expect(
    page.getByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeVisible();
  await expect(button("Keep editing")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(button("Close editor")).toBeFocused();
  expect(await yaml.inputValue()).toContain("Rejected draft");
  await button("Revoke access").click();
  await expect
    .poll(() => page.getByRole("region", { name: "Workflow editor" }).count())
    .toBe(0);
  expect(await page.getByText("Rejected draft", { exact: false }).count()).toBe(
    0,
  );
  await page.reload();
  await page.evaluate(() =>
    window.workflowFixture.definitions.update({
      status: "ready",
      data: { items: [], partial: false },
    }),
  );
  await expect(
    page.getByText(/Create a disabled draft to start/),
  ).toBeVisible();
  await expect(
    page.getByText(/Creating and saving workflows is unavailable/),
  ).toHaveCount(0);
  await button("New workflow").click();
  expect(
    await page
      .getByRole("switch", { name: "Enabled in configuration" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  await button("Add Send Message").click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Incomplete editor");
  await page
    .getByLabel("Message text", { exact: true })
    .fill("Keyboard-created text");
  await expect.poll(() => button("Save workflow").isEnabled()).toBe(true);
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  expect(await yaml.inputValue()).toContain("enabled: false");
  await yaml.fill(
    (await yaml.inputValue()).replace("on: message_posted", "on: webhook"),
  );
  expect(await button("Save workflow").isDisabled()).toBe(true);
  await expect
    .poll(() => page.getByText(/Webhook-trigger saves are unavailable/).count())
    .toBe(1);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await button("Toggle appearance").click();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  // Wait for the shared control transition before checking its final paint.
  await expect(button("Close editor")).toHaveCSS("color", "rgb(245, 245, 245)");
  await expect(button("Close editor")).toHaveCSS(
    "background-color",
    "rgb(22, 22, 22)",
  );
  await yaml.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(yaml).toHaveCSS("outline-style", "solid");
  await expect(yaml).toHaveCSS("outline-width", "2px");
  await button("Unmount plugin").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowFixture.definitions.disposed()),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test("history reads are lazy, paged by exact cursor and released; unknown operations never get a replacement ID", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  expect(await page.evaluate(() => window.workflowFixture.calls.runs)).toBe(0);
  await button("Read runs").click();
  await expect(page.getByText("Current step: 1")).toBeVisible();
  expect(
    await page.evaluate(() => window.workflowFixture.calls.approvals),
  ).toBe(0);
  await button("Read approvals").click();
  await expect(
    page.getByText("notify: granted — Fixture decision"),
  ).toBeVisible();
  await button("Hide approvals").click();
  expect(
    await page.evaluate(() =>
      window.workflowFixture.approvalViews.every((view) => view.disposed()),
    ),
  ).toBe(true);
  await button("Older runs").click();
  await expect(page.getByText("No runs returned on this page.")).toBeVisible();
  expect(await page.evaluate(() => window.workflowFixture.runCursor())).toEqual(
    {
      before: "2026-09-12T12:00:00.123456Z",
      beforeId: "77777777-7777-4777-8777-777777777777",
    },
  );
  expect(
    await page.evaluate(() =>
      window.workflowFixture.runViews
        .slice(0, -1)
        .every((view) => view.disposed()),
    ),
  ).toBe(true);
  await button("Hide runs").click();
  expect(
    await page.evaluate(() =>
      window.workflowFixture.runViews.every((view) => view.disposed()),
    ),
  ).toBe(true);
  await button("Run now").click();
  await button("Unknown operation").click();
  await expect(button("Run now")).toBeDisabled();
  const id = await page.evaluate(
    () =>
      window.workflowFixture.capability.operations.snapshot().at(-1).eventId,
  );
  await button("Retry same signed operation").click();
  expect(await page.evaluate(() => window.workflowFixture.calls.retry)).toEqual(
    [id],
  );
  await button("Close editor").click();
  await button("Message helper").click();
  await expect(button("Run now")).toBeDisabled();
  await expect(button("Save workflow")).toBeDisabled();
  expect(await page.evaluate(() => window.workflowFixture.calls.trigger)).toBe(
    1,
  );
});

test("real session page under StrictMode fences community changes, warns for dirty channel navigation and purges access", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const choose = async (name) => {
    await page.getByRole("combobox", { name: "Channel", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await choose("First channel");
  await expect(button("New workflow")).toBeDisabled();
  await expect(
    page.getByText(/Creating and saving workflows is unavailable/),
  ).toBeVisible();
  await button("Fixture A helper").click();
  await expect(button("Save workflow")).toBeDisabled();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Unsaved private text");
  await choose("Second channel");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await button("Keep editing").click();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Unsaved private text",
  );
  await choose("Second channel");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Change channel", exact: true })
    .click();
  await expect(
    page.getByText("No saved configurations returned for this channel.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(button("New workflow")).toBeDisabled();
  await expect(
    page.getByText(/Creating and saving workflows is unavailable/),
  ).toBeVisible();
  await expect(page.getByText(/Create a disabled draft to start/)).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toHaveCount(0);
  await choose("First channel");
  await button("Fixture A helper").click();
  await button("Switch community").click();
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toHaveCount(0);
  await choose("First channel");
  await button("Fixture B helper").click();
  await button("Switch community").click();
  await choose("First channel");
  await button("Fixture A helper").click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Revoked private text");
  await button("Revoke selected channel").click();
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Revoked private text",
  );
  expect(errors).toEqual([]);
});
