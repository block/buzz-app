import { test, expect } from "@playwright/test";
import { createServer } from "../../../tests/browser/vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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
  // Webhook drafts save like any other; the relay issues the secret on the first save.
  await expect(button("Save workflow")).toBeEnabled();
  await expect(
    page.getByText(/Webhook-trigger saves are unavailable/),
  ).toHaveCount(0);
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
  await expect(button("Close editor")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(button("Close editor")).toHaveCSS(
    "background-color",
    "rgb(51, 51, 51)",
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

test("keyboard switches feed enabled-save confirmation and disabled readback", async ({
  page,
  browserName,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const enabled = page.getByRole("switch", {
    name: "Enabled in configuration",
  });
  const reply = page.getByRole("switch", {
    name: "Reply in the triggering thread",
  });
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const focusByTab = async (control) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await control.evaluate((node) => node === document.activeElement))
        return;
      await page.keyboard.press(tab);
    }
    await expect(control).toBeFocused();
  };
  const saves = () => page.evaluate(() => window.workflowFixture.calls.save);
  const savedYaml = async () =>
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml));

  await button("New workflow").click();
  const name = page.getByLabel("Workflow name", { exact: true });
  await name.fill("Keyboard workflow");
  await button("Add Send Message").click();
  await page.getByLabel("Message text", { exact: true }).fill("Offline only");
  await name.focus();
  await page.keyboard.press(tab);
  await expect(enabled).toBeFocused();
  await expect(enabled).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(enabled).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(enabled).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(enabled).toBeChecked();

  await focusByTab(reply);
  await page.keyboard.press("Enter");
  await expect(reply).toBeChecked();
  await page.keyboard.press("Space");
  await expect(reply).not.toBeChecked();
  await page.keyboard.press("Enter");
  await expect(reply).toBeChecked();
  await focusByTab(button("Save workflow"));
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("It will run for every new message");
  await expect(button("Keep editing")).toBeFocused();
  expect(await saves()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button("Save workflow")).toBeFocused();
  expect(await saves()).toBe(0);
  await page.keyboard.press("Space");
  await expect(button("Keep editing")).toBeFocused();
  await page.keyboard.press(tab);
  await expect(button("Save enabled workflow")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(saves).toBe(1);
  expect((await savedYaml()).enabled).not.toBe(false);
  expect((await savedYaml()).steps[0].reply_in_thread).toBe(true);
  await expect(enabled).toBeDisabled();
  await expect(reply).toBeDisabled();
  await enabled.click({ force: true });
  await enabled.press("Space");
  await reply.press("Enter");
  await expect(enabled).toBeChecked();
  await expect(reply).toBeChecked();
  expect(await saves()).toBe(1);

  // The offline capability supplies the exact asynchronous receipt/readback.
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save workflow")).toBeEnabled();
  await expect(enabled).toBeChecked();
  await expect(reply).toBeChecked();
  await page
    .getByLabel("Message text", { exact: true })
    .fill("Ordinary enabled edit");
  await button("Save workflow").click();
  await expect.poll(saves).toBe(2);
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save workflow")).toBeEnabled();
  await name.focus();
  await page.keyboard.press(tab);
  await expect(enabled).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(enabled).not.toBeChecked();
  await focusByTab(reply);
  await page.keyboard.press("Space");
  await expect(reply).not.toBeChecked();
  await focusByTab(button("Save workflow"));
  await page.keyboard.press("Enter");
  await expect.poll(saves).toBe(3);
  await expect(dialog).toHaveCount(0);
  expect((await savedYaml()).enabled).toBe(false);
  expect((await savedYaml()).steps[0].reply_in_thread).not.toBe(true);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(enabled).toBeEnabled();
  await expect(enabled).not.toBeChecked();
  await expect(reply).not.toBeChecked();
  await enabled.click();
  await button("Save workflow").click();
  await expect(dialog).toContainText("It will run for every new message");
  expect(await saves()).toBe(3);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("history stays lazy and paged; acknowledging an unknown run never repeats it", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  expect(await page.evaluate(() => window.workflowFixture.calls.runs)).toBe(0);
  await button("Read runs").click();
  await expect(page.getByText("Current step: 1")).toBeVisible();
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
  await expect(page.getByText(/The run may have started/)).toBeVisible();
  const id = await page.evaluate(
    () =>
      window.workflowFixture.capability.operations.snapshot().at(-1).eventId,
  );
  await button("Close editor").click();
  await button("Message helper").click();
  await expect(button("Run now")).toBeDisabled();
  await expect(button("Save workflow")).toBeDisabled();
  expect(await page.evaluate(() => window.workflowFixture.calls.trigger)).toBe(
    1,
  );
  await button("Dismiss notice").click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "does not undo, cancel or repeat",
  );
  await button("Dismiss notice and continue").click();
  await expect(button("Run now")).toBeEnabled();
  await expect(button("Save workflow")).toBeEnabled();
  expect(
    await page.evaluate(() => window.workflowFixture.calls.dismiss),
  ).toEqual([id]);
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
  await expect(
    page.getByText("Automations that keep your community moving.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(button("New workflow")).toBeDisabled();
  await expect(button("Open Fixture A helper")).toBeVisible();
  await expect(
    page.getByRole("switch", {
      name: "Enabled in configuration: Fixture A helper",
      exact: true,
    }),
  ).toBeDisabled();
  await button("Open Fixture A helper").click();
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toBeVisible();
  await button("Close editor").click();
  await expect(button("Open Fixture A helper")).toBeVisible();
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

test("landing bounds workflow reads across more than sixteen channels", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?many"));
  await expect(
    page.getByRole("button", { name: "Open Fixture A helper", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.definitionQueries()),
    )
    .toBeGreaterThanOrEqual(17);
  expect(errors).toEqual([]);
});

test("landing scan survives channel presentation churn without restarting", async ({
  page,
}) => {
  await page.goto(
    url.replace("/fixture.html", "/session-fixture.html?many&hold"),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.definitionReadHeld()),
    )
    .toBe(true);
  const startedReads = await page.evaluate(() =>
    window.workflowSessionFixture.definitionQueries(),
  );
  const create = page.getByRole("button", {
    name: "New workflow",
    exact: true,
  });
  const open = page.getByRole("button", {
    name: "Open Fixture A helper",
    exact: true,
  });
  await expect(open).toBeVisible();
  // Browser-only boundary: progressive empty results must not move either
  // actionable card under the pointer. Reads remain held until after metadata.
  const createBounds = await create.boundingBox();
  const openBounds = await open.boundingBox();
  try {
    await expect(page.getByRole("status")).toHaveText("Reading workflows…");
    for (let index = 1; index <= 8; index++) {
      await page.evaluate(() =>
        window.workflowSessionFixture.renameFirstChannel(),
      );
      await expect(
        page.getByText(
          `#${index % 2 ? "Z-last" : "A-first"} channel ${index}`,
          { exact: true },
        ),
      ).toBeVisible();
    }
    expect(
      await page.evaluate(() =>
        window.workflowSessionFixture.definitionQueries(),
      ),
    ).toBe(startedReads);
    expect(await create.boundingBox()).toEqual(createBounds);
    expect(await open.boundingBox()).toEqual(openBounds);
  } finally {
    await page.evaluate(() =>
      window.workflowSessionFixture.releaseDefinitionRead(),
    );
  }
  await expect(page.getByRole("status")).toHaveText(
    "Workflow discovery complete.",
  );
  expect(
    await page.evaluate(() =>
      window.workflowSessionFixture.definitionChannelCount(),
    ),
  ).toBe(17);
  expect(
    await page.evaluate(() =>
      window.workflowSessionFixture.definitionQueries(),
    ),
  ).toBe(17);
  expect(await create.boundingBox()).toEqual(createBounds);
  expect(await open.boundingBox()).toEqual(openBounds);
});

test("clearing the session cache purges landing workflow definitions", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const open = page.getByRole("button", {
    name: "Open Fixture A helper",
    exact: true,
  });
  await expect(open).toBeVisible();
  await page
    .getByRole("button", { name: "Clear session cache", exact: true })
    .click();
  await expect(open).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Fixture A helper",
  );
});

