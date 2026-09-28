import { expect } from "@playwright/test";

export async function pageChoices(page) {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Search Buzz", exact: true })
    .getByRole("group", { name: "Pages", exact: true });
}

export async function openPage(page, name) {
  const choices = await pageChoices(page);
  await choices.getByRole("option", { name, exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", exact: true }),
  ).not.toBeVisible();
}
