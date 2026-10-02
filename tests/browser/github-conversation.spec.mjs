import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";
import { fileURLToPath } from "node:url";

test.use({ historyCounts: { alpha: 1, beta: 0 }, hasTouch: true });
const target = "https://github.com/sample/project/pull/1";
const picture =
  "https://raw.githubusercontent.com/sample/project/main/preview.png";

// Browser-only: actual app wiring, themed reading surfaces, responsive geometry,
// native keyboard/touch activation and thumbnails as an inline disclosure target.
// Source recovery, paging and grouping matrices belong to colocated tests.
test("PR conversation hierarchy and disclosures survive themes, narrow panes and enlarged text", async ({
  page,
  context,
  app,
}, testInfo) => {
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const url = new URL(route.request().url());
      const common = { created_at: "2026-10-01T16:00:00Z" };
      const json = url.pathname.endsWith("/reviews")
        ? [
            {
              id: 10,
              submitted_at: "2026-10-01T18:00:00Z",
              state: "CHANGES_REQUESTED",
              user: { login: "reviewer" },
              body: "Keep the empty state useful.\n\n## Review details\n\nPlease preserve the retry action.",
            },
          ]
        : url.pathname.endsWith("/issues/1/comments")
          ? [
              {
                ...common,
                id: 20,
                user: { login: "contributor" },
                body: "The smaller layout is easier to read.\n\n## Discussion details\n\nThanks for keeping the metadata quiet.",
              },
            ]
          : url.pathname.endsWith("/pulls/1/comments")
            ? [
                {
                  ...common,
                  id: 30,
                  pull_request_review_id: 10,
                  path: "src/preview.ts",
                  line: 12,
                  diff_hunk: "@@ -10,1 +10,1 @@\n- oldPreview\n+ newPreview",
                  user: { login: "reviewer" },
                  body: "Can this handle an empty body?",
                },
                {
                  id: 31,
                  created_at: "2026-10-01T19:00:00Z",
                  in_reply_to_id: 30,
                  pull_request_review_id: 11,
                  user: { login: "author" },
                  body: "Yes, the fallback stays visible.",
                },
              ]
            : {
                ...common,
                title: "Make the conversation easier to follow",
                state: "open",
                user: { login: "author" },
                body: `A quieter conversation, with context when you need it.\n\n## Description details\n\n${Array.from({ length: 5 }, (_, index) => `![Preview ${index}](${picture}?image=${index})`).join("\n\n")}`,
                head: { label: "sample:conversation" },
                comments: 1,
              };
      return route.fulfill({ json });
    },
  );
  let previewScreenshot;
  await context.route(`${picture}*`, (route) =>
    route.fulfill({
      ...(previewScreenshot
        ? { body: previewScreenshot }
        : {
            path: fileURLToPath(
              new URL("../../public/app-icon.png", import.meta.url),
            ),
          }),
      contentType: "image/png",
    }),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  previewScreenshot = await page.screenshot();
  app.append("primary", "alpha", target);
  const link = page.locator(`a[href="${target}"]`);
  await expect(link).toBeAttached();
  await end(page);
  await link.click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const conversation = panel.getByRole("region", {
    name: "Pull request conversation",
    exact: true,
  });
  await expect(conversation.getByText("All pages loaded")).toHaveCount(3);
  const description = panel.getByRole("button", {
    name: "Expand Description",
    exact: true,
  });
  await expect(description).toHaveAttribute("aria-expanded", "false");
  await expect(description.locator("img")).toHaveCount(3);
  await expect(description).toContainText("+2");
  await expect(
    panel.getByRole("heading", { name: "Description details" }),
  ).toHaveCount(0);
  const comment = panel.getByRole("button", {
    name: "Expand Comment",
    exact: true,
  });
  const review = panel.getByRole("button", {
    name: "Expand Changes requested",
    exact: true,
  });
  expect((await comment.boundingBox()).y).toBeLessThan(
    (await review.boundingBox()).y,
  );
  await expect(description).toHaveCSS("font-size", "14px");
  await expect(
    conversation.locator(
      '[data-buzz-ui][aria-label="Description"] .buzz-avatar',
    ),
  ).toHaveCSS("width", "32px");
  await expect(
    conversation.locator('[data-buzz-ui][aria-label="Comment"] .buzz-avatar'),
  ).toHaveCSS("width", "24px");
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await panel.getByRole("heading").first().hover();
    await panel.screenshot({
      path: testInfo.outputPath(`conversation-${mode}.png`),
    });
  }
  // Pointer/touch on a thumbnail expands the description, never a media viewer.
  await description.locator("img").first().tap();
  await expect(
    panel.getByRole("heading", { name: "Description details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Image attachment" }),
  ).toHaveCount(0);
  await description.focus();
  await page.keyboard.press("Space");
  await expect(description).toHaveAttribute("aria-expanded", "false");
  await comment.focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "Discussion details" }),
  ).toBeVisible();
  await review.tap();
  await expect(
    panel.getByRole("heading", { name: "Review details" }),
  ).toBeVisible();
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  const thread = panel.getByRole("button", {
    name: "src/preview.ts:12 · 2 loaded comments",
  });
  await thread.click();
  await expect(panel.locator("pre")).toContainText("newPreview");
  await panel
    .getByRole("button", { name: "Expand Code comment by author" })
    .click();
  await expect(panel.getByText("Yes, the fallback stays visible.")).toHaveCount(
    2,
  );
  await panel.screenshot({
    path: testInfo.outputPath("conversation-expanded-dark.png"),
  });
  for (const width of [800, 480]) {
    await page.setViewportSize({ width, height: 950 });
    await description.scrollIntoViewIfNeeded();
    await description.screenshot({
      path: testInfo.outputPath(`summary-${width}.png`),
    });
    expect(
      await description.evaluate(
        (node) => node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
  }
  // Use the host's real text-scale preference; no substitute CSS scaling.
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.reload();
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  await page.locator(`a[href="${target}"]`).click();
  await expect(description).toHaveCSS("font-size", "28px");
  await expect(conversation.getByText("All pages loaded")).toHaveCount(3);
  await description.scrollIntoViewIfNeeded();
  const preview = description.locator("span").first().locator("span").first();
  expect((await preview.boundingBox()).width).toBeGreaterThan(100);
  expect(
    await description.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await description
    .locator("xpath=../..")
    .screenshot({ path: testInfo.outputPath("description-narrow-200.png") });
  await panel.screenshot({
    path: testInfo.outputPath("conversation-narrow-200.png"),
  });
});
