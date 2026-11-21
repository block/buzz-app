import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";
import { watchPageErrors } from "./page-errors.mjs";
let fixtures;
test.beforeAll(async () => {
  fixtures = await previewFixtures([
    "tests/fixtures/github-inline-comments.html",
    "tests/fixtures/github-comment-affordance.html",
  ]);
});
test.afterAll(() => fixtures?.close());
async function open(page) {
  await page.route("https://api.github.com/**", () => {
    throw new Error("Fixture attempted live GitHub access");
  });
  await page.goto(
    `${fixtures.origin}/tests/fixtures/github-inline-comments.html`,
  );
  await expect(page.getByText("STUB MODE — no GitHub requests")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "src/example.ts", exact: true }),
  ).toBeVisible();
}
async function select(page, name, value) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function line(page, value = "Old line 5000") {
  const file = page.getByRole("region", {
    name: "src/example.ts",
    exact: true,
  });
  await file.focus();
  for (let index = 0; index < (value === "New line 5001" ? 3 : 1); index++)
    await file.press("ArrowDown");
  await expect(file.getByRole("status")).toHaveText(value);
  await file.press("Enter");
  const field = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(field).toBeFocused();
  return field;
}
async function lineBlocked(page) {
  const file = page.getByRole("region", {
    name: "src/example.ts",
    exact: true,
  });
  await file.focus();
  await file.press("ArrowDown");
  await file.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveCount(0);
}
const posts = (page) =>
  page.evaluate(
    () =>
      window.inlineFixture.state.calls.filter((call) => call.args[0] === "POST")
        .length,
  );
