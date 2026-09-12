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
  await expect.poll(() => page.getByRole("alertdialog").count()).toBe(1);
  await button("Keep editing").click();
  expect(await yaml.inputValue()).toContain("Rejected draft");
  await button("Revoke access").click();
  await expect
    .poll(() => page.getByRole("region", { name: "Workflow editor" }).count())
    .toBe(0);
  expect(await page.getByText("Rejected draft", { exact: false }).count()).toBe(
    0,
  );
  await page.reload();
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
  expect(await page.locator("html").getAttribute("data-color-mode")).toBe(
    "dark",
  );
  await button("Unmount plugin").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowFixture.definitions.disposed()),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});
