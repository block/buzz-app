import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import config from "../fixtures/agent-control.vite.mjs";

test("local controls preserve drafts, confirm operations and distinguish disabled from sleeping", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const panel = page.getByRole("region", { name: "Local agent controls" });
    const editor = panel.getByRole("article", { name: "Manage Fixture agent" });
    await expect(
      editor.getByText("Process running · relay readiness unverified", {
        exact: true,
      }),
    ).toBeVisible();
    await editor
      .getByText("Exact identity and destination", { exact: true })
      .click();
    await expect(
      editor.getByText("ab".repeat(32), { exact: true }),
    ).toBeVisible();
    await editor
      .locator("summary")
      .filter({ hasText: "Edit agent and harness" })
      .click();
    await editor
      .getByRole("textbox", { name: "System prompt", exact: true })
      .fill("My unsaved prompt");
    await panel.getByRole("button", { name: "Refresh status" }).click();
    await expect(
      editor.getByRole("textbox", { name: "System prompt", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await page.getByRole("button", { name: "Reject saves" }).click();
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(panel.getByRole("alert").first()).toContainText(
      "Could not confirm",
    );
    await expect(
      editor.getByRole("textbox", { name: "System prompt", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await page.getByRole("button", { name: "Allow saves" }).click();
    await panel.getByRole("button", { name: "Retry status" }).click();
    await editor
      .getByLabel("Replacement for EXAMPLE_TOKEN")
      .fill("fixture-only-value");
    await expect(
      editor.getByLabel("Replacement for EXAMPLE_TOKEN"),
    ).toHaveAttribute("type", "password");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(
      editor.getByText("Saved. Running work was not restarted."),
    ).toBeVisible();
    await expect(
      editor.getByText(/Saved revision 2 · Running revision 1/),
    ).toBeVisible();
    await expect(
      editor.getByLabel("Replacement for EXAMPLE_TOKEN"),
    ).toHaveValue("");
    const saved = await page.evaluate(() =>
      window.agentControlFixture.calls
        .filter((call) => call.action === "save")
        .at(-1),
    );
    expect(saved.payload.edit.environment).toEqual({
      EXAMPLE_TOKEN: "fixture-only-value",
    });
    await editor.getByRole("button", { name: "Restart to apply" }).click();
    await expect(
      editor.getByText(/Saved revision 2 · Running revision 2/),
    ).toBeVisible();
    await editor
      .getByRole("textbox", { name: "System prompt", exact: true })
      .fill("Keep this conflict draft");
    await page.getByRole("button", { name: "Simulate newer revision" }).click();
    await expect(editor.getByRole("alert")).toContainText(
      "newer saved revision",
    );
    await expect(
      editor.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("textbox", { name: "System prompt", exact: true }),
    ).toHaveValue("Keep this conflict draft");
    await editor.getByRole("button", { name: "Discard changes" }).click();
    await expect(
      editor.getByRole("textbox", { name: "System prompt", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      editor.getByText("Disabled · mentions will not wake this agent"),
    ).toBeVisible();
    const before = await page.evaluate(() =>
      window.agentControlFixture.calls.filter(
        (call) => call.action !== "snapshot",
      ),
    );
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action !== "snapshot",
        ),
      ),
    ).toEqual(before);
    await panel.getByText("Import from old Buzz", { exact: true }).click();
    await panel.getByLabel("Development Buzz", { exact: true }).check();
    await panel
      .getByRole("button", { name: "Preview selected library" })
      .click();
    await expect(
      panel.getByText("/fixture/development/managed-agents.json"),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Import selected identities" }),
    ).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await panel
      .getByRole("button", { name: "Import selected identities" })
      .click();
    await expect(panel.getByRole("article")).toHaveCount(2);
    await expect(
      panel.getByText("Disabled · mentions will not wake this agent"),
    ).toHaveCount(2);
    await page.screenshot({
      path: test.info().outputPath("agent-controls-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Toggle appearance" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "Refresh status" }).blur();
    await expect(
      panel.getByRole("button", { name: "Refresh status" }),
    ).toHaveCSS("background-color", "rgb(22, 22, 22)");
    await page.screenshot({
      path: test.info().outputPath("agent-controls-dark-narrow.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Toggle browser-only mode" })
      .click();
    await expect(panel.getByText(/This browser cannot run/)).toBeVisible();
    await expect(panel.getByRole("button")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

for (const previouslyStopped of [false, true]) {
  test(`unreadable status allows only explicit Stop from a retained ${previouslyStopped ? "stopped" : "running"} snapshot`, async ({
    page,
  }) => {
    const server = await createServer({
      ...config,
      configFile: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
      );
      const panel = page.getByRole("region", { name: "Local agent controls" });
      const editor = panel.getByRole("article", {
        name: "Manage Fixture agent",
      });
      const stop = editor.getByRole("button", { name: "Stop", exact: true });
      if (previouslyStopped) {
        await stop.click();
        await expect(stop).toBeDisabled();
      }
      await panel.getByText("Import from old Buzz", { exact: true }).click();
      await panel
        .getByRole("button", { name: "Preview selected library" })
        .click();
      await panel.getByRole("checkbox").check();
      await editor
        .locator("summary")
        .filter({ hasText: "Edit agent and harness" })
        .click();
      await page.evaluate(() => {
        const fixture = window.agentControlFixture;
        const { snapshot, action } = fixture.host;
        fixture.host.snapshot = async () => {
          throw "Unreadable settings.";
        };
        fixture.host.action = async (id, operation) => {
          if (operation !== "stop") return action(id, operation);
          fixture.calls.push({ action: operation, payload: { id } });
          // Native teardown succeeded, but durable disable failed: no snapshot confirmation.
          fixture.agent.status = "stopped";
          fixture.agent.runningRevision = null;
          throw "Stopped owned process, but could not persist disabled settings.";
        };
        fixture.restoreStore = () =>
          Object.assign(fixture.host, { snapshot, action });
      });
      await panel.getByRole("button", { name: "Refresh status" }).click();
      await expect(panel.getByRole("alert")).toContainText("Could not refresh");
      await expect(stop).toBeEnabled();
      if (previouslyStopped)
        await expect(
          editor.getByRole("button", { name: "Start", exact: true }),
        ).toBeDisabled();
      await expect(
        editor.getByRole("button", { name: "Restart", exact: true }),
      ).toBeDisabled();
      await editor
        .getByRole("textbox", { name: "System prompt", exact: true })
        .fill("Keep my recovery draft");
      await expect(
        editor.getByRole("button", { name: "Save changes", exact: true }),
      ).toBeDisabled();
      for (const name of [
        "Preview selected library",
        "Import selected identities",
      ]) {
        await expect(
          panel.getByRole("button", { name, exact: true }),
        ).toBeDisabled();
      }
      await panel.getByRole("button", { name: "Retry status" }).click();
      await expect(panel.getByRole("alert")).toContainText("Could not refresh");
      const before = await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action !== "snapshot",
        ),
      );
      await stop.click();
      await expect(panel.getByRole("alert")).toContainText(
        "could not persist disabled settings",
      );
      await expect(panel.getByRole("alert")).toContainText("Could not confirm");
      await expect(
        panel.getByText("Showing the last host snapshot", { exact: false }),
      ).toBeVisible();
      if (!previouslyStopped) {
        await expect(
          editor.getByText("Enabled · starts with buzz-app", { exact: true }),
        ).toBeVisible();
        await expect(
          editor.getByText("Process running · relay readiness unverified", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          editor.getByText("Disabled · mentions will not wake this agent"),
        ).toHaveCount(0);
      }
      await expect(
        editor.getByRole("textbox", { name: "System prompt", exact: true }),
      ).toHaveValue("Keep my recovery draft");
      await expect(
        editor.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await expect(stop).toBeEnabled();
      expect(
        await page.evaluate(() =>
          window.agentControlFixture.calls.filter(
            (call) => call.action !== "snapshot",
          ),
        ),
      ).toEqual([
        ...before,
        { action: "stop", payload: { id: "fixture-agent" } },
      ]);
      // Repairing the host does not implicitly retry. A second explicit Stop can recover.
      await page.evaluate(() => window.agentControlFixture.restoreStore());
      await stop.click();
      await expect(panel.getByRole("alert")).toHaveCount(0);
      await expect(
        editor.getByText("Disabled · mentions will not wake this agent"),
      ).toBeVisible();
      await expect(
        editor.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled();
    } finally {
      await server.close();
    }
  });
}
