import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";
let fixtures;
test.beforeAll(async () => {
  fixtures = await previewFixtures([
    "tests/fixtures/github-comment-affordance.html",
  ]);
});
test.afterAll(() => fixtures?.close());
// Native gutter placement and inertness on expanded rows require Pierre's shadow DOM.
test("gutter and keyboard share verified patch coordinates across layouts", async ({
  page,
}) => {
  await page.goto(
    `${fixtures.origin}/tests/fixtures/github-comment-affordance.html`,
  );
  const file = page.getByRole("region", {
    name: "src/example.ts",
    exact: true,
  });
  for (const layout of ["single", "split"]) {
    if (layout === "split")
      await page.getByRole("button", { name: "Toggle layout" }).click();
    await expect(file.locator("pre")).toHaveAttribute("data-diff-type", layout);
    const outside = file
      .locator('[data-column-number="4999"][data-line-type="context"]')
      .last();
    await outside.hover();
    await expect(
      page.getByRole("button", { name: "Comment on hovered line" }),
    ).toHaveCount(0);
    await file
      .locator('[data-column-number="5001"][data-line-type="change-addition"]')
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await expect(page.getByLabel("Selected coordinates")).toHaveText(
      '[{"side":"additions","lineNumber":5001}]',
    );
    await outside.hover();
    await expect(
      page.getByRole("button", { name: "Comment on hovered line" }),
    ).toHaveCount(0);
    await file
      .locator('[data-column-number="5002"][data-line-type="context"]')
      .last()
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await expect(page.getByLabel("Selected coordinates")).toHaveText(
      '[{"side":"additions","lineNumber":5002}]',
    );
    await file.focus();
    await file.press("ArrowDown");
    await expect(file.getByRole("status")).toHaveText("Old line 5000");
    await file.press("Escape");
  }
});

test("keyboard line selection stays visible without moving file focus", async ({
  page,
}) => {
  await page.goto(
    `${fixtures.origin}/tests/fixtures/github-comment-affordance.html?long`,
  );
  const file = page.getByRole("region", {
    name: "src/example.ts",
    exact: true,
  });
  await expect(file.locator("[data-line]")).toHaveCount(120);
  await file.focus();
  for (let index = 0; index < 60; index++) await file.press("ArrowDown");
  await expect(file.getByRole("status")).toHaveText("New line 60");
  await expect(file.locator("[data-line][data-selected-line]")).toBeInViewport({
    ratio: 1,
  });
  await expect(file).toBeFocused();
  for (let index = 0; index < 59; index++) await file.press("ArrowUp");
  await expect(file.getByRole("status")).toHaveText("New line 1");
  await expect(file.locator("[data-line][data-selected-line]")).toBeInViewport({
    ratio: 1,
  });
  await expect(file).toBeFocused();
});