test("landing discards an opened definition when channel access is revoked", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Open Fixture A helper").click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Revoked landing draft");
  await button("Revoke selected channel").click();
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Revoked landing draft",
  );
  await page.evaluate(() => window.workflowSessionFixture.restoreAccess());
  await expect(button("Open Fixture A helper")).toBeVisible();
  await button("Open Fixture A helper").click();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Fixture A helper",
  );
});

test("landing activation confirms once and locks while delivery is unresolved", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const enable = page.getByRole("switch", {
    name: "Enabled in configuration: Fixture A helper",
    exact: true,
  });
  await enable.click();
  await expect(
    page.getByRole("alertdialog", { name: "This workflow may run often" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(1);
    await expect(enable).toBeDisabled();
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.reject());
  }
  await expect(enable).toBeEnabled();
  expect(
    await page.evaluate(() => window.workflowSessionFixture.publications()),
  ).toBe(1);
});

test("landing keeps a succeeded toggle locked until its exact revision is read back", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const enable = page.getByRole("switch", {
    name: "Enabled in configuration: Fixture A helper",
    exact: true,
  });
  await enable.click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await page.evaluate(() => window.workflowSessionFixture.settle());
  await expect(enable).toBeDisabled();
  await page.evaluate(() => window.workflowSessionFixture.readback());
  await page
    .getByRole("button", { name: "Refresh workflows", exact: true })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Enabled in configuration: Fixture A helper",
      exact: true,
    }),
  ).toBeEnabled();
});

