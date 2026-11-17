import { openCommunityPicker, rail } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

import { holdMenuExit, opened } from "./menu-motion.mjs";

test("closing a menu keeps focus where the user moved it", async ({
  page,
  app,
}) => {
  await open(page, app);
  const exit = await holdMenuExit(page);
  const trigger = rail(page).getByRole("button", {
    name: "Create",
    exact: true,
  });
  const menu = page.getByRole("menu", { name: "New", exact: true });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });

  try {
    await trigger.click();
    await opened(menu);
    await page.keyboard.press("Escape");
    await exit.held(menu);
    await composer.click();
    await expect(composer).toBeFocused();
    await expect(menu).toHaveCount(1);
    await exit.release();
    // The menu has finished closing. Its explicit final focus (its trigger)
    // must not pull focus back out of the composer.
    await expect(menu).toHaveCount(0);
    await expect(composer).toBeFocused();

    // A collapsed disclosure (Base UI marks it data-closed, like a closing
    // popup) is ordinary page content. Focus moved into it also stays.
    await page.evaluate(() => {
      const collapsed = document.createElement("div");
      collapsed.setAttribute("data-closed", "");
      collapsed.innerHTML = '<button type="button">Collapsed control</button>';
      document.getElementById("main-content").append(collapsed);
    });
    const collapsedControl = page.getByRole("button", {
      name: "Collapsed control",
    });
    await trigger.click();
    await opened(menu);
    await page.keyboard.press("Escape");
    await exit.held(menu);
    await collapsedControl.focus();
    await expect(menu).toHaveCount(1);
    await exit.release();
    await expect(menu).toHaveCount(0);
    await expect(collapsedControl).toBeFocused();

    // With nothing else focused, Escape still returns focus to the trigger.
    await trigger.click();
    await opened(menu);
    await page.keyboard.press("Escape");
    await exit.held(menu);
    await exit.release();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await exit.release();
  }
});

// Browser-only boundary: right-click moves focus before the contextmenu event.
// Dismissal must restore the interrupted picker row, while keyboard opening
// returns to the row that opened the menu.
test("dismissing a community menu restores pointer and keyboard focus within the picker", async ({
  page,
  app,
}) => {
  await open(page, app);
  const interrupted = page
    .getByRole("dialog", { name: "Switch community" })
    .getByRole("button", { name: "Personal space", exact: true });
  const secondary = page
    .getByRole("dialog", { name: "Switch community" })
    .getByRole("button", { name: "Switch to Secondary" });
  const menu = page.getByRole("menu", { name: "Actions for Secondary" });

  await openCommunityPicker(page);
  await interrupted.focus();
  await expect(interrupted).toBeFocused();
  await secondary.click({ button: "right" });
  await opened(menu);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(interrupted).toBeFocused();
  await expect(secondary).not.toBeFocused();

  // A keyboard open came from the rail, so dismissing it returns focus there.
  await secondary.focus();
  await page.keyboard.press("Shift+F10");
  await opened(menu);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(secondary).toBeFocused();
});
