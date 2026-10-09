import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { selectSettingsSection } from "./navigation.mjs";
import { buildInboxDev } from "../../scripts/plugin-dev.mjs";
import { nativeFixture } from "./native-fixture.mjs";
import { run } from "./run-command.mjs";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});
const button = (page, name) => page.getByRole("button", { name, exact: true });

// Browser-only: a real built blob module shares React, drafts/attachments and CSS
// with the production host through import, reload and revert. Native filesystem
// operations use the real Rust manager; the OS picker/IPC wire is a fixture.
test("Inbox Dev shares host state across two revisions and rejects mismatched hosts", async ({
  page,
  app,
}) => {
  const temp = await mkdtemp(join(tmpdir(), "inbox-dev-browser-"));
  try {
    const out = join(temp, "plugin");
    const built = await buildInboxDev({ out });
    const original = await readFile(join(out, "plugin.js"), "utf8");
    const binary = nativeFixture();
    const native = (op, ...args) =>
      JSON.parse(run(binary, [join(temp, "home"), op, ...args]));
    await page.exposeFunction("inboxPluginNative", (command, args = {}) => {
      if (command === "plugin_catalog") return native("catalog");
      if (command === "plugin_change")
        return native("change", args.action, args.id);
      if (command === "plugin_module")
        return native("module", args.id, args.revision).code;
      if (command === "plugin_reload") return native("reload", args.id);
      if (command === "plugin_import_folder")
        return {
          token: "fixture-folder",
          source: out,
          commit: null,
          warnings: [],
          candidates: [
            {
              path: ".",
              manifest: {
                id: "local.inbox-dev",
                name: "Inbox Dev",
                apiVersion: 1,
              },
              revision: "preview",
            },
          ],
        };
      if (command === "plugin_import_install") return native("install", out);
      if (command === "plugin_import_discard") return;
      if (command === "deep_link_take") return [];
      if (command === "deep_link_watch") return;
      throw new Error(`Unexpected fixture IPC: ${command}`);
    });
    await page.addInitScript(() => {
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        invoke: (command, args) => window.inboxPluginNative(command, args),
        transformCallback: () => 1,
        unregisterCallback() {},
      };
    });
    const settings = async () => {
      await button(page, "Your profile").click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      await selectSettingsSection(page, "Plugins");
    };
    const toggle = (name) =>
      page.getByRole("switch", { name: `Enable ${name}`, exact: true });
    await open(page, app);
    await button(page, "Search Buzz").click();
    const search = page.getByRole("dialog", {
      name: "Search Buzz",
      exact: true,
    });
    await search.getByRole("combobox", { name: "Search Buzz" }).fill("Beta");
    await search
      .getByRole("option", { name: "Beta Conversation", exact: true })
      .click();
    const hostEditor = page.getByRole("textbox", {
      name: "Message #Beta",
      exact: true,
    });
    await hostEditor.fill("Host draft");
    await settings();
    await toggle("Inbox").click();
    await button(page, "Load from folder").click();
    await button(page, "Install plugin").click();
    await expect(toggle("Inbox Dev")).not.toBeChecked();
    await button(page, "Close preview").click();
    await toggle("Inbox Dev").click();
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await button(page, "Inbox").click();
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(
      inbox.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    await expect(button(page, "Inbox")).toHaveCount(1);
    // The draft created by the host composer must be usable in the plugin.
    // Use the actual host composer to prove same-window draft notifications;
    // do not expose additional host exports just for the test.
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    const editor = inbox.getByRole("textbox", {
      name: "Message #Beta",
      exact: true,
    });
    await expect(editor).toContainText("Host draft");
    await editor.fill("Edited in Inbox Dev");
    await button(inbox, "Open in origin").click();
    await expect(hostEditor).toContainText("Edited in Inbox Dev");
    await button(page, "Inbox").click();
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    await expect(editor).toContainText("Edited in Inbox Dev");
    await inbox.getByLabel("Choose attachments").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Keep my attachment"),
    });
    await expect(inbox.getByText("notes.txt", { exact: true })).toBeVisible();
    // The lifecycle-owned stylesheet must be removed before the next revision.
    const styleCount = () =>
      page.locator('head style[data-buzz-plugin="local.inbox-dev"]').count();
    const beforeReload = await styleCount();
    expect(beforeReload).toBe(1);
    // Rebuild an actual source edit without changing the running host checkout.
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const checkout = join(temp, "checkout");
    for (const path of [
      "src",
      "scripts",
      "vite.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "postcss.config.js",
      ".gitignore",
    ])
      await cp(join(root, path), join(checkout, path), { recursive: true });
    await symlink(
      join(root, "node_modules"),
      join(checkout, "node_modules"),
      "dir",
    );
    execFileSync("git", ["init", "--quiet", checkout]);
    const entry = join(checkout, "src/bundled/inbox/index.tsx");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")).replace(
        'title: "Inbox"',
        'title: "Inbox Dev B"',
      ),
    );
    // Neither the host nor revision A has this utility. Verify real CSS resolution,
    // not merely a class name or a changed title after Reload.
    // Assemble it so Tailwind's host scan cannot discover it in this test source.
    const utility = ["[word-spacing:", "3.7px]"].join("");
    const probeUtility = () =>
      inbox.evaluate((element, className) => {
        element.classList.add(className);
        const spacing = getComputedStyle(element).wordSpacing;
        element.classList.remove(className);
        return spacing;
      }, utility);
    expect(await probeUtility()).not.toBe("3.7px");
    const view = join(checkout, "src/bundled/inbox/InboxPage.tsx");
    await writeFile(
      view,
      (await readFile(view, "utf8")).replaceAll(
        "className={styles.page}",
        `className={\`\${styles.page} ${utility}\`}`,
      ),
    );
    const second = await buildInboxDev({ directory: checkout, out });
    expect(second.buildId).toBe(built.buildId);
    await settings();
    await toggle("Inbox Dev").click();
    expect(await styleCount()).toBe(0);
    await page
      .locator("article")
      .filter({ has: toggle("Inbox Dev") })
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await toggle("Inbox Dev").click();
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await button(page, "Inbox Dev B").click();
    await expect(inbox.locator(`[class~="${utility}"]`)).toHaveCSS(
      "word-spacing",
      "3.7px",
    );
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    await expect(editor).toContainText("Edited in Inbox Dev");
    await expect(inbox.getByText("notes.txt", { exact: true })).toBeVisible();
    expect(await styleCount()).toBe(1);
    await settings();
    await toggle("Inbox Dev").click();
    await writeFile(
      join(out, "plugin.js"),
      original.replaceAll(built.buildId, "0".repeat(64)),
    );
    await page
      .locator("article")
      .filter({ has: toggle("Inbox Dev") })
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await toggle("Inbox Dev").click();
    await expect(
      page.getByText(/Inbox Dev targets a different Buzz host/),
    ).toBeVisible();
    expect(await styleCount()).toBe(0);
    await toggle("Inbox Dev").click();
    await toggle("Inbox").click();
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await button(page, "Inbox").click();
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    await expect(editor).toContainText("Edited in Inbox Dev");
    await expect(inbox.getByText("notes.txt", { exact: true })).toBeVisible();
    expect(await styleCount()).toBe(0);
    expect(await probeUtility()).not.toBe("3.7px");
    await button(inbox, "Open in origin").click();
    await expect(hostEditor).toContainText("Edited in Inbox Dev");
    await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  } finally {
    // Catalog polling invokes the native bridge and can recreate its profile.
    // The IPC producer must be closed before removing its filesystem state.
    try {
      await page.close();
      expect(page.isClosed()).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});
