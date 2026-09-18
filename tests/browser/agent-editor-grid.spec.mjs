import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import config from "../fixtures/agent-control.vite.mjs";

test("existing grid opens the focused editor, selects a model and saves/reopens", async ({
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
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      Object.assign(f.agent.harness, {
        command: "buzz-agent",
        provider: "databricks_v2",
        args: [],
        databricks: { host: "https://workspace.example.com", filter: "" },
      });
      await f.control.refresh();
    });
    const card = page.getByRole("article", {
      name: "Agent Fixture agent",
      exact: true,
    });
    await expect(
      card.getByRole("button", { name: "Edit", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("agents-grid-light.png"),
    });
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Edit agent",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Workspace", { exact: true })).toBeHidden();
    await dialog
      .getByRole("button", { name: "Browse models", exact: true })
      .click();
    await expect(
      page.getByRole("option", { name: /Friendly Model/ }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("agent-model-choices-light.png"),
    });
    await page.getByRole("option", { name: /Friendly Model/ }).click();
    await expect(
      dialog.getByRole("combobox", { name: "Model", exact: true }),
    ).toHaveValue("Friendly Model");
    await dialog
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("Help with the project. Keep answers clear and concise.");
    await dialog
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(
      dialog.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("Help with the project. Keep answers clear and concise.");
    await page.screenshot({
      path: test.info().outputPath("agent-editor-light.png"),
    });
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText("Saved.");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Edit", exact: true }),
    ).toBeFocused();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Browse models", exact: true })
      .click();
    await page.getByRole("option", { name: /Friendly Model/ }).click();
    await expect(
      dialog.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("Help with the project. Keep answers clear and concise.");
    expect(
      await page.evaluate(() => window.agentControlFixture.agent.harness.model),
    ).toBe("catalog.schema.real-model");
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await page.screenshot({
      path: test.info().outputPath("agent-editor-dark.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByRole("button", { name: "Save changes" })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole("button", { name: "Save changes" }),
    ).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("agent-editor-dark-narrow.png"),
    });
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 950 });
    const search = dialog.getByRole("combobox", { name: "Model", exact: true });
    await dialog
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("Custom model safety");
    const saves = await page.evaluate(
      () =>
        window.agentControlFixture.calls.filter((c) => c.action === "save")
          .length,
    );
    await search.fill("custom.enter");
    await expect(
      page.getByRole("option", { name: /custom.enter/ }),
    ).toBeVisible();
    await search.press("Enter");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          window.agentControlFixture.calls.filter((c) => c.action === "save")
            .length,
      ),
    ).toBe(saves);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.agentControlFixture.agent.harness.model),
      )
      .toBe("custom.enter");
    await search.fill("custom.click-save");
    await expect(
      page.getByRole("option", { name: /custom.click-save/ }),
    ).toBeVisible();
    await dialog
      .getByRole("button", {
        name: "Save changes",
        exact: true,
        includeHidden: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.agentControlFixture.agent.harness.model),
      )
      .toBe("custom.click-save");
    await search.fill("");
    await dialog
      .getByRole("textbox", {
        name: "Agent instructions",
        exact: true,
        includeHidden: true,
      })
      .click();
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.agentControlFixture.agent.harness.model),
      )
      .toBe("");
    // Dirty write-only values receive the same incidental-dismissal protection.
    await dialog.getByText("Advanced", { exact: true }).click();
    const environment = dialog.getByLabel("Replacement for EXAMPLE_TOKEN");
    await environment.fill("synthetic-draft-only");
    await environment.press("Escape");
    await page.mouse.click(5, 5);
    await expect(environment).toHaveValue("synthetic-draft-only");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await dialog.getByText("Advanced", { exact: true }).click();
    await expect(environment).toHaveValue("");
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .press("Escape");
    await expect(dialog).toHaveCount(0); // clean Escape still closes
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
