import {
  closeSettings,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { animationsSettled } from "./animations.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Real focus, key dispatch through the app's own handlers, Base UI menus and
// focus return need a browser; key tables and letters are unit-tested.
test.use({ historyCounts: { alpha: 4, beta: 1 } });

const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

const selectedId = (page) =>
  page.evaluate(
    () =>
      document.activeElement?.closest("[data-message-id]")?.dataset.messageId ??
      null,
  );
const nothingFocused = (page) =>
  page.evaluate(() => document.activeElement?.blur());

async function enableVimKeys(page) {
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await setPluginEnabled(page, "Vim keys", true);
  await closeSettings(page);
}

test("Vim keys select messages, act on them with go, and leave the composer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = composer(page, "Alpha");
  // Off by default: j types nowhere and selects nothing.
  await nothingFocused(page);
  await page.keyboard.press("j");
  expect(await selectedId(page)).toBeNull();

  await enableVimKeys(page);
  await nothingFocused(page);
  await page.keyboard.press("j");
  await expect.poll(() => selectedId(page)).not.toBeNull();
  const newest = await selectedId(page);
  await page.keyboard.press("k");
  await expect.poll(() => selectedId(page)).not.toBe(newest);
  await page.keyboard.press("j");
  await expect.poll(() => selectedId(page)).toBe(newest);
  // Down past the newest message stays on it instead of typing.
  await page.keyboard.press("j");
  await expect.poll(() => selectedId(page)).toBe(newest);
  await expect(alpha).not.toBeFocused();

  // go opens the message's own menu, each item with its key.
  await page.keyboard.press("g");
  await page.keyboard.press("o");
  const menu = page.getByRole("menu");
  const reply = menu.getByRole("menuitem", { name: "Reply", exact: true });
  await expect(reply).toHaveAttribute("aria-keyshortcuts", "r");
  await expect(
    menu.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toHaveAttribute("aria-keyshortcuts", /^[a-z0-9]$/);
  // go moves focus into the menu, so its keys reach it.
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('[role="menu"]')),
    )
    .toBe(true);
  // An open menu keeps its keys: Space starts no leader sequence, so the
  // next key still reaches the menu.
  await page.keyboard.press(" ");
  await expect(page.locator("[data-vim-which-key]")).toHaveCount(0);
  await page.keyboard.press("r");
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Thread messages", exact: true }),
  ).toBeVisible();
  // Reply hands focus to the thread's composer; let that and the panel's
  // entrance finish first, since i skips a composer the panel still covers.
  await expect(
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeFocused();
  await animationsSettled(page.locator("[data-panel-dock]"));

  // i types; Escape stops typing so j moves again.
  await nothingFocused(page);
  await page.keyboard.press("i");
  await expect(alpha).toBeFocused();
  await page.keyboard.press("j");
  await expect(alpha).toHaveText("j");
  await page.keyboard.press("Escape");
  await expect(alpha).not.toBeFocused();
});

test("the leader shows what can follow and runs Buzz's own actions by id", async ({
  page,
  app,
}) => {
  await open(page, app);
  await enableVimKeys(page);
  await nothingFocused(page);

  await page.keyboard.press(" ");
  const whichKey = page.locator("[data-vim-which-key]");
  await expect(whichKey).toBeVisible();
  await expect(
    whichKey.getByRole("menuitem", { name: "Search…", exact: true }),
  ).toHaveAttribute("aria-keyshortcuts", "s");
  await page.keyboard.press("s");
  await expect(
    whichKey.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("k");
  await expect(whichKey).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Shortcuts", exact: true }),
  ).toBeVisible();
  await closeSettings(page);

  // Escape cancels a sequence without acting.
  await nothingFocused(page);
  await page.keyboard.press(" ");
  await expect(whichKey).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(whichKey).toHaveCount(0);

  await nothingFocused(page);
  await page.keyboard.press(" ");
  await page.keyboard.press(" ");
  await expect(page.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);

  // ]b opens the next conversation in the sidebar.
  await nothingFocused(page);
  await page.keyboard.press("]");
  await page.keyboard.press("b");
  await expect(composer(page, "Beta")).toBeVisible();

  // \ focuses its sidebar row; go opens that conversation's own menu.
  await nothingFocused(page);
  await page.keyboard.press("\\");
  const row = page.locator('button[data-channel-id][aria-current="page"]');
  await expect(row).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("o");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").first()).toHaveAttribute(
    "aria-keyshortcuts",
    /^[a-z0-9]$/,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(composer(page, "Beta")).toBeVisible();
});

test("leader keys follow Buzz's shortcut when it is rebound", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzz-shortcut-bindings.v1",
      JSON.stringify({ "global-search": { key: "F9" } }),
    );
  });
  await open(page, app);
  await enableVimKeys(page);
  const search = page.getByRole("dialog", { name: "Search Buzz" });
  // The rebind is in effect: its new key opens Search.
  await page.keyboard.press("F9");
  await expect(search).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await nothingFocused(page);
  await page.keyboard.press(" ");
  await page.keyboard.press(" ");
  await expect(search).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);

  // Turning the plugin off takes the keys out of every menu.
  const profile = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  await profile.click();
  await expect(
    page.getByRole("menuitem", { name: "Settings", exact: true }),
  ).toHaveAttribute("aria-keyshortcuts", /./);
  await page.keyboard.press("Escape");
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await setPluginEnabled(page, "Vim keys", false);
  await closeSettings(page);
  await profile.click();
  await expect(
    page.getByRole("menuitem", { name: "Settings", exact: true }),
  ).not.toHaveAttribute("aria-keyshortcuts");
});
