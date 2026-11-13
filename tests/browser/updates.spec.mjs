import {
  installNativeMediaMenu,
  checkViewerDownloadFeedback,
} from "./media-menu-download.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import {
  openPage,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });

// Native IPC is the boundary fixture; the updater plugin client, the
// updates owner, Settings and the toast are production code. Plugin commands
// are denied unless the main-window capability grants them, as Tauri's ACL does.
async function nativeUpdater(
  page,
  { checkResults, installErrors = [], restartErrors = [], holdChecks = false },
) {
  const capability = JSON.parse(
    await readFile(
      new URL("../../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  );
  const granted = capability.permissions.map((permission) =>
    typeof permission === "string" ? permission : permission.identifier,
  );
  const initializeUpdater = ({
    granted,
    checkResults,
    installErrors,
    restartErrors,
    holdChecks,
  }) => {
    window.isTauri = true;
    window.updaterCalls = [];
    window.checkResults = checkResults;
    const plugins = ["channels", "github", "bestie", "repos"].map((name) => ({
      manifest: { id: `buzz.${name}`, name, apiVersion: 1 },
      source: "bundled",
      enabled: true,
      revision: "bundled",
      previous: null,
      reloadable: false,
      error: null,
    }));
    let nextCallback = 0;
    let nextResource = 100;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++nextCallback,
      unregisterCallback() {},
      invoke: async (command, args) => {
        if (command === "clipboard_write_text") {
          window.clipboardWrites++;
          if (window.holdClipboard)
            await new Promise((_, reject) => {
              window.rejectClipboard = reject;
            });
          if (window.clipboardFails) throw new Error("Clipboard denied");
          return;
        }
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
        // Agent storage starts empty; the app saves agent state there.
        if (command === "app_agent_state_load") return {};
        if (command === "app_agent_state_set") return;
        if (command === "credential_pairing_communities") return;
        const plugin = /^plugin:(updater|resources)\|(\w+)$/.exec(command);
        if (!plugin && command !== "update_restart")
          throw new Error(`Unexpected command ${command}`);
        window.updaterCalls.push({ command, args });
        const [, name, action] = plugin ?? [];
        const permission = plugin
          ? `${name === "resources" ? "core:" : ""}${name}:allow-${action.replaceAll("_", "-")}`
          : "allow-update-restart";
        if (!granted.includes(permission))
          throw new Error(`${command} not allowed. Permissions: ${permission}`);
        if (command === "plugin:updater|check") {
          if (
            holdChecks &&
            window.updaterCalls.filter((call) => call.command === command)
              .length > 1
          )
            await new Promise((resolve) => {
              window.finishCheck = resolve;
            });
          const result = window.checkResults.shift();
          if (typeof result === "string") throw new Error(result);
          return result
            ? {
                rid: ++nextResource,
                version: "1.2.3",
                currentVersion: "1.0.0",
              }
            : null;
        }
        if (command === "plugin:updater|download")
          return new Promise((resolve) => {
            window.finishDownload = () => resolve(++nextResource);
          });
        if (command === "update_restart" && restartErrors.length)
          throw new Error(restartErrors.shift());
        if (command === "plugin:updater|install" && installErrors.length)
          throw new Error(installErrors.shift());
      },
    };
  };
  // One initializer establishes both IPC owners; Playwright does not order separate init scripts.
  await page.addInitScript({
    content: `(${initializeUpdater})(${JSON.stringify({ granted, checkResults, installErrors, restartErrors, holdChecks })});(${installNativeMediaMenu})();`,
  });
}

async function openUpdates(page, app) {
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Software updates");
  return page
    .getByRole("region", { name: "Software updates", exact: true })
    .getByRole("status");
}

const commands = (page) =>
  page.evaluate(() => window.updaterCalls.map((call) => call.command));

// Browser-only: production app portal wiring, CSS visibility, native focus and
// pointer restoration across MediaReviewFrame. The installer remains fake IPC.
test("image review hides the ready update notice until the viewer closes", async ({
  page,
  app,
}, info) => {
  await nativeUpdater(page, { checkResults: [true] });
  await page.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL("../../public/shell-gradient.png", import.meta.url),
      ),
      contentType: "image/png",
    }),
  );
  const imageMessage = app.sign({
    kind: 9,
    content: "Update notice image",
    created_at: 1700000900,
    tags: [
      ["h", "alpha"],
      ["imeta", "url https://primary.example/media/photo.png", "m image/png"],
    ],
  });
  app.histories.get("primary/alpha").push(
    imageMessage,
    app.sign({
      kind: 9,
      content: "```js\nconsole.log('viewer feedback');\n```",
      created_at: 1700000901,
      tags: [
        ["h", "alpha"],
        ["e", imageMessage.id, "", "reply"],
      ],
    }),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect
    .poll(() => page.evaluate(() => typeof window.finishDownload))
    .toBe("function");
  await page.evaluate(() => window.finishDownload());
  const host = page.locator("#buzz-toast-root");
  const notice = host.getByText("Ready to update!");
  await expect(notice).toBeVisible();
  const opener = page.getByRole("link", {
    name: "Open image attachment",
    exact: true,
  });
  await page.evaluate(() => {
    window.reviewEntranceObserved = false;
    window.reviewEntranceObserver = new MutationObserver((records) => {
      if (
        records.some((record) => record.attributeName === "data-review-opening")
      ) {
        window.reviewEntranceObserved = true;
      }
    });
    window.reviewEntranceObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-review-opening"],
    });
  });
  await opener.click();
  const viewer = page.getByRole("dialog", {
    name: "Image viewer",
    exact: true,
  });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("[data-review-stage]")).toBeVisible();
  await expect(notice).toBeAttached();
  await expect(notice).toBeHidden();
  await expect(host).toHaveAttribute("inert", "");
  await expect(viewer).not.toHaveAttribute("data-review-opening");
  await expect
    .poll(() => page.evaluate(() => window.reviewEntranceObserved))
    .toBe(true);
  await page.evaluate(() => window.reviewEntranceObserver.disconnect());
  await checkViewerDownloadFeedback(page, viewer, notice);
  const showComments = viewer.getByRole("button", {
    name: "Show comments",
    exact: true,
  });
  if (await showComments.count()) await showComments.click();
  await page.evaluate(() => {
    window.clipboardWrites = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          window.clipboardWrites++;
          if (window.holdClipboard)
            await new Promise((_, reject) => {
              window.rejectClipboard = reject;
            });
          if (window.clipboardFails) throw new Error("Clipboard denied");
        },
      },
    });
  });
  for (const [fails, title] of [
    [true, "Failed to copy code"],
    [false, "Copied code to clipboard"],
  ]) {
    await page.evaluate((value) => {
      window.clipboardFails = value;
    }, fails);
    await viewer
      .getByRole("button", { name: "Copy code block", exact: true })
      .click();
    const feedback = viewer.getByRole("dialog", { name: title, exact: true });
    await expect(feedback).toBeVisible();
    if (fails)
      await page.screenshot({ path: info.outputPath("viewer-copy-error.png") });
    await expect(notice).toBeHidden();
    await expect(host.getByText(title, { exact: true })).toHaveCount(0);
    await feedback
      .getByRole("button", { name: "Dismiss notification" })
      .click();
    await expect(feedback).toBeHidden();
  }
  expect(await page.evaluate(() => window.clipboardWrites)).toBe(2);

  // A result from the closed viewer targets the app host, which the next viewer
  // hides. Its finite lifetime must wait until that destination is visible.
  await page.evaluate(() => {
    window.holdClipboard = true;
  });
  await viewer
    .getByRole("button", { name: "Copy code block", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof window.rejectClipboard))
    .toBe("function");
  try {
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(viewer).toHaveCount(0);
    await opener.click();
    await expect(viewer).toBeVisible();
    await expect(host).toHaveAttribute("inert", "");
    await page.evaluate(() => {
      window.rejectClipboard(new Error("Deferred clipboard failure"));
      delete window.rejectClipboard;
    });
    const lateFeedback = host.getByText("Failed to copy code", { exact: true });
    await expect(lateFeedback).toBeAttached();
    await expect(lateFeedback).toBeHidden();
    await page.clock.fastForward(6000);
    await expect(lateFeedback).toBeAttached();
    await expect(lateFeedback).toBeHidden();
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(viewer).toHaveCount(0);
    await expect(lateFeedback).toBeVisible();
    await page.screenshot({
      path: info.outputPath("late-feedback-after-reopen.png"),
    });
    await page.mouse.move(0, 0);
    await page.clock.runFor(4300);
    await expect(lateFeedback).toHaveCount(0);
  } finally {
    await page.evaluate(() => {
      window.rejectClipboard?.(new Error("Fixture cleanup"));
      delete window.rejectClipboard;
      window.holdClipboard = false;
    });
  }
  await opener.click();
  await expect(viewer).toBeVisible();

  await page.screenshot({ path: info.outputPath("viewer-notice-hidden.png") });
  for (const key of ["Tab", "Shift+Tab", "F6"]) {
    await page.keyboard.press(key);
    await expect
      .poll(() => viewer.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
  }
  // A media control's focused tooltip owns Escape. Return to the frame so
  // this key tests closing the viewer itself, rather than its nested hint.
  await viewer.focus();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(notice).toBeVisible();
  await page.screenshot({
    path: info.outputPath("viewer-closed-notice-restored.png"),
  });
  await host
    .getByRole("button", { name: "Update now", exact: true })
    .click({ trial: true });
  await host
    .getByRole("button", { name: "Dismiss update notification" })
    .click();
  await expect(notice).toHaveCount(0);
  expect(await commands(page)).toEqual([
    "plugin:updater|check",
    "plugin:updater|download",
  ]);
});

