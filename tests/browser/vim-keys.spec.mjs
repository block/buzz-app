import {
  closeSettings,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { animationsSettled } from "./animations.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import { test, expect } from "./fixture.mjs";
import { open, wheel } from "./timeline.mjs";

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

// Painted selection, the preview card's own Tab and Escape, and Base UI's
// return focus need a browser; the person menu is unit-tested.
test("a selection stays visible through its menus, and Tab and j reach people and rows", async ({
  page,
  app,
}) => {
  await open(page, app);
  await enableVimKeys(page);
  await nothingFocused(page);
  const painted = (locator) =>
    locator.evaluate(
      (element) => getComputedStyle(element, "::after").content !== "none",
    );
  await page.keyboard.press("j");
  await expect.poll(() => selectedId(page)).not.toBeNull();
  const newest = await selectedId(page);
  const message = page.locator(`[data-message-id="${newest}"] > [data-layout]`);
  await expect(message).toBeFocused();
  expect(await painted(message)).toBe(true);

  // Tab reaches the message's author; go opens the person's own menu, and
  // the message stays marked while it is open.
  await page.keyboard.press("Tab");
  const avatar = page.getByRole("button", {
    name: "View Fixture Reader profile",
  });
  await expect(avatar).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("o");
  const actions = page.getByRole("menu", { name: "Fixture Reader actions" });
  await expect(
    actions.getByRole("menuitem", { name: "View profile", exact: true }),
  ).toHaveAttribute("aria-keyshortcuts", "v");
  expect(await painted(message)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(avatar).toBeFocused();
  // The menu's return focus does not reopen the person's card, so one Escape
  // goes back to the message.
  await page.keyboard.press("Escape");
  await expect.poll(() => selectedId(page)).toBe(newest);
  await expect(avatar).not.toBeFocused();

  // The message's own menu returns focus to the message, not its author.
  await page.keyboard.press("g");
  await page.keyboard.press("o");
  await expect(page.getByRole("menu")).toBeVisible();
  expect(await painted(message)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(message).toBeFocused();
  // Focus can reach a just-opened menu late; until then the menu still owns
  // Escape, and the conversation does not take it as a move to the composer.
  await page.keyboard.press("g");
  await page.keyboard.press("o");
  await expect(page.getByRole("menu")).toBeVisible();
  await message.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(message).toBeFocused();

  // j and k step between sidebar rows, which have no arrow keys of their own.
  await page.keyboard.press("\\");
  const nav = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect(nav.getByRole("button", { name: "Alpha" })).toBeFocused();
  await page.keyboard.press("j");
  await expect(nav.getByRole("button", { name: "Beta" })).toBeFocused();
  await page.keyboard.press("k");
  await expect(nav.getByRole("button", { name: "Alpha" })).toBeFocused();
});

// Painting without keyboard navigation, real focus moves, a real click and
// wheel scrolling need a browser; cursor bookkeeping is unit-tested.
test.describe("with history to scroll", () => {
  test.use({ historyCounts: { alpha: 40, beta: 1 } });
  test("the cursor stays marked through focus elsewhere, clicks and scrolling", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await enableVimKeys(page);
    const cursor = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-message-cursor]")].map(
          (box) => box.closest("[data-message-id]")?.dataset.messageId,
        ),
      );
    const box = (id) =>
      page.locator(`[data-message-id="${id}"] > [data-layout]`);
    const painted = (id) =>
      box(id).evaluate(
        (element) => getComputedStyle(element, "::after").content !== "none",
      );
    await nothingFocused(page);
    await page.keyboard.press("j");
    await expect.poll(() => selectedId(page)).not.toBeNull();
    const newest = await selectedId(page);
    await page.keyboard.press("k");
    await expect.poll(() => selectedId(page)).not.toBe(newest);
    const older = await selectedId(page);
    await expect.poll(cursor).toEqual([older]);

    // Focus in the sidebar, the which-key menu or the composer leaves it marked.
    await page.keyboard.press("\\");
    await expect(
      page.locator('button[data-channel-id][aria-current="page"]'),
    ).toBeFocused();
    expect(await painted(older)).toBe(true);
    await page.keyboard.press(" ");
    await expect(page.locator("[data-vim-which-key]")).toBeVisible();
    expect(await painted(older)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-vim-which-key]")).toHaveCount(0);
    await nothingFocused(page);
    await page.keyboard.press("i");
    await expect(composer(page, "Alpha")).toBeFocused();
    expect(await painted(older)).toBe(true);

    // A click moves it, marked without keyboard navigation; k resumes from it.
    await box(newest).click({ position: { x: 4, y: 4 } });
    await expect.poll(cursor).toEqual([newest]);
    expect(await painted(newest)).toBe(true);
    expect(await painted(older)).toBe(false);
    await nothingFocused(page);
    await page.keyboard.press("k");
    await expect.poll(() => selectedId(page)).toBe(older);

    // Scrolling it away moves it, with its focus, to a message in view.
    await wheel(page, -4000);
    await expect.poll(cursor).not.toEqual([older]);
    const [moved] = await cursor();
    await expect(box(moved)).toBeInViewport();
    await expect(box(moved)).toBeFocused();
  });
});
