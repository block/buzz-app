import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function openPlugins(page, origin) {
  await page.goto(origin);
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
}
// Native IPC is the boundary fixture; Settings -> manager -> platform adapter are production.
async function nativeImports(page, samples = []) {
  await page.addInitScript((samples) => {
    window.isTauri = true;
    window.importCalls = [];
    window.importDelay = false;
    const plugins = ["channels", "github", "bestie", "projects"].map(
      (name) => ({
        manifest: { id: `buzz.${name}`, name, apiVersion: 1 },
        source: "bundled",
        enabled: true,
        revision: "bundled",
        previous: null,
        error: null,
      }),
    );
    const ready = () => ({
      status: "ready",
      externalPluginsPaused: false,
      // Real IPC serializes a new snapshot; don't let later fixture writes mutate
      // the manager's previously accepted catalog and bypass reconciliation.
      catalog: {
        profile: "fixture",
        location: "isolated IPC",
        plugins: structuredClone(plugins),
      },
    });
    const preview = {
      token: "preview-one",
      source: "https://github.com/example/plugins",
      commit: "a".repeat(40),
      warnings: ["source-only: No built plugin.js"],
      candidates: samples.length
        ? samples
        : ["one", "two"].map((name) => ({
            path: `plugins/${name}/dist`,
            manifest: {
              id: `example.${name}`,
              name: `Example ${name}`,
              apiVersion: 1,
            },
            revision: name,
          })),
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        window.importCalls.push({ command, args });
        if (command === "plugin_catalog") return ready();
        if (
          command === "plugin_import_folder" ||
          command === "plugin_import_git"
        ) {
          if (window.importDelay)
            await new Promise((resolve) => {
              window.resolveImport = resolve;
            });
          if (args?.repository === "bad")
            throw new Error("Repository unavailable");
          return preview;
        }
        if (command === "plugin_import_discard") return;
        if (command === "plugin_import_install") {
          const candidate = preview.candidates.find(
            (p) => p.path === args.path,
          );
          const existing = plugins.find(
            (p) => p.manifest.id === candidate.manifest.id,
          );
          if (!existing)
            plugins.push({
              ...candidate,
              source: "external",
              enabled: false,
              previous: null,
              error: null,
            });
          return ready();
        }
        if (command === "plugin_change") {
          plugins.find((p) => p.manifest.id === args.id).enabled =
            args.action === "enable";
          return ready();
        }
        if (command === "plugin_module")
          return (
            samples.find((sample) => sample.manifest.id === args.id)?.code ??
            "export function apply() {}"
          );
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, samples);
}

test("browser truthfully offers desktop-only loading", async ({
  page,
  app,
}) => {
  await openPlugins(page, app.origin);
  await expect(
    page.getByText(
      "Open the desktop app to load plugins from a folder or Git repository.",
    ),
  ).toBeVisible();
  await expect(button(page, "Load from folder")).toHaveCount(0);
});

// Real font metrics, text wrapping and icon geometry are not observable in jsdom.
test("Settings text buttons contain enlarged labels without resizing icon buttons", async ({
  page,
  app,
}, info) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  const checkButtons = async (section, scale) => {
    await expect
      .poll(() =>
        section.evaluate((root, scale) => {
          const failures = [];
          const bounds = root.getBoundingClientRect();
          for (const button of root.querySelectorAll("button.buzz-button")) {
            const box = button.getBoundingClientRect();
            if (scale === 100 && box.height !== 36)
              failures.push(`${button.textContent}: default height changed`);
            const text = document.createRange();
            text.selectNodeContents(button);
            for (const line of text.getClientRects()) {
              if (
                line.top < box.top ||
                line.bottom > box.bottom ||
                line.left < box.left ||
                line.right > box.right
              )
                failures.push(
                  `${button.textContent}: content overflows button`,
                );
            }
            if (box.left < bounds.left || box.right > bounds.right)
              failures.push(`${button.textContent}: button overflows section`);
          }
          return failures;
        }, scale),
      )
      .toEqual([]);
  };
  for (const scale of [100, 200]) {
    await button(page, "Appearance").click();
    if (scale === 200) {
      for (let i = 0; i < 10; i++)
        await button(page, "Increase text size").click();
    }
    await expect(page.getByRole("status", { name: "Text size" })).toHaveText(
      `${scale}%`,
    );
    for (const [width, mode] of [
      [320, "Light"],
      [800, "Dark"],
      [1280, "Light"],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await button(page, "Appearance").click();
      const appearance = page.getByRole("region", {
        name: "Appearance",
        exact: true,
      });
      await appearance.getByRole("radio", { name: mode, exact: true }).check();
      await expect(appearance.getByRole("button")).toHaveCount(3);
      await page.evaluate(() => document.fonts.ready);
      await checkButtons(appearance, scale);
      // Shared IconButton must not inherit the enlarged text button's minimum.
      await expect(
        page.getByRole("button", { name: "Find a page", exact: true }),
      ).toHaveAttribute("data-icon-size", "default");
      await expect
        .poll(() =>
          page.locator("button[data-icon-size]").evaluateAll((buttons) =>
            buttons
              .filter((button) => button.getClientRects().length)
              .map((button) => {
                const box = button.getBoundingClientRect();
                const sizes = {
                  compact: 30,
                  toolbar: 32,
                  default: 36,
                  large: 40,
                };
                return (
                  box.width === sizes[button.dataset.iconSize] &&
                  box.height === box.width
                );
              }),
          ),
        )
        .not.toContain(false);
      await button(page, "Plugins").click();
      const plugins = page.getByRole("region", {
        name: "Plugins",
        exact: true,
      });
      await expect(button(page, "Load from folder")).toBeVisible();
      await expect(button(page, "Load from Git")).toBeVisible();
      await checkButtons(plugins, scale);
      if (scale === 200 && width === 320) {
        // Prove this exercises wrapped text, not just a one-line button.
        const lines = await button(page, "Load from folder").evaluate(
          (button) => {
            const walker = document.createTreeWalker(
              button,
              NodeFilter.SHOW_TEXT,
            );
            const tops = new Set();
            while (walker.nextNode()) {
              const range = document.createRange();
              range.selectNodeContents(walker.currentNode);
              for (const line of range.getClientRects()) tops.add(line.top);
            }
            return tops.size;
          },
        );
        expect(lines).toBeGreaterThan(1);
      }
      await page.screenshot({
        path: info.outputPath(`settings-buttons-${scale}-${width}.png`),
      });
    }
  }
});

test("folder/Git preview selects the exact subfolder, installs disabled and warns on enabled updates", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  await button(page, "Load from folder").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(button(page, "Install plugin")).toHaveCount(0);
  await page.getByRole("radio", { name: /Example two/ }).check();
  await button(page, "Profile").click();
  await button(page, "Plugins").click();
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeChecked();
  await expect(
    page.getByText(
      "This plugin will be installed disabled. Enable it in the list when you’re ready.",
    ),
  ).toBeVisible();
  await button(page, "Install plugin").click();
  const enabled = page.getByRole("switch", { name: "Enable Example two" });
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_install")
          .args,
    ),
  ).toEqual({ token: "preview-one", path: "plugins/two/dist" });
  await enabled.click();
  await expect(
    page.getByText(/It stays enabled and may run immediately/),
  ).toBeVisible();
  await expect(button(page, "Update plugin")).toBeVisible();
  await button(page, "Close preview").click();
  await button(page, "Load from Git").click();
  await page.getByLabel("Git or GitHub repository").fill("example/plugins");
  await page.getByLabel("Branch or tag (optional)").fill("feature/plugins");
  await button(page, "Find plugins").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_git").args,
    ),
  ).toEqual({ repository: "example/plugins", reference: "feature/plugins" });
  await button(page, "Close preview").click();
  await page.getByLabel("Git or GitHub repository").fill("bad");
  await button(page, "Find plugins").click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Repository unavailable" }),
  ).toBeVisible();
  await expect(button(page, "Find plugins")).toBeEnabled();
});

