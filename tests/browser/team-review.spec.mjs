import { test, expect } from "./source-fixture.mjs";

const ada = "1".repeat(64);
const bo = "2".repeat(64);

test("team changes wait for owner review under the team's current name", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/team-review.html");
  const dialog = page.getByRole("dialog", { name: "Edit Reviewers" });
  await expect(dialog).toContainText(
    "Parent proposed these changes. Nothing is saved until you save.",
  );
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toHaveValue("QA reviewers");
  await expect(name).toBeFocused();
  await expect(
    dialog.getByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("Review every pull request.");
  const box = (label) => dialog.getByRole("checkbox", { name: label });
  await expect(box("Ada")).toBeChecked();
  await expect(box("Bo")).not.toBeChecked();
  await expect(box("Cy")).toBeChecked();
  const save = dialog.getByRole("button", { name: "Save team" });
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(name).toBeInViewport();
      await expect(save).toBeInViewport();
    }
  }
  await box("Bo").focus();
  await page.keyboard.press("Space");
  await expect(box("Bo")).toBeChecked();
  await box("Cy").click();
  await expect(box("Cy")).not.toBeChecked();
  // Editing the proposed name keeps naming the team being changed.
  await name.fill("  Code reviewers  ");
  await expect(dialog).toBeVisible();
  expect(
    (await page.evaluate(() => window.teamReviewResult())).approved,
  ).toEqual([]);
  await save.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.teamReviewResult())).toEqual({
    approved: [
      {
        id: "req",
        input: {
          name: "Code reviewers",
          instructions: "Review every pull request.",
          members: [ada, bo],
        },
      },
    ],
    dismissed: [],
  });
});

test("a new team request can be discarded without saving", async ({ page }) => {
  await page.goto("/tests/fixtures/team-review.html?new");
  const dialog = page.getByRole("dialog", { name: "New team" });
  await expect(dialog).toContainText(
    "Parent requested this team. Nothing is saved until you save.",
  );
  const create = dialog.getByRole("button", { name: "Create team" });
  await expect(create).toBeEnabled();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(" ");
  await expect(create).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.teamReviewResult())).toEqual({
    approved: [],
    dismissed: ["req"],
  });
});

test("a failed save keeps the review open to retry", async ({ page }) => {
  await page.goto("/tests/fixtures/team-review.html?fail");
  const dialog = page.getByRole("dialog", { name: "Edit Reviewers" });
  const save = dialog.getByRole("button", { name: "Save team" });
  await save.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "A member is not an agent on this device",
  );
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.teamReviewResult())).approved,
  ).toHaveLength(1);
});