test("landing keeps a workflow locked while deletion remains undismissed", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Open Fixture A helper").click();
  await button("Delete workflow").click();
  await button("Request deletion").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await button("Close editor").click();
  await button("Leave draft").click();
  const enable = page.getByRole("switch", {
    name: "Enabled in configuration: Fixture A helper",
    exact: true,
  });
  await expect(enable).toBeDisabled();
  await page.evaluate(() => window.workflowSessionFixture.settleDelete());
  await expect
    .poll(() =>
      page.evaluate(
        () => window.workflowSessionFixture.operations().at(-1)?.outcome,
      ),
    )
    .toBe("succeeded");
  await expect(enable).toBeDisabled();
  expect(
    await page.evaluate(() => window.workflowSessionFixture.publications()),
  ).toBe(1);
});

test("a lost save response can be checked and adopted without resubmitting", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Saved without response");
  await button("Save workflow").click();
  await page.evaluate(() => {
    window.workflowFixture.saveOnServer();
    window.workflowFixture.finish("unknown");
  });
  await expect(button("Save workflow")).toBeDisabled();
  await button("Check saved configuration").click();
  await expect(button("Save workflow")).toBeEnabled();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Saved without response",
  );
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(1);
  await page
    .getByLabel("Message text", { exact: true })
    .fill("Edit after recovery");
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
});

test("different-head recovery needs explicit review; failed dismissal keeps the draft locked", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Retained local draft");
  await button("Save workflow").click();
  await page.evaluate(() => {
    window.workflowFixture.saveOnServer(false);
    window.workflowFixture.finish("unknown");
  });
  await button("Check saved configuration").click();
  await expect(button("Save workflow")).toBeDisabled();
  await expect(button("Review current configuration")).toBeVisible();
  await button("Dismiss notice").click();
  await page.keyboard.press("Escape");
  await expect(button("Save workflow")).toBeDisabled();
  expect(
    await page.evaluate(() => window.workflowFixture.calls.dismiss),
  ).toEqual([]);
  await page.evaluate(() =>
    window.workflowFixture.setDismissError("Fixture dismissal failed"),
  );
  await button("Dismiss notice").click();
  await button("Dismiss notice and continue").click();
  await expect(page.getByRole("alert")).toHaveText("Fixture dismissal failed");
  await page.keyboard.press("Escape");
  await expect(button("Save workflow")).toBeDisabled();
  await page.evaluate(() => window.workflowFixture.setDismissError());
  await button("Dismiss notice").click();
  await button("Dismiss notice and continue").click();
  await expect(button("Save workflow")).toBeEnabled();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Retained local draft",
  );
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(1);
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
});

