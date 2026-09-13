import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("draft preview matches message links without changing edits or notification intent", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-messages.html`,
    );
    const input = page.getByRole("textbox", {
      name: "Message #design",
      exact: true,
    });
    const preview = page.getByRole("region", { name: "Draft preview" });
    await expect(preview.locator('[data-link-kind="github"]')).toHaveCount(2);
    await expect(preview.locator('[data-mention-kind="person"]')).toHaveText(
      "Alex Chen",
    );
    await expect(preview.locator('[data-mention-kind="agent"]')).toHaveText(
      "Build Bot",
    );
    await expect(preview.getByRole("link")).toHaveCount(0);
    await expect(preview.getByRole("button")).toHaveCount(0);

    const text =
      "Review [**GitHub**](https://github.com/block/buzz-app) in #design with ";
    await input.fill(text);
    await input.press("End");
    await page
      .getByRole("button", { name: "Mention Alex Chen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Mention Build Bot", exact: true })
      .click();
    const expected = `${text}@Alex Chen @Build Bot `;
    await expect(input).toHaveValue(expected);
    await expect(input).toBeFocused();
    expect(await input.evaluate((el) => el.selectionStart)).toBe(
      expected.length,
    );
    await expect(preview.locator("strong")).toHaveText("GitHub");
    await expect(preview.locator('[data-mention-kind="agent"]')).toHaveText(
      "Build Bot",
    );
    await input.press("Enter");
    expect(await page.evaluate(() => window.linkComposerFixture.sent)).toEqual([
      { text: expected, mentions: ["a".repeat(64), "b".repeat(64)] },
    ]);
    await expect(input).toHaveValue("");
    await expect(preview).toHaveCount(0);

    const pasted = "@Alex Chen [Drive](https://drive.google.com/file/example)";
    await input.fill(pasted);
    await expect(preview.locator("[data-mention-kind]")).toHaveCount(0);
    await expect(preview.locator('[data-link-kind="drive"]')).toHaveText(
      "Drive",
    );
    await page.reload();
    await expect(input).toHaveValue(pasted);
    await expect(preview.locator("[data-mention-kind]")).toHaveCount(0);
    await page.getByRole("button", { name: "Plugin off", exact: true }).click();
    await expect(preview.locator("[data-link-renderer]")).toHaveCount(0);
    await expect(preview).toContainText("Drive");
    await expect(input).toHaveValue(pasted);
  } finally {
    await server.close();
  }
});
