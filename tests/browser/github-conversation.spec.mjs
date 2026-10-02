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
                {
                  ...common,
                  id: 32,
                  path: "src/standalone.ts",
                  line: 8,
                  user: { login: "other-reviewer" },
                  body: "This code thread has no loaded review.",
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
  await expect(
    conversation.getByText("Conversation loaded · oldest first"),
  ).toBeVisible();
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
  const standalone = panel.getByRole("button", {
    name: "src/standalone.ts:8 · 1 loaded comment",
    exact: true,
  });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(conversation).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(conversation).toHaveCSS("padding", "0px");
    await expect(conversation).toHaveCSS("border-radius", "0px");
    const featuredFill = await conversation.evaluate((node) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--surface-popover)";
      node.append(probe);
      const fill = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return fill;
    });
    for (const label of ["Description", "Changes requested"]) {
      await expect(
        conversation.getByRole("group", { name: label, exact: true }),
      ).toHaveCSS("background-color", featuredFill);
    }
    const quiet = conversation.getByRole("group", {
      name: "Comment",
      exact: true,
    });
    await expect(quiet).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const geometry = await conversation.evaluate((node) => {
      const featured = node.querySelector('[aria-label="Description"]');
      const quiet = node.querySelector('[aria-label="Comment"]');
      const timeline = featured.parentElement;
      const rail = getComputedStyle(timeline, "::before");
      const commentTime = quiet.querySelector("time").getBoundingClientRect();
      const commentTrigger = quiet
        .querySelector('[aria-label="Expand Comment"]')
        .getBoundingClientRect();
      const avatar = quiet
        .querySelector(".buzz-avatar")
        .getBoundingClientRect();
      const featuredTrigger = featured
        .querySelector('[aria-label="Expand Description"]')
        .getBoundingClientRect();
      return {
        railX: timeline.getBoundingClientRect().left + parseFloat(rail.left),
        markerX: avatar.left + avatar.width / 2,
        textX: featuredTrigger.left,
        authorX: quiet.querySelector("a").parentElement.getBoundingClientRect()
          .left,
        timeX: commentTime.right,
        textRight: commentTrigger.right,
        sameRow:
          commentTime.top < commentTrigger.bottom &&
          commentTime.bottom > commentTrigger.top,
      };
    });
    expect(Math.abs(geometry.railX - geometry.markerX)).toBeLessThan(1);
    expect(Math.abs(geometry.textX - geometry.authorX)).toBeLessThan(1);
    expect(geometry.timeX).toBeGreaterThan(geometry.textRight);
    expect(geometry.sameRow).toBe(true);
    const standaloneIndent = await standalone.evaluate((node) => {
      const owner = node.closest(".buzz-accordion").parentElement;
      return {
        actual: getComputedStyle(owner).paddingLeft,
        token: getComputedStyle(owner).getPropertyValue("--space-16").trim(),
      };
    });
    expect(standaloneIndent.actual).toBe("64px");
    expect(standaloneIndent.token).toBe("4rem");
    await expect(conversation.getByText("All pages loaded")).toHaveCount(0);
    await panel.getByRole("heading").first().hover();
    await panel.screenshot({
      path: testInfo.outputPath(`conversation-${mode}.png`),
    });
  }
  const commentMarker = panel.getByRole("button", {
    name: "Toggle Comment",
    exact: true,
  });
  await description.focus();
  await page.keyboard.press("Tab");
  await expect(commentMarker).toBeFocused();
  await commentMarker.tap();
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  await commentMarker.focus();
  await page.keyboard.press("Space");
  await expect(comment).toHaveAttribute("aria-expanded", "false");
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
  await standalone.click();
  const standaloneComment = panel.getByRole("button", {
    name: "Expand Code comment by other-reviewer",
    exact: true,
  });
  await standaloneComment.click();
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
    expect(
      await conversation.evaluate(
        (node) => node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
    expect(
      await standaloneComment.evaluate(
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
  await expect(
    conversation.getByText("Conversation loaded · oldest first"),
  ).toBeVisible();
  await description.scrollIntoViewIfNeeded();
  const preview = description.locator("span").first().locator("span").first();
  expect((await preview.boundingBox()).width).toBeGreaterThan(100);
  expect(
    await description.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await standalone.click();
  await standaloneComment.click();
  expect(
    await conversation.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await standaloneComment.evaluate(
      (node) => node.scrollWidth <= node.clientWidth,
    ),
  ).toBe(true);
  await description
    .locator("xpath=../..")
    .screenshot({ path: testInfo.outputPath("description-narrow-200.png") });
  await panel.screenshot({
    path: testInfo.outputPath("conversation-narrow-200.png"),
  });
});
