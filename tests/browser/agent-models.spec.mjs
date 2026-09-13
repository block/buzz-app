import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import config from "../fixtures/agent-control.vite.mjs";

test("explicit model search preserves custom drafts and fences cancellation/context changes", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const editor = page.getByRole("article", { name: "Manage Fixture agent" });
    await editor
      .locator("summary")
      .filter({ hasText: "Edit agent and harness" })
      .click();
    const model = editor.getByRole("textbox", { name: "Model", exact: true });
    await model.fill("custom.keep");
    await editor
      .getByText("Connect and search Databricks v2 models", { exact: true })
      .click();
    const host = editor.getByLabel("Databricks workspace (HTTPS origin)");
    await host.fill("https://workspace.example.com");
    expect(await page.evaluate(() => window.agentModelsFixture.calls)).toEqual(
      [],
    );
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(editor.getByRole("status")).toContainText("Models loaded");
    await expect(model).toHaveValue("custom.keep");
    const search = editor.getByRole("combobox", {
      name: "Search available models",
    });
    await search.fill("Friendly");
    await page.getByRole("option", { name: /Friendly Model/ }).click();
    await expect(model).toHaveValue("catalog.schema.real-model");
    await model.fill("");
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(editor.getByRole("status")).toContainText("Models loaded");
    await expect(model).toHaveValue("");
    await host.fill("https://other.example.com");
    await expect(search).toHaveCount(0);
    await expect(editor.getByRole("status")).toContainText("stale");
    await model.fill("keep-on-error");
    await page.evaluate(() => window.agentModelsFixture.mode("error"));
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(editor.getByRole("status")).toContainText(
      "Synthetic connection failure",
    );
    await expect(model).toHaveValue("keep-on-error");
    await page.evaluate(() => window.agentModelsFixture.mode("empty"));
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(editor.getByRole("status")).toContainText(
      "No discovered models",
    );
    await page.evaluate(() => window.agentModelsFixture.mode("wait"));
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Stop", exact: true }),
    ).toBeEnabled();
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await editor.getByRole("button", { name: "Cancel connection" }).click();
    await expect(editor.getByRole("status")).toContainText("cancelled");
    await expect(search).toHaveCount(0);
    await page.evaluate(() => window.agentModelsFixture.mode("success"));
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(search).toBeVisible();
    await page.getByRole("button", { name: "Simulate newer revision" }).click();
    await expect(search).toHaveCount(0);
    await expect(model).toHaveValue("keep-on-error");
    await editor.getByRole("button", { name: "Discard changes" }).click();
    await editor.getByRole("button", { name: "Refresh models" }).click();
    await expect(search).toBeVisible();
    await search.fill("Other");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(model).toHaveValue("endpoint-two");
    await page.getByRole("button", { name: "Toggle appearance" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: test.info().outputPath("databricks-picker-dark.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => window.agentModelsFixture.mode("wait"));
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Cancel connection" }),
    ).toBeEnabled();
    const before = await page.evaluate(
      () =>
        window.agentModelsFixture.calls.filter((x) => x === "cancel").length,
    );
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.agentModelsFixture.calls.filter((x) => x === "cancel")
              .length,
        ),
      )
      .toBeGreaterThan(before);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await expect(
      editor.getByRole("combobox", { name: "Search available models" }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
