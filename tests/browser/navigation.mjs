import { expect } from "@playwright/test";

export async function pageChoices(page) {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Search Buzz", exact: true })
    .getByRole("group", { name: "Actions", exact: true });
}

export async function openPage(page, name) {
  // The community rail appears after local startup has replaced the launch view.
  await expect(
    page.getByRole("button", { name: "Switch to Primary", exact: true }),
  ).toBeVisible();
  const target = await page.evaluate(
    () => history.state?.buzzNavigationV1?.entry?.target,
  );
  if (
    target?.kind === "conversation" ||
    (target?.kind === "page" &&
      target.pluginId === "buzz.channels" &&
      target.pageId === "channels" &&
      target.scope !== null)
  ) {
    // The launch page resolves into the first conversation after the rail mounts.
    // Opening search before that route presents can replace its choices mid-click.
    const main = page.getByRole("main");
    const conversation = main.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    const failure = main
      .getByRole("alert")
      .filter({ hasText: "This destination couldn’t open" });
    await expect
      .poll(
        async () => {
          const kind = await page.evaluate(
            () => history.state?.buzzNavigationV1?.entry?.target?.kind,
          );
          return (
            (kind === "conversation" && (await conversation.isVisible())) ||
            (await failure.isVisible())
          );
        },
        { message: "initial Messages route presents" },
      )
      .toBe(true);
  }
  const choices = await pageChoices(page);
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const choice = choices.getByRole("option", { name, exact: true });
  // Registered page actions are visible only after the plugin catalog is ready.
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(dialog).not.toBeVisible();
}
