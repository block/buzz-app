import { test, expect } from "./fixture.mjs";
import { open, end } from "./timeline.mjs";
import { selectSettingsSection, openPage } from "./navigation.mjs";
import { buildBundledDev } from "../../scripts/plugin-dev.mjs";
import { nativeFixtureSession } from "./native-fixture.mjs";
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
// with the production host through attach, reload and revert. Native filesystem
// operations use one real Rust manager session; the OS picker/IPC and native
// activation tokens are fixtures, not native WebView/process acceptance.
test("same-ID Inbox and Links development share host state across revisions and reject mismatched hosts", async ({
  page,
  app,
}) => {
  const temp = await mkdtemp(join(tmpdir(), "inbox-dev-browser-"));
  let native;
  try {
    const out = join(temp, "plugin");
    const linksOut = join(temp, "links");
    const built = await buildBundledDev({ plugin: "inbox", out });
    native = nativeFixtureSession(join(temp, "home"));
    let activation = 0;
    const active = new Map();
    await page.exposeFunction(
      "inboxPluginNative",
      async (command, args = {}) => {
        if (command === "plugin_activation_begin") {
          const token = ++activation;
          active.set(token, args.id);
          return token;
        }
        if (command === "plugin_activation_retire") {
          expect(active.get(args.activation)).toBe(args.id);
          active.delete(args.activation);
          return;
        }
        if (command === "deep_link_take") return [];
        if (command === "deep_link_watch") return;
        return native.request(command, {
          ...args,
          ...(command === "plugin_development_folder"
            ? { directory: args.id === "buzz.links" ? linksOut : out }
            : {}),
        });
      },
    );
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
    const row = page.locator("article").filter({ has: toggle("Inbox") });
    await expect(toggle("Inbox")).toBeChecked();
    await row
      .getByRole("button", { name: "Use local dev build", exact: true })
      .click();
    await expect(
      row.getByRole("region", { name: "Local build preview for Inbox" }),
    ).toContainText("buzz.inbox");
    await row
      .getByRole("button", { name: "Attach local build", exact: true })
      .click();
    await expect(row.getByRole("status")).toHaveText(
      "Local dev build · this launch only",
    );
    await expect(toggle("Inbox")).toBeChecked();
    await expect(toggle("Inbox")).toHaveCount(1);
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(
      page.locator('head style[data-buzz-plugin="buzz.inbox"]'),
    ).toHaveCount(1);
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(
      inbox.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Inbox", exact: true }),
    ).toHaveCount(1);
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
    await editor.fill("Edited in local Inbox");
    await button(inbox, "Open in origin").click();
    await expect(hostEditor).toContainText("Edited in local Inbox");
    await openPage(page, "Inbox");
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    await expect(editor).toContainText("Edited in local Inbox");
    await inbox.getByLabel("Choose attachments").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Keep my attachment"),
    });
    await expect(inbox.getByText("notes.txt", { exact: true })).toBeVisible();
    // The lifecycle-owned stylesheet must be removed before the next revision.
    const styleCount = () =>
      page.locator('head style[data-buzz-plugin="buzz.inbox"]').count();
    const beforeReload = await styleCount();
    expect(beforeReload).toBe(1);
    // Rebuild an actual source edit without changing the running host checkout.
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const checkout = join(temp, "checkout");
    const files = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    for (const path of files) {
      if (
        !/^(src\/|scripts\/|crates\/|src-tauri\/|vite.config.ts$|package.json$|pnpm-lock.yaml$|postcss.config.js$|.gitignore$)/.test(
          path,
        )
      )
        continue;
      await cp(join(root, path), join(checkout, path), { recursive: true });
    }
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
    const second = await buildBundledDev({
      plugin: "inbox",
      directory: checkout,
      out,
    });
    expect(second.buildId).toBe(built.buildId);
    await settings();
    // Disable/re-enable proves CSS is activation-owned, not just overwritten.
    await toggle("Inbox").click();
    await expect(
      page.locator('head style[data-buzz-plugin="buzz.inbox"]'),
    ).toHaveCount(0);
    await toggle("Inbox").click();
    await expect(
      page.locator('head style[data-buzz-plugin="buzz.inbox"]'),
    ).toHaveCount(1);
    const firstStyle = await page
      .locator('head style[data-buzz-plugin="buzz.inbox"]')
      .elementHandle();
    // Reload an enabled same-ID selection, with no separate Inbox Dev toggle.
    await row.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(toggle("Inbox")).toBeChecked();
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await openPage(page, "Inbox Dev B");
    await expect(inbox.locator(`[class~="${utility}"]`)).toHaveCSS(
      "word-spacing",
      "3.7px",
    );
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    await expect(editor).toContainText("Edited in local Inbox");
    await expect(inbox.getByText("notes.txt", { exact: true })).toBeVisible();
    expect(await styleCount()).toBe(1);
    expect(await firstStyle.evaluate((style) => style.isConnected)).toBe(false);
    await settings();
    const healthy = (
      await native.request("plugin_catalog")
    ).catalog.plugins.find((plugin) => plugin.manifest.id === built.id);
    const compatibilityPath = join(out, "plugin.dev.json");
    const compatibility = JSON.parse(await readFile(compatibilityPath, "utf8"));
    await writeFile(
      compatibilityPath,
      JSON.stringify({ ...compatibility, hostBuildId: "0".repeat(64) }),
    );
    await row.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(
      page.getByText(/Local build is incompatible with this host/),
    ).toBeVisible();
    const retained = (
      await native.request("plugin_catalog")
    ).catalog.plugins.find((plugin) => plugin.manifest.id === built.id);
    expect(retained.revision).toBe(healthy.revision);
    expect(retained.source).toBe("development");
    await expect(toggle("Inbox")).toBeChecked();
    expect(await styleCount()).toBe(1);
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await openPage(page, "Inbox Dev B");
    await expect(inbox.locator(`[class~="${utility}"]`)).toHaveCSS(
      "word-spacing",
      "3.7px",
    );
    await settings();
    await row
      .getByRole("button", { name: "Use compiled", exact: true })
      .click();
    await expect(row.getByRole("status")).toHaveText("Compiled build");
    await expect(toggle("Inbox")).toBeChecked();
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await openPage(page, "Inbox");
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    await expect(editor).toContainText("Edited in local Inbox");
    await expect(inbox.getByText("notes.txt", { exact: true })).toBeVisible();
    expect(await styleCount()).toBe(0);
    expect(await probeUtility()).not.toBe("3.7px");
    await button(inbox, "Open in origin").click();
    await expect(hostEditor).toContainText("Edited in local Inbox");
    await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();

    // A link contribution replaces inside the host-owned message tree rather
    // than mounting a page. Reuse this startup/manager for that distinct boundary.
    const destination = "https://example.test/local-links";
    app.append("primary", "beta", destination);
    const link = page.locator(`a[href=${JSON.stringify(destination)}]`);
    await expect(link).toBeAttached();
    await end(page);
    await expect(link).toBeVisible();
    const compiledLabel = await link.innerText();
    // Other plugins are part of Links' host fingerprint; undo the Inbox-only
    // probe in the build checkout before building a matching Links revision.
    for (const path of [
      "src/bundled/inbox/index.tsx",
      "src/bundled/inbox/InboxPage.tsx",
    ])
      await cp(join(root, path), join(checkout, path));
    const linksView = join(checkout, "src/bundled/links/InlineLink.tsx");
    const linksSource = await readFile(linksView, "utf8");
    await writeFile(
      linksView,
      linksSource.replaceAll(
        "<span data-link-kind={kind}>",
        "<span data-link-kind={kind}><span>Local Links A</span>",
      ),
    );
    const linksFirst = await buildBundledDev({
      plugin: "links",
      directory: checkout,
      out: linksOut,
    });
    await settings();
    const linksRow = page.locator("article").filter({ has: toggle("Links") });
    await linksRow
      .getByRole("button", { name: "Use local dev build", exact: true })
      .click();
    await expect(
      linksRow.getByRole("region", { name: "Local build preview for Links" }),
    ).toContainText("buzz.links");
    await linksRow
      .getByRole("button", { name: "Attach local build", exact: true })
      .click();
    await expect(linksRow.getByRole("status")).toHaveText(
      "Local dev build · this launch only",
    );
    await expect(toggle("Links")).toBeChecked();
    await expect(toggle("Links")).toHaveCount(1);
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(link).toContainText("Local Links A");
    await expect(link.locator('[data-link-kind="web"]')).toHaveCount(1);
    await writeFile(
      linksView,
      (await readFile(linksView, "utf8")).replaceAll(
        "Local Links A",
        "Local Links B",
      ),
    );
    const linksSecond = await buildBundledDev({
      plugin: "links",
      directory: checkout,
      out: linksOut,
    });
    expect(linksSecond.buildId).toBe(linksFirst.buildId);
    await settings();
    await linksRow.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(toggle("Links")).toBeChecked();
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(link).toContainText("Local Links B");
    await expect(link).not.toContainText("Local Links A");
    await expect(link.locator('[data-link-kind="web"]')).toHaveCount(1);
    await expect(hostEditor).toContainText("Edited in local Inbox");
    await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
    await settings();
    await linksRow
      .getByRole("button", { name: "Use compiled", exact: true })
      .click();
    await expect(linksRow.getByRole("status")).toHaveText("Compiled build");
    await expect(toggle("Links")).toBeChecked();
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(link).toHaveText(compiledLabel);
    await expect(link.locator('[data-link-kind="web"]')).toHaveCount(1);
    await expect(
      page.locator('head style[data-buzz-plugin="buzz.links"]'),
    ).toHaveCount(0);
  } finally {
    // Catalog polling invokes the native bridge and can recreate its profile.
    // The IPC producer must be closed before removing its filesystem state.
    try {
      await page.close();
      expect(page.isClosed()).toBe(true);
    } finally {
      try {
        await native?.close();
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  }
});