test("optimistic dismissal keeps confirmation mounted until persistence settles", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  await page.getByLabel("Workflow name", { exact: true }).fill("Kept draft");
  await button("Save workflow").click();
  await page.evaluate(() => window.workflowFixture.finish("unknown"));
  const operationId = await page.evaluate(
    () => window.workflowFixture.capability.operations.snapshot()[0].eventId,
  );
  const dialog = page.getByRole("alertdialog", {
    name: "Dismiss this notice?",
  });
  for (const fail of [true, false]) {
    await page.evaluate((fail) => {
      window.workflowFixture.setDismissError(
        fail ? "Journal unavailable" : undefined,
      );
      window.workflowFixture.holdDismiss();
    }, fail);
    await button("Dismiss notice").click();
    try {
      await button("Dismiss notice and continue").click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.workflowFixture.capability.operations.snapshot().length,
          ),
        )
        .toBe(0);
      await expect(dialog).toBeVisible();
      await expect(button("Dismissing…")).toBeDisabled();
      await expect(button("Keep editing")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      // The modal must keep navigation/submission inaccessible during the gap.
      await expect(button("Close editor")).toHaveCount(0);
      await expect(button("New workflow")).toHaveCount(0);
      expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(
        1,
      );
    } finally {
      await page.evaluate(() => window.workflowFixture.releaseDismiss());
    }
    if (fail) {
      await expect(dialog.getByRole("alert")).toHaveText("Journal unavailable");
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.workflowFixture.capability.operations
              .snapshot()
              .map((op) => op.eventId),
          ),
        )
        .toEqual([operationId]);
      await page.keyboard.press("Escape");
      await expect(button("Save workflow")).toBeDisabled();
      await expect(
        page.getByLabel("Workflow name", { exact: true }),
      ).toHaveValue("Kept draft");
    } else {
      await expect(dialog).toHaveCount(0);
      await expect(button("Save workflow")).toBeEnabled();
      await expect(
        page.getByLabel("Workflow name", { exact: true }),
      ).toHaveValue("Kept draft");
    }
  }
  expect(
    await page.evaluate(() => window.workflowFixture.calls.dismiss),
  ).toEqual([operationId, operationId]);
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(1);
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
});

test("legacy deletion is a request, not verified runtime removal", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  await button("Delete workflow").click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "does not confirm runtime deletion",
  );
  await button("Request deletion").click();
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(
    page.getByText(/Deletion request accepted\. The saved configuration/),
  ).toBeVisible();
  await expect(button("Message helper")).toBeVisible();
  await button("Dismiss notice").click();
  await button("Dismiss notice and continue").click();
  await expect(button("Save workflow")).toBeEnabled();
  expect(await page.evaluate(() => window.workflowFixture.calls.delete)).toBe(
    1,
  );
});

test("invalid timeout text stays in the draft and blocks saves in both editor modes", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  await page.getByText("Step options", { exact: true }).click();
  const timeout = page.getByLabel("Step timeout (optional)", { exact: true });
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  for (const input of ["oops", "0s", "1.5", "9007199254740992"]) {
    await timeout.fill(input);
    await expect(timeout).toHaveValue(input);
    await expect(button("Save workflow")).toBeDisabled();
    await expect(timeout).toHaveAttribute("aria-invalid", "true");
    await expect(timeout).toHaveAccessibleDescription(/positive whole number/);
    await page.getByRole("tab", { name: "YAML", exact: true }).click();
    expect(parseYaml(await yaml.inputValue()).steps[0].timeout_secs).toBe(
      input,
    );
    await expect(button("Save workflow")).toBeDisabled();
    await expect(yaml).toHaveAttribute("aria-invalid", "true");
    await expect(yaml).toHaveAccessibleDescription(/positive whole number/);
    await page.getByRole("tab", { name: "Form", exact: true }).click();
    await expect(timeout).toBeVisible();
    await expect(timeout).toHaveValue(input);
  }
  await button("Close editor").click();
  await expect(
    page.getByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeVisible();
  await button("Keep editing").click();
  await expect(timeout).toHaveValue("9007199254740992");
  await timeout.fill("");
  await expect(timeout).toBeVisible();
  await expect(timeout).toBeFocused();
  for (const character of "5m") {
    await page.keyboard.type(character);
    await expect(timeout).toBeVisible();
    await expect(timeout).toBeFocused();
  }
  await expect(timeout).toHaveValue("5m");
  await expect(button("Save workflow")).toBeEnabled();
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  expect(
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml))
      .steps[0].timeout_secs,
  ).toBe(300);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save workflow")).toBeEnabled();
  // Successful save mounts a fresh editor; opening its optional section is separate
  // from keeping the current draft open throughout validation recovery.
  if (!(await timeout.isVisible()))
    await page.getByText("Step options", { exact: true }).click();
  await timeout.fill(" ");
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(2);
  expect(
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml))
      .steps[0],
  ).not.toHaveProperty("timeout_secs");
});

