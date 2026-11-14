import { expect } from "@playwright/test";
import { channelRow, rail, settleShellToggle } from "./navigation.mjs";
import { settle } from "./timeline.mjs";

// A narrow window keeps the rail in a drawer behind "Show navigation"; a wide
// one shows it beside the list. Either way, leave the rail visible.
export async function showRail(page) {
  if (page.viewportSize().width <= 650) {
    await settleShellToggle(page);
    const show = page.getByRole("button", {
      name: "Show navigation",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
  }
  await expect(rail(page)).toBeVisible();
}

// Team's Channels view from the rail at any width. A narrow drawer closes once
// the view opens, leaving the list in its place.
export async function showChannels(page) {
  await showRail(page);
  await rail(page).locator('[data-rail-team-view="channels"]').click();
  await expect(channelRow(page, "alpha")).toBeVisible();
}

// timeline.mjs `open` for any width: Alpha opened from Team's list, its
// history painted and at rest.
export async function openAlpha(page, app) {
  await page.goto(app.origin);
  await showChannels(page);
  await channelRow(page, "alpha").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  const history = page.getByRole("region", {
    name: "Channel message history",
  });
  await expect(history.locator("[data-message-id]").first()).toBeVisible();
  await settle(page);
}

// A section a person made, by its title: its card in the rail.
export function railSection(page, title) {
  return rail(page)
    .locator('[data-rail-section^="custom:"]')
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
}

// A row's section submenu, opened from the keyboard as a person would.
export async function openSectionMenu(page, row) {
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const trigger = page.getByRole("menuitem", {
    name: /^(Add|Move) to section$/,
  });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", { name: /^(Add|Move) to section: / });
  await expect(menu).toBeVisible();
  return menu;
}

// Put a row in a new section through its menu.
export async function addToNewSection(page, row, name) {
  const menu = await openSectionMenu(page, row);
  await menu
    .getByRole("menuitem", { name: "New section…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Move to new section" });
  await dialog.getByRole("textbox", { name: "Section name" }).fill(name);
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).toHaveCount(0);
}

// A Solo chat's row in the rail's Solo card, by channel id. The card previews
// the four most recent chats; Solo's own list (soloList) holds every one.
export function soloRow(page, channelId) {
  return rail(page).locator(
    `[data-rail-section="solo"] [data-rail-row="channel:${channelId}"] [data-conversation-row]`,
  );
}

// Solo's list, opened from the Solo card's heading: every chat, most recent
// first, beside the reader.
export async function openSoloList(page) {
  await showRail(page);
  await rail(page)
    .locator('[data-rail-section="solo"]')
    .getByRole("button", { name: "Solo", exact: true })
    .click();
}

// A conversation from one of Team's rail views ("channels", "dms", ...): the
// view lists it, and its row opens it beside the list.
export async function openInView(page, view, channelId) {
  await showRail(page);
  await rail(page).locator(`[data-rail-team-view="${view}"]`).click();
  await channelRow(page, channelId).click();
}

// A conversation header's overflow: its actions (Solo's former "Chat
// actions" menu) are buttons in a "Conversation actions" popover.
export function conversationActions(page) {
  return page.getByRole("button", {
    name: "Conversation actions",
    exact: true,
  });
}
export function conversationAction(page, name) {
  return page
    .getByRole("dialog", { name: "Conversation actions", exact: true })
    .getByRole("button", { name, exact: true });
}
