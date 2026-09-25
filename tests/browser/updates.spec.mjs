import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });

// Native IPC is the boundary fixture; the updater/process plugin clients, the
// updates owner, Settings and the toast are production code.
async function nativeUpdater(page) {
  await page.addInitScript(() => {
    window.isTauri = true;
    window.updaterCalls = [];
    // Each manual check consumes the next outcome; the startup background check
    // finds nothing.
    window.checkResults = [null, null, "network down", { rid: 1 }];
    const plugins = ["channels", "github", "bestie", "projects"].map(
      (name) => ({
        manifest: { id: `buzz.${name}`, name, apiVersion: 1 },
        source: "bundled",
        enabled: true,
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
      }),
    );
    let nextCallback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++nextCallback,
      unregisterCallback() {},
      invoke: async (command, args) => {
        if (command === "deep_link_take") return [];
        if (command === "deep_link_watch") return;
        if (command === "plugin_catalog")
          return {
            status: "ready",
            externalPluginsPaused: false,
            catalog: {
              profile: "fixture",
              location: "isolated IPC",
              plugins: structuredClone(plugins),
            },
          };
        if (command === "plugin_module") return "export function apply() {}";
        if (!/^plugin:(updater|process|resources)\|/.test(command))
          throw new Error(`Unexpected command ${command}`);
        window.updaterCalls.push({ command, args });
        if (command === "plugin:updater|check") {
          const result = window.checkResults.shift();
          if (typeof result === "string") throw new Error(result);
          return result
            ? { ...result, version: "1.2.3", currentVersion: "1.0.0" }
            : null;
        }
        if (command === "plugin:updater|download")
          return new Promise((resolve) => {
            window.finishDownload = () => resolve(2);
          });
      },
    };
  });
}

test("update checks recover from failure, download, and restart from the toast", async ({
  page,
  app,
}) => {
  await nativeUpdater(page);
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Updates").click();
  const updates = page.getByRole("region", {
    name: "Software Updates",
    exact: true,
  });
  const status = updates.getByRole("status");
  const notices = page.getByRole("region", { name: "App notifications" });

  await expect(status).toHaveText("Check if a new version is available.");
  await button(page, "Check for Updates").click();
  await expect(status).toHaveText("You're on the latest version.");
  await button(page, "Check Again").click();
  await expect(status).toHaveText("Update failed: network down");
  await button(page, "Retry").click();
  await expect(status).toHaveText("Downloading update...");
  await expect(notices.getByText("Ready to update!")).toHaveCount(0);

  await page.evaluate(() => window.finishDownload());
  await expect(status).toHaveText("Update downloaded. Click to apply.");
  await expect(notices.getByText("Ready to update!")).toBeVisible();
  await expect(notices.getByText("Click to update")).toBeVisible();
  await notices
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.updaterCalls.map((c) => c.command)))
    .toEqual([
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:updater|install",
      "plugin:process|restart",
    ]);
  const install = await page.evaluate(() =>
    window.updaterCalls.find((c) => c.command === "plugin:updater|install"),
  );
  expect(install.args).toEqual({ updateRid: 1, bytesRid: 2 });
});
