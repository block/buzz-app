import { expect } from "@playwright/test";

export async function pageChoices(page) {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Search Buzz", exact: true })
    .getByRole("group", { name: "Actions", exact: true });
}

export async function openPage(page, name) {
  const choices = await pageChoices(page);
  await choices.getByRole("option", { name, exact: true }).press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", exact: true }),
  ).not.toBeVisible();
}
