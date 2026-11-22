import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";
let fixtures;
test.beforeAll(async () => {
  fixtures = await previewFixtures([
    "tests/fixtures/github-inline-comments.html",
  ]);
});
test.afterAll(() => fixtures?.close());
test("preloads diff and threads from Summary without tab-triggered reads", async ({
  page,
}) => {
  await page.goto(
    `${fixtures.origin}/tests/fixtures/github-inline-comments.html?summary`,
  );
  await expect(
    page.getByRole("tab", { name: "Summary", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.inlineFixture.state.calls.some(
          (call) =>
            call.id === "graphql" &&
            String(call.input.query).includes("reviewThreads(first:100"),
        ),
      ),
    )
    .toBe(true);
  await expect(page.locator("diffs-container")).toHaveCount(1);
  await expect(page.locator("diffs-container")).toBeHidden();
  const reads = await page.evaluate(
    () => window.inlineFixture.state.calls.length,
  );
  await page.getByRole("tab", { name: /^Changes/ }).click();
  await expect(
    page.getByRole("region", { name: "src/example.ts", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.inlineFixture.state.calls.length),
  ).toBe(reads);
});

test("reads inline Markdown discussions without exposing comment writes", async ({
  page,
}) => {
  await page.goto(
    `${fixtures.origin}/tests/fixtures/github-inline-comments.html`,
  );
  const file = page.getByRole("region", {
    name: "src/example.ts",
    exact: true,
  });
  await expect(file.locator("strong", { hasText: "read-only" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reply", exact: true }),
  ).toHaveCount(0);
  await file
    .locator('[data-column-number="5001"][data-line-type="change-addition"]')
    .hover();
  await expect(
    page.getByRole("button", { name: "Comment on hovered line" }),
  ).toHaveCount(0);
  await file.focus();
  await file.press("ArrowDown");
  await file.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveCount(0);
  const writes = () =>
    page.evaluate(
      () =>
        window.inlineFixture.state.calls.filter(
          (call) =>
            call.args[0] === "POST" ||
            String(call.input.query).startsWith("mutation"),
        ).length,
    );
  expect(await writes()).toBe(0);
  await page.getByRole("tab", { name: "Summary", exact: true }).click();
  await page.getByRole("tab", { name: /^Changes/ }).click();
  await expect(file.locator("strong", { hasText: "read-only" })).toBeVisible();
  expect(await writes()).toBe(0);
});