// Pierre's annotation wrappers can remount sibling forms when a slot is removed.
for (const layout of ["Unified", "Split"]) {
  test(`keeps the cancelled line in place in ${layout}`, async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      window.inlineFixture.state.patch =
        "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,300 @@\n-old\n" +
        Array.from(
          { length: 300 },
          (_, index) => `+const value${index} = ${index};\n`,
        ).join("");
    });
    await page.getByRole("button", { name: "Refresh changes" }).click();
    if (layout === "Split") await select(page, "Diff layout", "Split");
    const file = page.getByRole("region", {
      name: "src/example.ts",
      exact: true,
    });
    const forms = [];
    for (const number of [20, 150, 280]) {
      await file
        .locator(
          `[data-column-number="${number}"][data-line-type="change-addition"]`,
        )
        .hover();
      await page
        .getByRole("button", { name: "Comment on hovered line" })
        .click();
      const field = page
        .getByRole("textbox", { name: "Comment", exact: true })
        .last();
      await field.fill(`Draft ${number}`);
      const operation = await field.evaluate(
        (node) => node.form.dataset.operation,
      );
      forms.push(file.locator(`form[data-operation="${operation}"]`));
    }
    const cancel = forms[1].getByRole("button", {
      name: "Cancel",
      exact: true,
    });
    await cancel.scrollIntoViewIfNeeded();
    const row = file.locator(
      '[data-column-number="150"][data-line-type="change-addition"]',
    );
    const top = (await row.boundingBox()).y;
    await cancel.click();
    await expect(forms[1]).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await row.boundingBox()).y - top))
      .toBeLessThan(2);
    await expect(forms[0].getByRole("textbox")).toHaveValue("Draft 20");
    await expect(forms[2].getByRole("textbox")).toHaveValue("Draft 280");
  });
  test(`cancels individual empty new-line boxes in ${layout}`, async ({
    page,
  }) => {
    await open(page);
    if (layout === "Split") await select(page, "Diff layout", "Split");
    const file = page.getByRole("region", {
      name: "src/example.ts",
      exact: true,
    });
    const forms = [];
    for (const [number, type] of [
      [5000, "change-addition"],
      [5001, "change-addition"],
      [5002, "context"],
    ]) {
      await file
        .locator(`[data-column-number="${number}"][data-line-type="${type}"]`)
        .hover();
      await page
        .getByRole("button", { name: "Comment on hovered line" })
        .click();
      const operation = await page
        .getByRole("textbox", { name: "Comment", exact: true })
        .evaluateAll(
          (nodes) =>
            nodes.find((node) => node === document.activeElement)?.form.dataset
              .operation,
        );
      forms.push(file.locator(`form[data-operation="${operation}"]`));
    }
    await expect(
      file.getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveCount(3);
    await forms[2].getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(forms[2]).toHaveCount(0);
    await expect(forms[0].getByRole("textbox")).toBeVisible();
    await expect(forms[1].getByRole("textbox")).toBeVisible();
    await forms[0].getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(forms[0]).toHaveCount(0);
    await expect(forms[1].getByRole("textbox")).toBeVisible();
    expect(await posts(page)).toBe(0);
  });
  test(`cancels only one reply and retains posted threads in ${layout}`, async ({
    page,
  }) => {
    await open(page);
    if (layout === "Split") await select(page, "Diff layout", "Split");
    await page.evaluate(() => {
      const state = window.inlineFixture.state;
      for (const [index, line] of [5000, 5001, 5002].entries()) {
        state.comments.push({
          id: index + 1,
          node_id: `comment-${index + 1}`,
          body: `Existing comment ${index + 1}`,
          user: { login: "example-reviewer" },
          html_url: `https://github.com/example-org/sample/pull/1#discussion_r${index + 1}`,
          created_at: "2026-01-01T00:00:00Z",
          commit_id: state.head,
          original_commit_id: state.head,
          path: "src/example.ts",
          side: "RIGHT",
          line,
          original_line: line,
        });
      }
    });
    await page.getByRole("button", { name: "Refresh changes" }).click();
    const threads = page.getByRole("region", {
      name: "Comments on src/example.ts",
      exact: true,
    });
    await expect(threads).toHaveCount(3);
    await threads
      .nth(0)
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("First reply");
    await threads
      .nth(1)
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Comment", exact: true })
      .last()
      .fill("Second reply");
    await page
      .getByRole("button", { name: "Cancel", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveValue("Second reply");
    for (const index of [1, 2, 3])
      await expect(
        page.getByText(`Existing comment ${index}`, { exact: true }),
      ).toBeVisible();
    expect(await posts(page)).toBe(0);
  });
  test(`preserves same-file drafts when another composer closes in ${layout}`, async ({
    page,
  }) => {
    await open(page);
    if (layout === "Split") await select(page, "Diff layout", "Split");
    const file = page.getByRole("region", {
      name: "src/example.ts",
      exact: true,
    });
    async function compose(number, type) {
      await file
        .locator(`[data-column-number="${number}"][data-line-type="${type}"]`)
        .hover();
      await page
        .getByRole("button", { name: "Comment on hovered line" })
        .click();
      const field = file
        .getByRole("textbox", { name: "Comment", exact: true })
        .last();
      const operation = await field.evaluate(
        (node) => node.form.dataset.operation,
      );
      return file.locator(`form[data-operation="${operation}"]`);
    }
    const first = await compose(5000, "change-deletion");
    await first.getByRole("textbox").fill("Discard this draft");
    const second = await compose(5001, "change-addition");
    await second.getByRole("textbox").fill("Keep the second draft");
    await first.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(first).toHaveCount(0);
    await expect(second.getByRole("textbox")).toHaveValue(
      "Keep the second draft",
    );
    const reopened = await compose(5000, "change-deletion");
    await expect(reopened.getByRole("textbox")).toHaveValue("");
    await reopened.getByRole("textbox").fill("Keep the reopened draft");
    await second.getByRole("button", { name: "Post to GitHub" }).click();
    await expect(second).toHaveCount(0);
    await expect(
      page.getByText("Keep the second draft", { exact: true }),
    ).toBeVisible();
    await expect(reopened.getByRole("textbox")).toHaveValue(
      "Keep the reopened draft",
    );
    await reopened.getByRole("button", { name: "Post to GitHub" }).click();
    await expect(reopened).toHaveCount(0);
    await expect(
      page.getByText("Keep the reopened draft", { exact: true }),
    ).toBeVisible();
    expect(await posts(page)).toBe(2);
    expect(
      await page.evaluate(() =>
        window.inlineFixture.state.comments.map(({ body, side, line }) => ({
          body,
          side,
          line,
        })),
      ),
    ).toEqual([
      { body: "Keep the second draft", side: "RIGHT", line: 5001 },
      { body: "Keep the reopened draft", side: "LEFT", line: 5000 },
    ]);
  });
}
for (const layout of ["Unified", "Split"]) {
  test(`real PR panel posts and replies through stub transport in ${layout}`, async ({
    page,
  }, testInfo) => {
    const errors = watchPageErrors(page);
    await open(page);
    await page.evaluate(() => {
      const state = window.inlineFixture.state;
      state.files.push({ filename: "src/second.ts" });
      state.patch +=
        "diff --git a/src/second.ts b/src/second.ts\n--- a/src/second.ts\n+++ b/src/second.ts\n@@ -7 +7 @@\n-const before = false;\n+const after = true;\n";
    });
    await page.getByRole("button", { name: "Refresh changes" }).click();
    await expect(
      page.getByRole("region", { name: "src/second.ts", exact: true }),
    ).toBeVisible();
    if (layout === "Split") await select(page, "Diff layout", "Split");
    await expect(
      page.locator('diffs-container pre[data-indicators="bars"]').first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "aaaaaaa", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Posting as|Read with your gh sign-in/),
    ).toHaveCount(0);
    const file = page.getByRole("region", {
      name: "src/example.ts",
      exact: true,
    });
    await file.focus();
    for (let index = 0; index < 4; index++) await file.press("ArrowDown");
    await expect(file.getByRole("status")).toHaveText(
      layout === "Split" ? "Old line 5001" : "New line 5002",
    );
    await file.press("Escape");
    await expect(file.getByRole("status")).toBeEmpty();
    const field = await line(page);
    await field.fill("Synthetic inline feedback");
    await field.press("Escape");
    await expect(
      page.getByRole("region", { name: "src/example.ts", exact: true }),
    ).toBeFocused();
    await expect(file.getByRole("status")).toBeEmpty();
    await line(page);
    await field.fill("Discard when leaving Changes");
    const originalOperation = await field.evaluate(
      (node) => node.form.dataset.operation,
    );
    const original = page.locator(
      `form[data-operation="${originalOperation}"]`,
    );
    const otherFile = page.getByRole("region", {
      name: "src/second.ts",
      exact: true,
    });
    await otherFile
      .locator('[data-column-number="7"][data-line-type="change-addition"]')
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await otherFile
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Independent second comment");
    await expect(original.getByRole("textbox")).toHaveValue(
      "Discard when leaving Changes",
    );
    await page
      .locator(
        'diffs-container [data-column-number="5000"][data-line-type="change-deletion"]',
      )
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await expect(original.getByRole("textbox")).toBeFocused();
    await expect(
      page.getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveCount(2);
    await otherFile
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(original.getByRole("textbox")).toHaveValue(
      "Discard when leaving Changes",
    );
    await page
      .locator("diffs-container")
      .first()
      .evaluate((node) => {
        window.savedDiffNode = node;
      });
    const readsBeforeTab = await page.evaluate(
      () => window.inlineFixture.state.calls.length,
    );
    await page.getByRole("tab", { name: "Summary", exact: true }).click();
    await page.getByRole("tab", { name: /^Changes/ }).click();
    expect(
      await page
        .locator("diffs-container")
        .first()
        .evaluate((node) => window.savedDiffNode === node),
    ).toBe(true);
    expect(
      await page.evaluate(() => window.inlineFixture.state.calls.length),
    ).toBe(readsBeforeTab);
    await expect(page.locator("diffs-container pre").first()).toHaveAttribute(
      "data-diff-type",
      layout === "Split" ? "split" : "single",
    );
    await expect(field).toHaveCount(0);
    await page
      .locator(
        'diffs-container [data-column-number="5001"][data-line-type="change-addition"]',
      )
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await expect(field).toHaveValue("");
    await field.fill("Synthetic inline feedback");
    await expect(field.locator("..")).not.toContainText("src/example.ts");
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`inline-${layout}-light.png`),
    });
    await page.getByRole("button", { name: "Post to GitHub" }).click();
    await expect(
      page.getByText("Synthetic inline feedback", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.inlineFixture.state.comments[0]),
    ).toMatchObject({
      user: { login: "example-reviewer" },
      path: "src/example.ts",
      side: "RIGHT",
      line: 5001,
      commit_id: "a".repeat(40),
    });
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await field.fill("Synthetic reply");
    await page.getByRole("button", { name: "Post to GitHub" }).click();
    await expect(
      page.getByText("Synthetic reply", { exact: true }),
    ).toBeVisible();
    expect(await posts(page)).toBe(2);
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await page
      .locator(
        'diffs-container [data-column-number="5001"][data-line-type="change-addition"]',
      )
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await expect(field).toBeFocused();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).hover();
    await expect(
      page.getByRole("button", { name: "Comment on hovered line" }),
    ).toHaveCount(0);
    await page
      .locator(
        'diffs-container [data-column-number="5000"][data-line-type="change-deletion"]',
      )
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await expect(field).toBeFocused();
    await field.press("Escape");
    const second = page.getByRole("region", {
      name: "src/second.ts",
      exact: true,
    });
    await second
      .locator('[data-column-number="7"][data-line-type="change-addition"]')
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    await expect(
      second.getByRole("textbox", { name: "Comment", exact: true }),
    ).toBeFocused();
    await field.press("Escape");
    await expect(second).toBeFocused();
    await second.press("ArrowDown");
    await second.press("Enter");
    await expect(
      second.getByRole("textbox", { name: "Comment", exact: true }),
    ).toBeFocused();
    await field.press("Escape");
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`inline-${layout}-dark.png`),
    });
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Diff layout" }),
    ).toHaveText("Unified");
    await expect(
      page.getByText("Synthetic inline feedback", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Synthetic reply", { exact: true }),
    ).toBeVisible();
    expect(errors.unexplained()).toEqual([]);
  });
}
for (const field of ["head", "base"]) {
  test(`rejects stale ${field} and opens a fresh composer after reselection`, async ({
    page,
  }) => {
    await open(page);
    const input = await line(page);
    await input.fill("Unsent stale comment");
    await page.getByRole("button", { name: `Advance ${field}` }).click();
    await page.getByRole("button", { name: "Post to GitHub" }).click();
    await expect(input).toHaveCount(0);
    expect(await posts(page)).toBe(0);
    await line(page, "New line 5001");
    await expect(input).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Post to GitHub" }),
    ).toBeDisabled();
  });
}
for (const [mode, message] of [
  ["denied", "Resource not accessible"],
  ["validation", "Invalid diff line"],
]) {
  test(`keeps text in the open composer on ${mode}`, async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      window.inlineFixture.state.merged = true;
    });
    await page.getByRole("button", { name: "Refresh changes" }).click();
    await expect(
      page.getByRole("region", { name: "src/example.ts", exact: true }),
    ).toBeVisible();
    await select(page, "Stub scenario", mode);
    const input = await line(page);
    await input.fill("Refused comment");
    await page.getByRole("button", { name: "Post to GitHub" }).click();
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(input).toHaveValue("Refused comment");
    expect(await posts(page)).toBe(1);
    expect(
      await page.evaluate(() => window.inlineFixture.state.comments.length),
    ).toBe(0);
  });
}
test("reconciles timeout-after-success across panel remount without reposting", async ({
  page,
}, testInfo) => {
  await open(page);
  await select(page, "Stub scenario", "timeout");
  const input = await line(page);
  await input.fill("Uncertain delivery");
  await page.getByRole("button", { name: "Post to GitHub" }).click();
  await expect(
    page.getByRole("button", { name: "Check delivery" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Remount panel" }).click();
  await expect(page.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
  await lineBlocked(page);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("unknown-delivery.png"),
  });
  await page.getByRole("button", { name: "Check delivery" }).click();
  await expect(
    page.getByText("Uncertain delivery", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check delivery" }),
  ).toHaveCount(0);
  expect(await posts(page)).toBe(1);
});
test("keeps sent separate from refresh failure", async ({ page }) => {
  await open(page);
  await select(page, "Stub scenario", "refresh-failed");
  const input = await line(page);
  await input.fill("Sent once");
  await page.getByRole("button", { name: "Post to GitHub" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Comment sent. Refresh failed",
  );
  await expect(input).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(page.getByText("Sent once", { exact: true })).toBeVisible();
  expect(await posts(page)).toBe(1);
});
test("holds dispatch while duplicate submission gestures produce one POST", async ({
  page,
}) => {
  await open(page);
  await select(page, "Stub scenario", "hold");
  const input = await line(page);
  await input.fill("Only once");
  await input.evaluate((node) => {
    node.form.requestSubmit();
    node.form.requestSubmit();
  });
  await expect.poll(() => posts(page)).toBe(1);
  await expect(
    page.getByRole("button", { name: "Post to GitHub" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Release held POST" }).click();
  await expect(page.getByText("Only once", { exact: true })).toBeVisible();
  expect(await posts(page)).toBe(1);
});
for (const [layout, column, side, coordinate] of [
  ["Unified", "additions", "RIGHT", 5002],
  ["Split", "deletions", "LEFT", 5001],
  ["Split", "additions", "RIGHT", 5002],
]) {
  test(`context hover selects ${side} directly in ${layout}`, async ({
    page,
  }) => {
    await open(page);
    if (layout === "Split") await select(page, "Diff layout", "Split");
    const file = page.getByRole("region", {
      name: "src/example.ts",
      exact: true,
    });
    await file
      .locator(
        `code[data-${layout === "Split" ? column : "unified"}] [data-column-number="${coordinate}"][data-line-type="context"]`,
      )
      .last()
      .hover();
    await page.getByRole("button", { name: "Comment on hovered line" }).click();
    const input = page.getByRole("textbox", { name: "Comment", exact: true });
    await expect(input).toBeFocused();
    await expect(
      page.getByRole("region", { name: "Choose comment side" }),
    ).toHaveCount(0);
    await input.fill("Context side");
    await page.getByRole("button", { name: "Post to GitHub" }).click();
    await expect(page.getByText("Context side", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => window.inlineFixture.state.comments[0]),
    ).toMatchObject({ side, line: coordinate });
  });
}
test("refresh into raw fallback discards composer and removes posting authority", async ({
  page,
}) => {
  await open(page);
  const input = await line(page);
  await input.fill("Unsent before fallback");
  await page.getByRole("button", { name: "Show raw patch" }).click();
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(page.getByRole("region", { name: "Raw diff" })).toBeVisible();
  await expect(input).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "src/example.ts", exact: true }),
  ).toHaveCount(0);
  expect(await posts(page)).toBe(0);
});
test("narrow enlarged-text panel keeps composer controls reachable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await open(page);
  const input = await line(page);
  await input.fill("Narrow layout");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const send = page.getByRole("button", { name: "Post to GitHub" });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("inline-narrow-large-light.png"),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("inline-narrow-large-dark.png"),
  });
});
test("failed snapshot refresh discards composer and invalidates posting authority", async ({
  page,
}) => {
  await open(page);
  const input = await line(page);
  await input.fill("Unsent before refresh failure");
  await page.getByRole("button", { name: "Toggle snapshot failure" }).click();
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic snapshot refresh failed",
  );
  await expect(input).toHaveCount(0);
  expect(await posts(page)).toBe(0);
  await page.getByRole("button", { name: "Advance head" }).click();
  await page.getByRole("button", { name: "Toggle snapshot failure" }).click();
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(
    page.getByRole("region", { name: "src/example.ts", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveCount(0);
  await line(page, "New line 5001");
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Post to GitHub" }),
  ).toBeDisabled();
});
test("checks unknown delivery even after snapshot refresh fails", async ({
  page,
}) => {
  await open(page);
  await select(page, "Stub scenario", "timeout");
  const input = await line(page);
  await input.fill("Check independently of diff");
  await page.getByRole("button", { name: "Post to GitHub" }).click();
  await expect(
    page.getByRole("button", { name: "Check delivery" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Toggle snapshot failure" }).click();
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(
    page.getByText("Synthetic snapshot refresh failed", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check delivery" }).click();
  await expect(
    page.getByRole("link", { name: "View on GitHub" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check delivery" }),
  ).toHaveCount(0);
  expect(await posts(page)).toBe(1);
});

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

test("opening one composer preserves code in 49 other commented files", async ({
  page,
}, testInfo) => {
  await open(page);
  await page.evaluate(() => {
    const state = window.inlineFixture.state;
    state.patch = "";
    state.files = [];
    state.comments = [];
    for (let index = 0; index < 50; index++) {
      const path = `src/file-${index}.ts`;
      state.files.push({ filename: path });
      state.patch +=
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,150 +1,150 @@\n` +
        "-const before = false;\n+const after = true;\n" +
        Array.from(
          { length: 149 },
          (_, line) => ` const value${line} = ${line};\n`,
        ).join("");
      state.comments.push({
        id: index + 1,
        node_id: `comment-${index}`,
        body: `Thread ${index}`,
        user: { login: "example-reviewer" },
        html_url: "https://github.com/example-org/sample/pull/1",
        created_at: "2026-01-01T00:00:00Z",
        commit_id: state.head,
        original_commit_id: state.head,
        path,
        side: "RIGHT",
        line: 1,
        original_line: 1,
      });
    }
  });
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(page.getByText("Thread 49", { exact: true })).toBeAttached();
  await expect(page.getByText("Loading comments…")).toHaveCount(0);
  await page.evaluate(() => {
    window.savedCodeNodes = [
      ...document.querySelectorAll("diffs-container"),
    ].map((node) => node.shadowRoot.querySelector("[data-line]"));
    if (
      window.savedCodeNodes.length !== 50 ||
      window.savedCodeNodes.some((node) => !node)
    )
      throw new Error("Incomplete render");
  });
  const file = page.getByRole("region", { name: "src/file-0.ts", exact: true });
  await file.focus();
  await file.press("ArrowDown");
  const start = performance.now();
  await file.press("Enter");
  await expect(
    file.getByRole("textbox", { name: "Comment", exact: true }),
  ).toBeFocused();
  const retained = await page.evaluate(() =>
    window.savedCodeNodes.slice(1).every((node) => node.isConnected),
  );
  expect(retained).toBe(true);
  await testInfo.attach("composer-open-local-timing", {
    body: JSON.stringify({
      milliseconds: performance.now() - start,
      files: 50,
    }),
    contentType: "application/json",
  });
  await file.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.savedCodeNodes.slice(1).every((node) => node.isConnected),
    ),
  ).toBe(true);
  await page.getByRole("tab", { name: "Summary" }).click();
  await expect(file).toBeHidden();
  await page.getByRole("tab", { name: /Changes/ }).click();
  await expect(file).toBeVisible();
  await expect(page.getByText("Thread 49", { exact: true })).toBeAttached();
  expect(
    await page.evaluate(() =>
      window.savedCodeNodes.slice(1).every((node) => node.isConnected),
    ),
  ).toBe(true);
});

test("keyboard line selection stays visible without moving file focus", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const state = window.inlineFixture.state;
    state.patch =
      "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,120 +1,120 @@\n" +
      Array.from(
        { length: 120 },
        (_, line) => ` const value${line} = ${line};\n`,
      ).join("");
  });
  await page.getByRole("button", { name: "Refresh changes" }).click();
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