test("update checks recover from failure, download, and restart from the toast", async ({
  page,
  app,
}, info) => {
  // The startup background check finds nothing; manual checks consume the rest.
  await nativeUpdater(page, {
    checkResults: [null, null, "network down", true],
    holdChecks: true,
  });
  const status = await openUpdates(page, app);
  const notices = page.getByRole("region", { name: "App notifications" });

  await expect(status).toHaveText("Check if a new version is available.");
  const action = button(page, "Check for updates");
  const card = page
    .getByRole("region", { name: "Software updates", exact: true })
    .locator(".buzz-empty-state");
  // Browser geometry verifies the card and action fit the centered settings column.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        card.evaluate((root) => {
          const bounds = root.getBoundingClientRect();
          return (
            root.scrollWidth <= root.clientWidth &&
            [...root.querySelectorAll("*")].every((node) => {
              const box = node.getBoundingClientRect();
              return box.left >= bounds.left && box.right <= bounds.right;
            })
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`update-card-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await action.focus();
  // Native focus must survive the held IPC check and every result row.
  for (const [label, result] of [
    ["Check for updates", "You're on the latest version."],
    ["Check again", "Update failed: network down"],
    ["Retry", "Downloading update…"],
  ]) {
    await button(page, label).press("Enter");
    await expect(status).toHaveText("Checking for updates…");
    await expect(button(page, "Check for updates")).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => typeof window.finishCheck))
      .toBe("function");
    await page.evaluate(() => {
      window.finishCheck();
      delete window.finishCheck;
    });
    await expect(status).toHaveText(result);
    await expect(
      page
        .getByRole("region", { name: "Software updates", exact: true })
        .getByRole("button"),
    ).toBeFocused();
  }
  await expect(status).toHaveText("Downloading update…");
  await expect(notices.getByText("Ready to update!")).toHaveCount(0);

  await page.evaluate(() => window.finishDownload());
  await expect(status).toHaveText("Ready to install. Buzz will restart.");
  await button(page, "Appearance").click();
  await expect(notices.getByText("Ready to update!")).toBeVisible();
  await expect(notices.getByText("Click to update")).toBeVisible();
  await notices
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  await expect
    .poll(() => commands(page))
    .toEqual([
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:updater|install",
      "update_restart",
    ]);
  const install = await page.evaluate(() =>
    window.updaterCalls.find((c) => c.command === "plugin:updater|install"),
  );
  expect(install.args).toEqual({ updateRid: 101, bytesRid: 102 });
});

test("retry after a failed install releases native update resources before checking again", async ({
  page,
  app,
}) => {
  await nativeUpdater(page, {
    checkResults: [true, true],
    installErrors: ["read-only location"],
    restartErrors: ["shutdown refused"],
  });
  const status = await openUpdates(page, app);
  await expect(status).toHaveText("Downloading update…");
  await page.evaluate(() => window.finishDownload());
  await button(page, "Appearance").click();
  await page
    .getByRole("region", { name: "App notifications" })
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  const notices = page.getByRole("region", { name: "App notifications" });
  await expect(
    notices.getByText("Update failed", { exact: true }),
  ).toBeVisible();
  await expect(notices.getByText("read-only location")).toBeVisible();
  await notices.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(notices.getByText("Downloading update...")).toBeVisible();
  const calls = await page.evaluate(() => window.updaterCalls);
  expect(calls.slice(3).map(({ command, args }) => [command, args])).toEqual([
    ["plugin:resources|close", { rid: 102 }],
    ["plugin:resources|close", { rid: 101 }],
    [
      "plugin:updater|check",
      { headers: [["cache-control", "no-cache"]], timeout: 30_000 },
    ],
    [
      "plugin:updater|download",
      expect.objectContaining({ rid: 103, timeout: 1_800_000 }),
    ],
  ]);
  await page.evaluate(() => window.finishDownload());
  await notices
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  await expect(notices.getByText("shutdown refused")).toBeVisible();
  await notices.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    notices.getByText("You're on the latest version."),
  ).toBeVisible();
});

test("the ready toast yields to Settings → Updates, which offers the same action", async ({
  page,
  app,
}) => {
  // Default main window size (src-tauri/tauri.conf.json).
  await page.setViewportSize({ width: 1200, height: 800 });
  await nativeUpdater(page, { checkResults: [true] });
  const status = await openUpdates(page, app);
  const toast = page
    .getByRole("region", { name: "App notifications" })
    .getByText("Ready to update!");
  await page.evaluate(() => window.finishDownload());
  await expect(status).toHaveText("Ready to install. Buzz will restart.");
  await expect(toast).toHaveCount(0);

  await button(page, "Appearance").click();
  await expect(toast).toBeVisible();
  // Toasts layer above dialogs, so the action stays usable over Settings.
  await page
    .getByRole("region", { name: "App notifications" })
    .getByRole("button", { name: "Update now", exact: true })
    .click({ trial: true });
  await button(page, "Software updates").click();
  await expect(toast).toHaveCount(0);

  await button(page, "Update now").click();
  await expect
    .poll(() => commands(page))
    .toEqual([
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:updater|install",
      "update_restart",
    ]);
});
