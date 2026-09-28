import { expect } from "@playwright/test";

export async function pageChoices(page) {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Search Buzz", exact: true })
    .getByRole("group", { name: "Actions", exact: true });
}

export async function openPage(page, name) {
  await pageChoices(page);
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  const choice = dialog
    .getByRole("group", { name: "Pages", exact: true })
    .getByRole("option", { name, exact: true });
  // Startup may replace the search state while the first community route settles.
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.fill(name);
    try {
      await choice.click({ timeout: 3000 });
      await expect(dialog).not.toBeVisible({ timeout: 1000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
