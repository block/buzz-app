import { test, expect, ids } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  actionProfile: true,
  exactMessages: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
  readState: true,
  developmentReact: true,
  agentManagement: true,
  agentPeers: true,
});

const request = (requestId, model) => ({
  kind: "agent_management_request",
  channelId: ids.alpha,
  payload: {
    type: "agent_management_request",
    action: "update",
    requestId,
    request: {
      channelId: ids.alpha,
      agentName: "Fixture agent",
      model,
    },
  },
});

test("dismisses without saving, persists on save, and queues a second request", async ({
  page,
  app,
}) => {
  const editor = page.getByRole("dialog", {
    name: "Edit agent",
    exact: true,
  });
  const savedCalls = () =>
    page.evaluate(() =>
      window.agentManagementFixture.calls.filter(
        (call) => call.action === "save",
      ),
    );
  const savedModel = () =>
    page.evaluate(() => window.agentManagementFixture.agent.harness.model);

  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  expect(app.managementKey).toBeDefined();

  app.observer(request("dismiss", "gpt-6-sol"), app.managementKey);
  await expect(editor).toBeVisible();
  await expect(
    editor.getByText(
      "Requested by an agent. Review every field before saving.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(editor.getByRole("combobox", { name: "Model" })).toHaveValue(
    "gpt-6-sol",
  );
  await editor.getByRole("button", { name: "Close editor" }).click();
  await expect(editor).toHaveCount(0);
  expect(await savedCalls()).toEqual([]);
  expect(await savedModel()).toBe("fixture-model");

  app.observer(request("save", "gpt-6-sol"), app.managementKey);
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(savedModel).toBe("gpt-6-sol");
  expect(await savedCalls()).toHaveLength(1);

  app.observer(request("queue-one", "queued-first"), app.managementKey);
  await expect(editor.getByRole("combobox", { name: "Model" })).toHaveValue(
    "queued-first",
  );
  app.observer(request("queue-two", "queued-second"), app.managementKey);
  await expect(editor.getByRole("combobox", { name: "Model" })).toHaveValue(
    "queued-first",
  );
  await editor.getByRole("button", { name: "Close editor" }).click();
  await expect(editor.getByRole("combobox", { name: "Model" })).toHaveValue(
    "queued-second",
  );
  await editor.getByRole("button", { name: "Close editor" }).click();
  await expect(editor).toHaveCount(0);
  expect(await savedCalls()).toHaveLength(1);
  expect(await savedModel()).toBe("gpt-6-sol");
});

test("keeps reviewer edits through a failed save and status recovery", async ({
  page,
  app,
}) => {
  const editor = page.getByRole("dialog", {
    name: "Edit agent",
    exact: true,
  });
  const model = editor.getByRole("combobox", { name: "Model" });
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  expect(app.managementKey).toBeDefined();

  app.observer(request("save-error", "gpt-6-sol"), app.managementKey);
  await expect(editor).toBeVisible();
  await model.fill("reviewer-choice");
  await model.press("Tab");
  await page.evaluate(() => window.agentManagementFixture.failSave(true));
  await editor.getByRole("button", { name: "Save changes" }).click();

  await expect(editor).toBeVisible();
  await expect(model).toHaveValue("reviewer-choice");
  await expect(editor.getByRole("alert")).toContainText(
    "The host could not save settings.",
  );
  await page.evaluate(() => window.agentManagementFixture.failSave(false));
  await editor.getByRole("button", { name: "Retry status" }).click();
  await expect(
    editor.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.agentManagementFixture.agent.harness.model),
    )
    .toBe("reviewer-choice");
});
