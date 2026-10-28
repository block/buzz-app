import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

// Browser boundary: the real launch overlay must release inertness and focus
// before consent, and a declined import must stay declined across page reload.
// Eligibility and sync failure permutations live in the colocated Vitest tests.
test("native legacy import waits for consent after launch and remembers a decline", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    define: { "import.meta.env.VITE_BUZZ_LIVE": '"0"' },
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    const viewer = "a".repeat(64);
    window.isTauri = true;
    window.legacyReads = 0;
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => ++callback,
      unregisterCallback() {},
      invoke: async (command) => {
        if (command === "identity_restore") return viewer;
        if (command === "legacy_communities") {
          window.legacyReads++;
          return [{ relayUrl: "wss://old.example", pubkey: viewer }];
        }
        if (command === "deep_link_take") return [];
        if (command === "deep_link_watch" || command === "get_os_idle_seconds")
          return null;
        if (command === "app_agent_state_load") return {};
        if (command === "app_agent_state_set") return;
        if (command === "keep_awake_set") return;
        if (command === "plugin_catalog")
          return {
            status: "ready",
            externalPluginsPaused: false,
            catalog: {
              profile: "fixture",
              location: "isolated IPC",
              plugins: [],
            },
          };
        throw new Error(`Unexpected fixture native command: ${command}`);
      },
    };
    window.fetch = () => {
      throw new Error("No development broker");
    };
  });
  try {
    await server.listen();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    const dialog = page.getByRole("alertdialog", {
      name: "Import communities from old Buzz?",
    });
    await expect(dialog).toBeVisible();
    await expect(page.locator("#buzz-launch")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`buzz-client.v1:${"a".repeat(64)}`),
      ),
    ).toBeNull();
    await expect(dialog.getByRole("list")).toHaveText("https://old.example");
    await page.screenshot({
      path: test.info().outputPath("consent-light.png"),
    });
    await page.setViewportSize({ width: 390, height: 620 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => {
      localStorage.setItem("buzz-font-scale.v1", "1.5");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "buzz-font-scale.v1",
          storageArea: localStorage,
        }),
      );
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    await expect(page.locator("html")).toHaveCSS("font-size", "24px");
    await dialog.getByRole("button", { name: "Skip import" }).focus();
    await page.keyboard.press("Tab");
    const approve = dialog.getByRole("button", {
      name: "Import communities",
      exact: true,
    });
    await expect(approve).toBeFocused();
    await expect(approve).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: "Skip import" }),
    ).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: test.info().outputPath("consent-dark-narrow.png"),
    });
    await dialog.getByRole("button", { name: "Skip import" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Join a community" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem(`buzz-legacy-communities.v1:${"a".repeat(64)}`),
        ),
      )
      .toBe("1");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Join a community" }),
    ).toBeVisible();
    await expect(page.locator("#buzz-launch")).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.legacyReads)).toBe(0);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
