import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("My agents reads the existing library with exact linked keys and session-safe retries", async ({
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
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agents.html`,
    );
    const agents = page.getByRole("region", {
      name: "My agents",
      exact: true,
    });
    await expect(
      agents.getByRole("heading", { name: "A Brain", exact: true }),
    ).toHaveCount(2);
    const keys = await page.evaluate(() => window.agentFixture.agents);
    await expect(agents.locator("img")).toHaveCount(1);
    await expect
      .poll(() => agents.locator("img").evaluate((image) => image.naturalWidth))
      .toBeGreaterThan(0);
    for (const key of keys)
      await expect(agents.getByText(key, { exact: true })).toBeHidden();
    await agents.locator("summary").click();
    for (const key of keys)
      await expect(agents.getByText(key, { exact: true })).toBeVisible();
    await expect(
      page.getByText(/current Buzz library, read-only/),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("my-agents.png"),
    });
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toHaveCSS("background-color", "rgb(27, 37, 43)");
    await expect(agents.getByRole("heading").first()).toHaveCSS(
      "color",
      "rgb(230, 237, 240)",
    );
    await page.screenshot({
      path: test.info().outputPath("my-agents-dark.png"),
    });
    await page
      .getByRole("button", { name: "Toggle empty", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(
      page.getByText("No selected agents in your Buzz library."),
    ).toBeVisible();
    await expect(agents.getByRole("article")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle empty", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Toggle error", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(page.getByRole("alert").first()).toContainText(
      "Could not read",
    );
    await page
      .getByRole("button", { name: "Toggle error", exact: true })
      .click();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    await page
      .getByRole("button", { name: "Toggle archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    await expect(agents.getByText(keys[0], { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Toggle missing archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    await agents.locator("summary").click();
    for (const key of keys)
      await expect(agents.getByText(key, { exact: true })).toBeVisible();
    await expect(page.getByText(/Archive visibility is unknown/)).toBeVisible();
    await page
      .getByRole("button", { name: "Toggle missing archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(page.getByText(/Archive visibility is unknown/)).toHaveCount(
      0,
    );
    const reads = await page.evaluate(() => window.agentFixture.reads());
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    expect(await page.evaluate(() => window.agentFixture.reads())).toBe(
      reads + 2,
    );
    await page
      .getByRole("button", { name: "Toggle hold", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText(
      "Reading your Buzz library…",
    );
    await page
      .getByRole("button", { name: "Community B", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Release reads", exact: true })
      .click();
    await expect(
      agents.getByRole("heading", { name: "B Brain", exact: true }),
    ).toHaveCount(2);
    await expect(page.getByText("A Brain", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Community A", exact: true })
      .click();
    await expect(
      agents.getByRole("heading", { name: "A Brain", exact: true }),
    ).toHaveCount(2);
    await page
      .getByRole("button", { name: "Clear cache", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Library cleared");
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