test("schedule presets round-trip into YAML and warn before enabling a frequent one", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const preset = (name) => page.getByRole("radio", { name, exact: true });
  // Native inputs sit visually hidden behind the pills; click the pill.
  const pill = (name) =>
    page.locator(".workflow-pill-label", { hasText: name });
  const reply = page.getByRole("switch", {
    name: "Reply in the triggering thread",
  });
  const savedTrigger = async () => {
    await tab("YAML").click();
    const trigger = parseYaml(await yaml.inputValue()).trigger;
    await tab("Form").click();
    return trigger;
  };

  await button("New workflow").click();
  await button("Add Send Message").click();
  await page.getByLabel("Message text", { exact: true }).fill("On a timer");
  await reply.click();
  await expect(reply).toBeChecked();
  await page.getByRole("combobox", { name: "Trigger", exact: true }).click();
  await page.getByRole("option", { name: "Schedule", exact: true }).click();
  await expect(preset("Daily")).toBeChecked();
  await expect(page.getByLabel("Run time (UTC)", { exact: true })).toHaveValue(
    "09:00",
  );
  await expect(reply).toHaveCount(0);
  await expect(page.getByText("Trigger options", { exact: true })).toHaveCount(
    0,
  );
  const daily = await savedTrigger();
  expect(daily).toEqual({ on: "schedule", cron: "0 9 * * *" });
  await tab("YAML").click();
  expect(parseYaml(await yaml.inputValue()).steps[0]).not.toHaveProperty(
    "reply_in_thread",
  );
  await tab("Form").click();

  await pill("Weekly").click();
  await expect(preset("Weekly")).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Monday" })).toBeChecked();
  await page.locator(".workflow-pill-label", { hasText: /^F$/ }).click();
  await expect(page.getByRole("checkbox", { name: "Friday" })).toBeChecked();
  await page.getByLabel("Run time (UTC)", { exact: true }).fill("14:30");
  expect(await savedTrigger()).toEqual({
    on: "schedule",
    cron: "30 14 * * 2,6",
  });
  await expect(preset("Weekly")).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Friday" })).toBeChecked();

  await pill("Monthly").click();
  await page.getByRole("combobox", { name: "Day of month" }).click();
  await page.getByRole("option", { name: "31", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "won’t run in some months",
  );
  expect(await savedTrigger()).toEqual({
    on: "schedule",
    cron: "30 14 31 * *",
  });

  await pill("Every 15 minutes").click();
  expect(await savedTrigger()).toEqual({ on: "schedule", interval: "15m" });
  await expect(preset("Every 15 minutes")).toBeChecked();
  await expect(page.getByLabel("Run time (UTC)", { exact: true })).toHaveCount(
    0,
  );

  await pill("Custom cron").click();
  const minute = page.getByRole("textbox", { name: "Minute", exact: true });
  await expect(minute).toHaveValue("*/15");
  await minute.focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("textbox", { name: "Hour", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("*/2");
  expect(await savedTrigger()).toEqual({
    on: "schedule",
    cron: "*/15 */2 * * *",
  });
  await expect(preset("Custom cron")).toBeChecked();

  await pill("Every hour").click();
  await page.getByRole("switch", { name: "Enabled in configuration" }).click();
  await button("Save workflow").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(
    "It is scheduled to run every 1 hour. Review the schedule before turning it on.",
  );
  expect(await page.evaluate(() => window.workflowFixture.calls.save)).toBe(0);
  await button("Save enabled workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  expect(
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml))
      .trigger,
  ).toEqual({ on: "schedule", interval: "1h" });
  expect(errors).toEqual([]);
});

