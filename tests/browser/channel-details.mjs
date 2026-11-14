import { expect } from "@playwright/test";

/** Open/focus the existing pane through the production header menu. A
 * channel's actions live in the conversation header's overflow popover, where
 * each menu item is a button. */
export async function openChannelDetails(
  page,
  { programmatic = false, clockPaused = false } = {},
) {
  // A programmatic open reaches the trigger under a covering narrow pane,
  // which removes it from the accessibility tree.
  const trigger = page.getByRole("button", {
    name: "Conversation actions",
    exact: true,
    includeHidden: programmatic,
  });
  if (programmatic) await trigger.evaluate((element) => element.click());
  else await trigger.click();
  const details = page.getByRole("button", {
    name: "View channel details",
    exact: true,
  });
  if (clockPaused) {
    // Drive the menu's deferred mount while keeping reading-policy time controlled.
    await expect
      .poll(async () => {
        await page.clock.runFor(16);
        return details.isVisible();
      })
      .toBe(true);
  }
  await details.click();
}

/** Choose an item from the conversation header's actions popover. */
export async function chooseChannelAction(page, name) {
  await page
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Conversation actions", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}
