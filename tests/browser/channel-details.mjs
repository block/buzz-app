/** Open/focus the existing pane through the production header menu. */
export async function openChannelDetails(page, { programmatic = false } = {}) {
  const trigger = page.getByRole("button", {
    name: "Channel actions",
    exact: true,
  });
  if (programmatic) await trigger.evaluate((element) => element.click());
  else await trigger.click();
  await page
    .getByRole("menuitem", { name: "View channel details", exact: true })
    .click();
}