test("a webhook save shows its one-time secret once and asks before leaving it behind", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copied.push(text);
        },
      },
    });
  });
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const reply = page.getByRole("switch", {
    name: "Reply in the triggering thread",
  });
  const secretValue = "fixture-webhook-secret-2f6c";
  const hookUrl =
    "https://relay.example.test/hooks/66666666-6666-4666-8666-666666666666";

  await button("New workflow").click();
  await page.getByLabel("Workflow name", { exact: true }).fill("Hook helper");
  await button("Add Send Message").click();
  await page.getByLabel("Message text", { exact: true }).fill("Hook received");
  await reply.click();
  await expect(reply).toBeChecked();
  await page.getByRole("combobox", { name: "Trigger", exact: true }).click();
  await page.getByRole("option", { name: "Webhook", exact: true }).click();
  await expect(
    page.getByText(/A unique URL is generated after creation/),
  ).toBeVisible();
  await expect(reply).toHaveCount(0);
  await expect(page.getByText("Trigger options", { exact: true })).toHaveCount(
    0,
  );
  await tab("YAML").click();
  const parsed = parseYaml(await yaml.inputValue());
  expect(parsed.trigger).toEqual({ on: "webhook" });
  expect(parsed.steps[0]).not.toHaveProperty("reply_in_thread");
  await tab("Form").click();
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  await button("Complete save with webhook secret").click();

  const dialog = page.getByRole("dialog", { name: "Webhook ready" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("webhook-url")).toHaveText(hookUrl);
  await expect(dialog.getByTestId("webhook-secret")).toHaveText("•".repeat(24));
  expect(await page.evaluate(() => window.workflowFixture.calls.take)).toBe(1);
  expect(await dialog.textContent()).not.toContain(secretValue);
  // Dismissing before revealing or copying asks first; going back keeps the dialog.
  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog", {
    name: "Continue without this secret?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Reveal webhook secret" }).click();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText(secretValue);
  await dialog.getByRole("button", { name: "Hide webhook secret" }).click();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText("•".repeat(24));
  await dialog
    .getByRole("button", { name: "Copy secret", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Secret copied.");
  await dialog.getByRole("button", { name: "Copy URL", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("URL copied.");
  expect(await page.evaluate(() => window.__copied)).toEqual([
    secretValue,
    hookUrl,
  ]);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // The hand-off happened once (StrictMode included) and nothing retains the value.
  expect(await page.evaluate(() => window.workflowFixture.calls.take)).toBe(1);
  const operations = await page.evaluate(() =>
    window.workflowFixture.capability.operations.snapshot(),
  );
  expect(operations.at(-1)).toMatchObject({
    action: "save",
    outcome: "succeeded",
  });
  expect(operations.at(-1)).not.toHaveProperty("secretHeld");
  expect(JSON.stringify(operations)).not.toContain(secretValue);
  expect(
    await page.evaluate(
      (id) => window.workflowFixture.capability.takeWebhookSecret(id),
      operations.at(-1).eventId,
    ),
  ).toBeUndefined();
  await expect(button("Save workflow")).toBeEnabled();
  expect(errors).toEqual([]);
});

// Browser boundary: the routed page must deliver a real session's late receipt
// after its editor unmounts, without losing the dialog's focus/masking behavior.
// Receipt and purge permutations belong in session/owner component tests.
test("late webhook receipt survives navigation and exact readback on the landing", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const caveat = page.getByText(
    /Saving a disabled configuration does not confirm/,
  );
  await expect(caveat).toBeVisible();
  await button("Open Fixture A helper").click();
  await expect(caveat).toBeVisible();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  await yaml.fill(
    (await yaml.inputValue()).replace("on: message_posted", "on: webhook"),
  );
  await button("Save workflow").click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(1);
    await button("All workflows").click();
    await page
      .getByRole("alertdialog", { name: "Change channel?" })
      .getByRole("button", { name: "Change channel", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Workflow editor" }),
    ).toHaveCount(0);
    await page.evaluate(() => window.workflowSessionFixture.readback());
    await button("Refresh workflows").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.workflowSessionFixture.operations().at(-1)?.outcome,
        ),
      )
      .toBe("succeeded");
    await expect(
      page.getByRole("dialog", { name: "Webhook ready" }),
    ).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settleSave());
  }
  const dialog = page.getByRole("dialog", { name: "Webhook ready" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText("•".repeat(24));
  await dialog
    .getByRole("button", { name: "Reveal webhook secret", exact: true })
    .click();
  await expect(dialog.getByTestId("webhook-secret")).toHaveText(
    "fixture-late-webhook-secret",
  );
  await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.workflowSessionFixture.state("connected"));
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button("Refresh workflows")).toBeEnabled();
});