test("leaving Settings discards a late preview without installing", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  await page.evaluate(() => {
    window.importDelay = true;
  });
  await button(page, "Load from folder").click();
  await expect(page.getByText(/Reading plugin folders/)).toBeVisible();
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await page.evaluate(() => window.resolveImport());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.importCalls.filter(
            (c) => c.command === "plugin_import_discard",
          ).length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.importCalls.filter((c) => c.command === "plugin_import_install"),
    ),
  ).toEqual([]);
});

test("checked-in local examples activate and work independently", async ({
  page,
  app,
}) => {
  const samples = await Promise.all(
    ["counter", "notes"].map(async (name) => {
      const folder = new URL(
        `../../examples/plugins/${name}/`,
        import.meta.url,
      );
      return {
        path: name,
        manifest: JSON.parse(
          await readFile(new URL("manifest.json", folder), "utf8"),
        ),
        code: await readFile(new URL("plugin.js", folder), "utf8"),
        revision: name,
      };
    }),
  );
  await nativeImports(page, samples);
  await openPlugins(page, app.origin);
  await button(page, "Load from folder").click();
  for (const sample of samples) {
    await page
      .getByRole("radio", { name: new RegExp(sample.manifest.name) })
      .check();
    await button(page, "Install plugin").click();
    const toggle = page.getByRole("switch", {
      name: `Enable ${sample.manifest.name}`,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
  }
  const navigation = page.getByRole("navigation", {
    name: "Pages",
    exact: true,
  });
  await navigation
    .getByRole("button", { name: "Counter playground", exact: true })
    .click();
  await button(page, "Clicked 0 times").click();
  await expect(button(page, "Clicked 1 times")).toBeVisible();
  await navigation
    .getByRole("button", { name: "Notes playground", exact: true })
    .click();
  await page.getByLabel("Scratch note").fill("Hello plugin");
  await expect(page.getByRole("status")).toHaveText("12 characters");
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  await page.getByRole("switch", { name: "Enable Counter playground" }).click();
  await expect(
    navigation.getByRole("button", { name: "Counter playground", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("button", { name: "Notes playground", exact: true }),
  ).toBeVisible();
});