test("both Add actions allocate unused IDs after a very large parsed ID", async ({
  page,
}) => {
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Message helper").click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  const definition = parseYaml(await yaml.inputValue());
  definition.steps[0].id = "step_9007199254740992";
  // JSON is YAML, and avoids testing a second serializer in this browser fixture.
  await yaml.fill(JSON.stringify(definition));
  await page.getByRole("tab", { name: "Form", exact: true }).click();
  await button("Add Send Message").click();
  await page
    .getByLabel("Message text", { exact: true })
    .nth(1)
    .fill("Another message");
  await button("Add Delay").click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  expect(
    parseYaml(await yaml.inputValue()).steps.map((step) => step.id),
  ).toEqual(["step_9007199254740992", "step_1", "step_2"]);
});

test("real session reconnect retains unsaved YAML and an in-flight returned run ID", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByRole("combobox", { name: "Channel", exact: true }).click();
  await page
    .getByRole("option", { name: "First channel", exact: true })
    .click();
  await button("Fixture A helper").click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  const original = await yaml.inputValue();
  const edited = original.replace(
    "Hello from a fixture",
    "Unsaved reconnect draft",
  );
  expect(edited).not.toBe(original);
  await yaml.fill(edited);
  await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
  await expect(page.getByText(/Connection interrupted/)).toBeVisible();
  await expect(yaml).toHaveValue(edited);
  await page.evaluate(() => window.workflowSessionFixture.state("connected"));
  await button("Refresh configurations").click();
  await expect(page.getByText(/Connection interrupted/)).toHaveCount(0);
  await expect(yaml).toHaveValue(edited);
  await yaml.fill(original);
  await button("Run now").click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(1);
    await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
    await expect(
      page.getByText("Requesting a run…", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settle());
  }
  await expect(
    page.getByText("Run requested. Inspect run history for its result.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Delivery details", { exact: true }).click();
  await expect(
    page.getByText("Returned run ID: 33333333-3333-4333-8333-333333333333", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(yaml).toHaveValue(original);
  await button("Revoke selected channel").click();
  await expect(yaml).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Workflow operations" }),
  ).toHaveCount(0);
});

test("generic Outbox offers message retry but no workflow replay", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByRole("combobox", { name: "Channel", exact: true }).click();
  await page
    .getByRole("option", { name: "First channel", exact: true })
    .click();
  await button("Fixture A helper").click();
  await button("Run now").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await page.evaluate(() => window.workflowSessionFixture.reject());
  await expect(
    page.getByText("Run request was rejected.", { exact: true }),
  ).toBeVisible();
  await page.getByText("Outbox · 1 items", { exact: true }).click();
  const outbox = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Outbox ·/ }) });
  await expect(outbox.getByText(/Not sent/)).toBeVisible();
  await expect(
    outbox.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.workflowSessionFixture.sendMessage());
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(2);
  await page.evaluate(() => window.workflowSessionFixture.reject());
  const message = outbox
    .getByRole("listitem")
    .filter({ hasText: "Retryable message" });
  await expect(message).toContainText("Not sent");
  await message.getByRole("button", { name: "Retry", exact: true }).click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(3);
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settle());
  }
  await expect(message).toContainText("Sent");
  await expect(
    outbox.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
});
