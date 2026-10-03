import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";
import { fileURLToPath } from "node:url";

test.use({ historyCounts: { alpha: 1, beta: 0 }, hasTouch: true });
const target = "https://github.com/sample/project/pull/1";
const picture =
  "https://raw.githubusercontent.com/sample/project/main/preview.png";

// Browser-only: actual app wiring, event markers on an unboxed timeline, responsive geometry,
// keyboard/touch activation, one-line disclosure measurement and thumbnail lightboxes.
// Source recovery and paging matrices belong to colocated tests.
test("PR conversation hierarchy and disclosures survive themes, narrow panes and enlarged text", async ({
  page,
  context,
  app,
}, testInfo) => {
  const requests = [];
  // Exercise browser menu wiring without writing to the machine's clipboard.
  await page.addInitScript(() => {
    window.githubCopiedLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.githubCopiedLinks.push(value);
        },
      },
    });
  });
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      const common = { created_at: "2026-10-01T16:00:00Z" };
      if (url.pathname.endsWith("/check-runs"))
        return route.fulfill({ json: { total_count: 0, check_runs: [] } });
      if (url.pathname.endsWith("/status"))
        return route.fulfill({ json: { total_count: 0, statuses: [] } });
      const json = url.pathname.endsWith("/reviews")
        ? [
            {
              id: 10,
              submitted_at: "2026-10-01T18:00:00Z",
              state: "CHANGES_REQUESTED",
              user: { login: "reviewer" },
              body: `Keep the empty state useful. ${"A long review summary should stay within the pane while its actions remain separate from the disclosure. ".repeat(6)}\n\n## Review details\n\nPlease preserve the retry action.`,
            },
            {
              id: 11,
              submitted_at: "2026-10-01T20:00:00Z",
              state: "COMMENTED",
              user: { login: "reader" },
              body: "The **timeline** is easier to scan now, with all the context in place.",
            },
            {
              id: 12,
              submitted_at: "2026-10-01T21:00:00Z",
              state: "APPROVED",
              user: { login: "maintainer" },
              body: "",
            },
            {
              id: 13,
              submitted_at: "2026-10-01T20:10:00Z",
              state: "COMMENTED",
              user: { login: "inline-only" },
              body: "",
            },
            {
              id: 14,
              submitted_at: "2026-10-01T20:10:02Z",
              state: "COMMENTED",
              user: { login: "inline-only" },
              body: " \n ",
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
          : {
              ...common,
              title: "Make the conversation easier to follow",
              state: "open",
              user: { login: "author" },
              body: `A quieter conversation, with context when you need it.\n\n## Description details\n\n${Array.from({ length: 5 }, (_, index) => `![Preview ${index}](${picture}?image=${index})`).join("\n\n")}`,
              head: { label: "sample:conversation", sha: "head-sha" },
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
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("tab", { name: "Discussion", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    conversation.getByText("inline-only", { exact: true }),
  ).toHaveCount(0);
  await expect(conversation.getByRole("group")).toHaveCount(5);
  const longReview = conversation.getByRole("group", {
    name: "Changes requested",
    exact: true,
  });
  const expectReviewContained = async () => {
    await expect
      .poll(() =>
        longReview.evaluate((event) => {
          const header = event.querySelector('[class*="messageHeader"]');
          return (
            header.getBoundingClientRect().right <=
            event.getBoundingClientRect().right + 1
          );
        }),
      )
      .toBe(true);
  };
  await expectReviewContained();
  await longReview.hover();
  await expectReviewContained();
  expect([...requests].sort()).toEqual([
    "/repos/sample/project/issues/1/comments",
    "/repos/sample/project/pulls/1",
    "/repos/sample/project/pulls/1/reviews",
  ]);
  await panel.getByRole("tab", { name: "Checks", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("tabpanel", { name: "Checks" })).toContainText(
    "No checks",
  );
  expect([...requests].sort()).toEqual([
    "/repos/sample/project/commits/head-sha/check-runs",
    "/repos/sample/project/commits/head-sha/status",
    "/repos/sample/project/issues/1/comments",
    "/repos/sample/project/pulls/1",
    "/repos/sample/project/pulls/1/reviews",
  ]);
  await page.keyboard.press("ArrowLeft");
  await expect(
    panel.getByRole("tab", { name: "Discussion", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(conversation).toBeVisible();
  await panel.getByRole("tab", { name: "Checks", exact: true }).click();
  await expect(panel.getByRole("tabpanel", { name: "Checks" })).toContainText(
    "No checks",
  );
  await panel.getByRole("tab", { name: "Discussion", exact: true }).click();
  await expect(conversation).toBeVisible();
  expect(requests).toHaveLength(5);
  await expect(
    panel.locator("dt").filter({ hasText: /^Comments$/ }),
  ).toHaveCount(0);
  const description = panel.getByRole("button", {
    name: "Expand Description",
    exact: true,
  });
  await expect(description).toHaveAttribute("aria-expanded", "false");
  const descriptionEvent = conversation.getByRole("group", {
    name: "Description",
    exact: true,
  });
  const thumbnails = descriptionEvent
    .locator('[class*="thumbnails"]')
    .getByRole("button", { name: "Open image fullscreen" });
  const expectLayoutBasedThumbnails = async () => {
    const expectedCapacity = await descriptionEvent
      .locator('[class*="thumbnails"]')
      .evaluate((row) => {
        const tile = row.firstElementChild.getBoundingClientRect().width;
        const gap = parseFloat(getComputedStyle(row).columnGap);
        return Math.max(1, Math.floor((row.clientWidth + gap) / (tile + gap)));
      });
    const shown = Math.min(5, expectedCapacity);
    await expect(thumbnails).toHaveCount(shown);
    const tops = await thumbnails.evaluateAll((tiles) =>
      tiles.map((tile) => tile.getBoundingClientRect().top),
    );
    expect(new Set(tops).size).toBe(1);
    const remaining = 5 - shown;
    if (remaining)
      await expect(descriptionEvent).toContainText(`+${remaining}`);
    else
      await expect(
        descriptionEvent.locator('[class*="thumbnailCount"]'),
      ).toHaveCount(0);
  };
  await expect(thumbnails).toHaveCount(5);
  await expect(thumbnails.first().locator("img")).toHaveCSS(
    "object-fit",
    "cover",
  );
  await expect(descriptionEvent).not.toContainText("+2");
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
  const commentEvent = conversation.getByRole("group", {
    name: "Comment",
    exact: true,
  });
  const commentActions = commentEvent.getByRole("button", {
    name: "Comment actions",
  });
  const actionSlot = commentActions.locator("..");
  await expect(actionSlot).toHaveAttribute("data-collapsed", "true");
  await page.mouse.move(0, 0);
  const fineHover = await page.evaluate(
    () => matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
  if (fineHover) await expect(actionSlot).toHaveCSS("opacity", "0");
  else await expect(actionSlot).toHaveCSS("opacity", "1");
  await comment.focus();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await comment.hover();
  await expect(commentActions).toHaveCSS("width", "20px");
  await expect(commentActions).toHaveCSS("height", "20px");
  await commentActions.hover();
  await expect(commentActions).not.toHaveAttribute("aria-describedby");
  await commentActions.click();
  await expect(
    page.getByRole("menuitem", { name: "Copy comment link", exact: true }),
  ).toBeVisible();
  await panel.screenshot({
    path: testInfo.outputPath("comment-copy-menu.png"),
  });
  await page
    .getByRole("menuitem", { name: "Copy comment link", exact: true })
    .click();
  await expect(
    page.getByText("Comment link copied", { exact: true }),
  ).toBeVisible();
  await expect(comment).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([`${target}#issuecomment-20`]);
  await comment.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy comment link", exact: true })
    .click();
  await expect(comment).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([`${target}#issuecomment-20`, `${target}#issuecomment-20`]);
  await comment.focus();
  await page.keyboard.press("Shift+F10");
  const keyboardMenuItem = page.getByRole("menuitem", {
    name: "Copy comment link",
    exact: true,
  });
  await expect(keyboardMenuItem).toBeVisible();
  // Base UI applies keyboard focus after the popup mounts. Escape must originate
  // inside that popup, not race its initial focus handoff and close the host pane.
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(comment).toBeFocused();
  await comment.click();
  await expect(
    panel.getByRole("heading", { name: "Discussion details" }),
  ).toBeVisible();
  await expect(commentActions).toHaveCount(0);
  const copyAction = commentEvent.getByRole("button", {
    name: "Copy comment link",
    exact: true,
  });
  const actionsBox = await copyAction.boundingBox();
  const bodyBox = await commentEvent
    .locator('[class*="messageBody"]')
    .boundingBox();
  expect(actionsBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height);
  await panel.screenshot({
    path: testInfo.outputPath("comment-expanded-actions.png"),
  });
  await copyAction.tap();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  await comment.click();
  const reviewEvent = conversation.getByRole("group", {
    name: "Changes requested",
    exact: true,
  });
  await reviewEvent.getByRole("button", { name: "Comment actions" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("menuitem", { name: "Copy comment link", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([
      `${target}#issuecomment-20`,
      `${target}#issuecomment-20`,
      `${target}#issuecomment-20`,
      `${target}#pullrequestreview-10`,
    ]);
  await expect(review).toHaveAttribute("aria-expanded", "false");
  expect(requests).toHaveLength(5);

  await expect(description).toHaveCSS("font-size", "14px");
  await expect(
    conversation.locator(
      '[data-buzz-ui][aria-label="Description"] .buzz-avatar',
    ),
  ).toHaveCSS("width", "32px");
  await expect(conversation.locator(".buzz-avatar")).toHaveCount(1);
  for (const label of [
    "Comment",
    "Review comment",
    "Approved",
    "Changes requested",
  ]) {
    const marker = conversation
      .getByRole("group", { name: label, exact: true })
      .locator(":scope > div")
      .first();
    await expect(marker.locator("svg")).toHaveCSS("width", "20px");
  }
  const expectThumbnailsBelowExcerpt = async () => {
    const excerpt = description.locator("..").locator(":scope > span").last();
    const textBox = await excerpt.boundingBox();
    const imageBox = await descriptionEvent
      .locator("img")
      .first()
      .locator("..")
      .boundingBox();
    const caretBox = await description.locator(":scope > svg").boundingBox();
    expect(imageBox.y).toBeGreaterThan(textBox.y + textBox.height);
    expect(Math.abs(imageBox.x - textBox.x)).toBeLessThan(1);
    expect(caretBox.y).toBeLessThan(textBox.y + textBox.height);
  };
  const expectStationaryCarets = async () => {
    for (const trigger of [description, comment, review]) {
      const caretPosition = () =>
        trigger.evaluate((node) => {
          const content = node.parentElement.getBoundingClientRect();
          const caret = node
            .querySelector(":scope > svg")
            .getBoundingClientRect();
          return { x: caret.right - content.left, y: caret.top - content.top };
        });
      const baseline = () =>
        trigger.evaluate((node) => {
          const event = node.closest('[role="group"]');
          const content = event.lastElementChild;
          const author = content.querySelector("a").getBoundingClientRect();
          const time = content.querySelector("time").getBoundingClientRect();
          const text = [
            ...content.querySelectorAll(
              '[class*="previewText"], [class*="messageBody"] [class*="paragraph"]',
            ),
          ].find((element) => element.getClientRects().length);
          const range = document.createRange();
          range.selectNodeContents(text);
          const line = range.getClientRects()[0];
          const top = content.getBoundingClientRect().top;
          return {
            author: author.top - top,
            time: time.top - top,
            text: line.top - top,
          };
        });
      const collapsedBaseline = await baseline();
      const collapsed = await caretPosition();
      const headerBottom = await trigger.evaluate((node) => {
        const header = node.parentElement
          .querySelector("time")
          .getBoundingClientRect();
        return header.bottom - node.parentElement.getBoundingClientRect().top;
      });
      expect(collapsed.y).toBeLessThan(headerBottom);
      await trigger.locator(":scope > svg").click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect.poll(caretPosition).toEqual(collapsed);
      await expect.poll(baseline).toEqual(collapsedBaseline);
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect.poll(caretPosition).toEqual(collapsed);
    }
  };
  const singleLine = conversation.getByRole("group", {
    name: "Review comment",
    exact: true,
  });
  const singleLineTrigger = singleLine.getByRole("button", {
    name: "Expand Review comment",
    exact: true,
  });
  const wideViewport = page.viewportSize();
  await expect(singleLineTrigger).toHaveCount(0);
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(singleLineTrigger).toBeAttached();
  await singleLineTrigger.click();
  await expect(singleLineTrigger).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize(wideViewport);
  await expect(singleLineTrigger).toHaveCount(0);
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(singleLineTrigger).toHaveAttribute("aria-expanded", "true");
  await singleLineTrigger.click();
  await page.setViewportSize(wideViewport);
  await expect(singleLineTrigger).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(conversation).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(conversation).toHaveCSS("padding", "0px");
    await expect(conversation).toHaveCSS("border-radius", "0px");
    for (const label of [
      "Description",
      "Review comment",
      "Approved",
      "Changes requested",
    ]) {
      const event = conversation.getByRole("group", {
        name: label,
        exact: true,
      });
      await expect(event).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(event).toHaveCSS("border-radius", "0px");
      await expect(event).toHaveCSS("border-width", "0px");
      await expect(event).toHaveCSS("box-shadow", "none");
    }
    const colors = await conversation.evaluate((node) => {
      const resolved = (token) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        node.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const markerColor = (label) =>
        getComputedStyle(
          node.querySelector(`[role="group"][aria-label="${label}"] svg`),
        ).color;
      return {
        approved: markerColor("Approved"),
        requested: markerColor("Changes requested"),
        reviewed: markerColor("Review comment"),
        comment: markerColor("Comment"),
        success: resolved("--text-success"),
        danger: resolved("--text-danger"),
        neutral: resolved("--text-subtle"),
        standard: resolved("--text-standard"),
      };
    });
    expect(colors.approved).toBe(colors.success);
    expect(colors.requested).toBe(colors.danger);
    expect(colors.reviewed).toBe(colors.standard);
    expect(colors.comment).toBe(colors.neutral);
    expect(colors.reviewed).not.toBe(colors.comment);
    expect(
      new Set([colors.approved, colors.requested, colors.reviewed]).size,
    ).toBe(3);
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
        .querySelector('[aria-label="Toggle Comment"]')
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
        sameRow:
          commentTime.top < commentTrigger.bottom &&
          commentTime.bottom > commentTrigger.top,
      };
    });
    expect(Math.abs(geometry.railX - geometry.markerX)).toBeLessThan(1);
    expect(Math.abs(geometry.textX - geometry.authorX)).toBeLessThan(1);
    expect(geometry.sameRow).toBe(true);
    for (const label of [
      "Description",
      "Comment",
      "Review comment",
      "Changes requested",
    ]) {
      const layout = await conversation
        .getByRole("group", { name: label, exact: true })
        .evaluate((node) => {
          const author = node
            .querySelector("a")
            .parentElement.getBoundingClientRect();
          const time = node.querySelector("time").getBoundingClientRect();
          const excerpt = node
            .querySelector('[class*="previewText"], [class*="messageBody"]')
            .getBoundingClientRect();
          return {
            authorX: author.left,
            excerptX: excerpt.left,
            authorBottom: author.bottom,
            timeBottom: time.bottom,
            timeRight: time.right,
            excerptTop: excerpt.top,
          };
        });
      expect(Math.abs(layout.authorX - layout.excerptX)).toBeLessThan(1);
      expect(layout.excerptTop).toBeGreaterThanOrEqual(layout.authorBottom);
      expect(layout.excerptTop).toBeGreaterThanOrEqual(layout.timeBottom);
      expect(Math.abs(layout.timeRight - geometry.timeX)).toBeLessThan(1);
    }
    const descriptionTimeRight = await conversation
      .getByRole("group", { name: "Description", exact: true })
      .locator("time")
      .evaluate((node) => node.getBoundingClientRect().right);
    expect(Math.abs(descriptionTimeRight - geometry.timeX)).toBeLessThan(1);
    await expect(conversation.getByText("All pages loaded")).toHaveCount(0);
    await expect(thumbnails.first().locator("..")).toHaveCSS(
      "position",
      "relative",
    );
    const edge = await thumbnails
      .first()
      .locator("..")
      .evaluate((tile) => {
        const outline = getComputedStyle(tile, "::after");
        const probe = document.createElement("span");
        probe.style.color = "var(--border-standard)";
        tile.append(probe);
        const token = getComputedStyle(probe).color;
        probe.remove();
        return {
          width: outline.borderTopWidth,
          color: outline.borderTopColor,
          token,
        };
      });
    expect(edge.width).toBe("1px");
    expect(edge.color).toBe(edge.token);
    const bodyless = conversation.getByRole("group", {
      name: "Approved",
      exact: true,
    });
    const expectCentered = async () => {
      const centers = await bodyless.evaluate((row) => {
        const marker = row.firstElementChild.getBoundingClientRect();
        const metadata = row.lastElementChild.getBoundingClientRect();
        return {
          marker: marker.top + marker.height / 2,
          text: metadata.top + metadata.height / 2,
        };
      });
      expect(Math.abs(centers.marker - centers.text)).toBeLessThan(1);
    };
    await expectCentered();
    await expectThumbnailsBelowExcerpt();
    await expectStationaryCarets();
    await panel.getByRole("heading").first().hover();
    await panel.screenshot({
      path: testInfo.outputPath(`conversation-${mode}.png`),
    });
  }
  const timePositions = async () => {
    const positions = {};
    for (const label of ["Description", "Comment", "Changes requested"]) {
      positions[label] = await conversation
        .getByRole("group", { name: label, exact: true })
        .locator("time")
        .evaluate((node) => node.getBoundingClientRect().right);
    }
    return positions;
  };
  const collapsedTimes = await timePositions();
  const commentMarker = panel.getByRole("button", {
    name: "Toggle Comment",
    exact: true,
  });
  await thumbnails.first().focus();
  await expect(thumbnails.first()).toBeFocused();
  await commentMarker.tap();
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  await commentMarker.focus();
  await page.keyboard.press("Space");
  await expect(comment).toHaveAttribute("aria-expanded", "false");
  // Thumbnails open the shared lightbox without changing disclosure state.
  await thumbnails.first().tap();
  const lightbox = page.getByRole("dialog", { name: "Image attachment" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator("img")).toHaveAttribute(
    "src",
    `${picture}?image=0`,
  );
  await lightbox.screenshot({
    path: testInfo.outputPath("thumbnail-lightbox.png"),
  });
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(description).toHaveAttribute("aria-expanded", "false");
  await thumbnails.first().focus();
  await page.keyboard.press("Enter");
  await expect(lightbox).toBeVisible();
  await lightbox
    .getByRole("button", { name: "Close fullscreen viewer" })
    .click();
  await expect(thumbnails.first()).toBeFocused();
  const profile = descriptionEvent.getByRole("link", {
    name: "author",
    exact: true,
  });
  expect(
    await profile.evaluate((link) => {
      const box = link.getBoundingClientRect();
      return (
        document
          .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          ?.closest("a") === link
      );
    }),
  ).toBe(true);
  // Label, timestamp, excerpt and whitespace belong to the same large target.
  const header = description.locator("..");
  for (const content of [
    header.getByText("Description", { exact: true }),
    header.locator("time"),
    header.locator(":scope > span").last(),
  ]) {
    const box = await content.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(description).toHaveAttribute("aria-expanded", "true");
    await description.click();
  }
  await description.click();
  await expect(
    panel.getByRole("heading", { name: "Description details" }),
  ).toBeVisible();
  await expect(thumbnails.first()).toBeHidden();
  const fullImage = descriptionEvent
    .locator('[class*="attachment"] [data-image-preview]')
    .first();
  await expect(fullImage).toBeVisible();
  expect(
    await fullImage.evaluate(
      (node) => getComputedStyle(node, "::after").borderTopWidth,
    ),
  ).toBe("1px");
  expect(await timePositions()).toEqual(collapsedTimes);
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
  for (const expanded of [comment, review]) {
    await expect(
      expanded.locator("..").locator(":scope > span").last(),
    ).toBeHidden();
  }
  expect(await timePositions()).toEqual(collapsedTimes);
  const approval = conversation.getByRole("group", {
    name: "Approved",
    exact: true,
  });
  await expect(
    approval.getByRole("button", { name: /Expand|Toggle/ }),
  ).toHaveCount(0);
  await expect(approval.getByText("No message provided")).toHaveCount(0);
  await expect(approval).not.toContainText("loaded code threads");
  await expect(
    approval.locator('[class*="previewText"], [class*="messageBody"]'),
  ).toHaveCount(0);
  await panel.screenshot({
    path: testInfo.outputPath("conversation-expanded-dark.png"),
  });
  for (const width of [800, 480]) {
    await page.setViewportSize({ width, height: 950 });
    await expectReviewContained();
    await description.scrollIntoViewIfNeeded();
    await expectThumbnailsBelowExcerpt();
    await expectLayoutBasedThumbnails();
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
  await expectLayoutBasedThumbnails();
  const enlargedCenters = await approval.evaluate((row) => {
    const marker = row.firstElementChild.getBoundingClientRect();
    const content = row.lastElementChild.getBoundingClientRect();
    return [marker.top + marker.height / 2, content.top + content.height / 2];
  });
  expect(Math.abs(enlargedCenters[0] - enlargedCenters[1])).toBeLessThan(1);
  await expect(singleLineTrigger).toBeAttached();
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await description.scrollIntoViewIfNeeded();
  await expectThumbnailsBelowExcerpt();
  await expectStationaryCarets();
  const preview = description.locator("..").locator(":scope > span").last();
  expect((await preview.boundingBox()).width).toBeGreaterThan(100);
  expect(
    await description.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await conversation.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await description
    .locator("xpath=../..")
    .screenshot({ path: testInfo.outputPath("description-narrow-200.png") });
  await panel.screenshot({
    path: testInfo.outputPath("conversation-narrow-200.png"),
  });
  await expectReviewContained();
  await comment.click();
  await copyAction.scrollIntoViewIfNeeded();
  await expect(copyAction).toBeVisible();
  await copyAction.tap();
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([`${target}#issuecomment-20`]);
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  expect(
    await conversation.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await commentEvent.screenshot({
    path: testInfo.outputPath("expanded-actions-narrow-200.png"),
  });
});

// Browser-only: in-place group geometry, keyboard/touch disclosure, retained tab state and actual-app wiring.
// Ordering, decision boundaries, source failures and paging remain covered in Vitest.
test("conversation history expands around merge without hiding approval-only milestones", async ({
  page,
  app,
}, testInfo) => {
  const requests = [];
  const time = (hour) => `2026-10-01T${hour}:00:00Z`;
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path.includes("/3")) {
        return route.fulfill({
          json: /\/(?:comments|reviews)$/.test(path)
            ? []
            : {
                title: "Description without activity",
                body: "The proposal is ready to discuss.",
                state: "open",
                user: { login: "author" },
              },
        });
      }
      if (path.includes("/2/")) {
        return route.fulfill({
          json: path.endsWith("/reviews")
            ? [
                {
                  id: 30,
                  state: "APPROVED",
                  body: "",
                  submitted_at: time(16),
                  user: { login: "reviewer" },
                },
              ]
            : [],
        });
      }
      return route.fulfill({
        json: path.endsWith("/reviews")
          ? [
              {
                id: 9,
                state: "CHANGES_REQUESTED",
                body: "Please preserve the retry action.",
                submitted_at: time(12),
                user: { login: "reviewer" },
              },
              {
                id: 10,
                state: "COMMENTED",
                body: "The revised layout is clear.",
                submitted_at: time(14),
                user: { login: "reviewer" },
              },
              {
                id: 11,
                state: "APPROVED",
                body: "",
                submitted_at: time(16),
                user: { login: "maintainer" },
              },
            ]
          : path.endsWith("/issues/1/comments")
            ? [
                {
                  id: 20,
                  body: "Thanks for the first pass.",
                  created_at: time(13),
                  user: { login: "contributor" },
                },
                {
                  id: 21,
                  body: "The final adjustment is ready.",
                  created_at: time(15),
                  user: { login: "contributor" },
                },
                {
                  id: 22,
                  body: "Thanks for shipping this.",
                  created_at: time(19),
                  user: { login: "contributor" },
                },
              ]
            : path.endsWith("/check-runs")
              ? {
                  total_count: 4,
                  check_runs: [
                    {
                      name: "Unit tests",
                      status: "completed",
                      conclusion: "success",
                      details_url:
                        "https://github.com/sample/project/actions/runs/1",
                      output: { title: "All 420 tests passed" },
                    },
                    {
                      name: "Typecheck",
                      status: "completed",
                      conclusion: "failure",
                      output: { title: "A type needs updating" },
                    },
                    {
                      name: "Browser journeys / Chromium and WebKit at narrow and enlarged text sizes",
                      status: "completed",
                      conclusion: "success",
                      output: { title: "Both browser engines passed" },
                    },
                    {
                      name: "Optional deployment",
                      status: "completed",
                      conclusion: "skipped",
                    },
                  ],
                }
              : path.endsWith("/status")
                ? {
                    total_count: 1,
                    statuses: [
                      {
                        context: "DCO",
                        state: "success",
                        description: "All commits signed off",
                        target_url: "https://ci.example.test/dco/1",
                      },
                    ],
                  }
                : {
                    title: "Make the conversation easier to follow",
                    body: "A quieter history with decisions in view.",
                    state: "closed",
                    merged: true,
                    merged_at: time(18),
                    merged_by: { login: "maintainer" },
                    user: { login: "author" },
                    created_at: time(12),
                    head: { sha: "head-sha" },
                  },
      });
    },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
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
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  const trigger = conversation.getByRole("button", {
    name: /^(Show|Hide) 5 earlier messages$/,
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger.locator("svg")).toHaveCount(1);
  await expect(conversation.getByRole("group")).toHaveCount(2);
  const afterMerge = conversation.getByRole("button", {
    name: /^(Show|Hide) 1 message after merge$/,
  });
  await expect(afterMerge).toHaveAttribute("aria-expanded", "false");
  await expect(afterMerge).toContainText("1 message after merge");
  await expect(conversation.getByText("Thanks for shipping this.")).toHaveCount(
    0,
  );
  const approval = conversation.getByRole("group", {
    name: "Approved",
    exact: true,
  });
  const merge = conversation.getByRole("group", {
    name: "Merged",
    exact: true,
  });
  await expect(approval).toHaveCount(0);
  await expect(
    conversation.getByRole("group", { name: "Changes requested", exact: true }),
  ).toHaveCount(0);
  await expect(merge.locator("time")).toHaveAttribute("datetime", time(18));
  await expect
    .poll(() =>
      merge
        .locator("..")
        .evaluate((node) => getComputedStyle(node, "::before").content),
    )
    .toBe('""');
  await expect(
    merge.getByRole("link", { name: "maintainer", exact: true }),
  ).toHaveAttribute("href", "https://github.com/maintainer");
  const expectOrder = async () => {
    expect((await trigger.boundingBox()).y).toBeLessThan(
      (await merge.boundingBox()).y,
    );
    expect((await merge.boundingBox()).y).toBeLessThan(
      (await afterMerge.boundingBox()).y,
    );
  };
  await expectOrder();
  expect(requests).toHaveLength(3);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await panel.screenshot({
      path: testInfo.outputPath(`grouped-${mode}.png`),
    });
  }
  const mergeBefore = await merge.boundingBox();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveAccessibleName("Hide 5 earlier messages");
  await expect(trigger).toHaveText("Hide earlier messages");
  await expect(trigger).toBeFocused();
  await expect(conversation.getByRole("group")).toHaveCount(7);
  const history = conversation.locator(
    `[id="${await trigger.getAttribute("aria-controls")}"]`,
  );
  await expect
    .poll(() => history.evaluate((node) => node.style.height))
    .toBe("auto");
  await expect(history).toHaveCSS("overflow", "visible");
  await expect(
    conversation.getByRole("group", { name: "Review comment", exact: true }),
  ).toBeVisible();
  await expect(approval).toBeVisible();
  await expect(
    conversation.getByRole("group", { name: "Changes requested", exact: true }),
  ).toBeVisible();
  expect((await merge.boundingBox()).y).toBeGreaterThan(mergeBefore.y);
  expect((await approval.boundingBox()).y).toBeLessThan(
    (await merge.boundingBox()).y,
  );
  await expectOrder();
  await afterMerge.focus();
  await page.keyboard.press("Enter");
  await expect(afterMerge).toHaveText("Hide messages after merge");
  await expect(conversation.getByRole("group")).toHaveCount(8);
  await expect(conversation.getByRole("group").last()).toContainText(
    "Thanks for shipping this.",
  );
  expect((await merge.boundingBox()).y).toBeLessThan(
    (await conversation.getByRole("group").last().boundingBox()).y,
  );
  await page.keyboard.press("Space");
  await expect(afterMerge).toHaveText(/1 message after merge/);
  await expect(conversation.getByRole("group")).toHaveCount(7);
  await panel.getByRole("tab", { name: "Checks", exact: true }).click();
  const checks = panel.getByRole("tabpanel", { name: "Checks" });
  await expect(checks).toContainText("Some checks were not successful");
  const checkRows = checks.getByRole("listitem");
  await expect(checkRows).toHaveCount(5);
  await expect(checkRows.filter({ hasText: "Passed" })).toHaveCount(3);
  await expect(checkRows.first()).toContainText("Failed");
  await expect(checkRows.nth(1)).toContainText("Skipped");
  const successful = checks.getByRole("button", {
    name: "3 successful checks",
  });
  await successful.focus();
  await page.keyboard.press("Space");
  await expect(successful).toHaveAttribute("aria-expanded", "false");
  await expect(
    checks.getByRole("link", { name: "Unit tests", exact: true }),
  ).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(successful).toHaveAttribute("aria-expanded", "true");
  const unitLink = checks.getByRole("link", {
    name: "Unit tests",
    exact: true,
  });
  await expect(unitLink).toHaveAttribute(
    "href",
    "https://github.com/sample/project/actions/runs/1",
  );
  await unitLink.focus();
  await expect(unitLink).toBeFocused();
  await unitLink.blur();
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(checkRows.first().locator("svg")).toHaveCSS(
      "color",
      await checks
        .locator('circle[data-check-category="failing"]')
        .evaluate((node) => getComputedStyle(node).stroke),
    );
    await panel.screenshot({ path: testInfo.outputPath(`checks-${mode}.png`) });
  }
  await successful.tap();
  await expect(successful).toHaveAttribute("aria-expanded", "false");
  await panel.getByRole("tab", { name: "Discussion", exact: true }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(requests).toHaveLength(5);
  await page.setViewportSize({ width: 800, height: 950 });
  await expectOrder();
  await panel.screenshot({
    path: testInfo.outputPath("grouped-expanded-narrow.png"),
  });
  await trigger.tap();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(conversation.getByRole("group")).toHaveCount(2);
  await expect(trigger).toHaveAccessibleName("Show 5 earlier messages");
  await expect(trigger).toContainText("5 earlier messages");
  // Normal pointer motion must expose intermediate heights and settle unclipped.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const motionFrames = await trigger.evaluate(async (button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    const samples = [];
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const node = document.getElementById(
        button.getAttribute("aria-controls"),
      );
      if (!node) continue;
      samples.push({
        height: node.getBoundingClientRect().height,
        target: node.scrollHeight,
      });
      if (node.style.height === "auto") return samples;
    }
    throw new Error("History reveal did not settle");
  });
  expect(
    motionFrames.some(({ height, target }) => height > 0 && height < target),
  ).toBe(true);
  await expect(history).toHaveCSS("overflow", "visible");
  await expect(trigger).toHaveText("Hide earlier messages");
  await panel.screenshot({
    path: testInfo.outputPath("history-motion-expanded.png"),
  });
  // Interrupt a pointer close with another pointer open in the same browser frame.
  await trigger.evaluate(async (button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await new Promise(requestAnimationFrame);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(conversation.getByRole("group")).toHaveCount(7);
  await expect
    .poll(() => history.evaluate((node) => node.style.height))
    .toBe("auto");
  await expect(history).toHaveCSS("overflow", "visible");
  await trigger.focus();
  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(conversation.getByRole("group")).toHaveCount(2);
  expect(requests).toHaveLength(5);
  await panel.getByRole("tab", { name: "Checks", exact: true }).click();
  await expect(successful).toHaveAttribute("aria-expanded", "false");
  await successful.tap();
  await expect(checkRows).toHaveCount(5);
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await expect(checks.locator('[class*="checkSummaryLabel"]')).toHaveCSS(
    "font-size",
    "40px",
  );
  for (const width of [800, 480]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await checks.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(
      await checkRows.evaluateAll((rows) =>
        rows.every((node) => node.scrollWidth <= node.clientWidth),
      ),
    ).toBe(true);
    await checks.locator("[data-check-state]").scrollIntoViewIfNeeded();
    await panel.screenshot({
      path: testInfo.outputPath(`checks-${width}-200.png`),
    });
    await checkRows.last().scrollIntoViewIfNeeded();
    await panel.screenshot({
      path: testInfo.outputPath(`checks-rows-${width}-200.png`),
    });
  }
  expect(requests).toHaveLength(5);
  // Approval-only is an ordinary milestone row, not a one-event disclosure.
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "1");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  const approvalTarget = target.replace("/1", "/2");
  app.append("primary", "alpha", approvalTarget);
  const approvalReference = page.locator(`a[href="${approvalTarget}"]`);
  await expect(approvalReference).toBeAttached();
  await end(page);
  await approvalReference.click();
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await expect(approval).toBeVisible();
  await expect(merge).toBeVisible();
  await expect(
    conversation.getByText(/Conversation loaded|oldest first/),
  ).toHaveCount(0);
  await expect(
    conversation.getByRole("button", { name: /earlier|after merge/ }),
  ).toHaveCount(0);
  expect((await approval.boundingBox()).y).toBeLessThan(
    (await merge.boundingBox()).y,
  );
  await panel.screenshot({
    path: testInfo.outputPath("approval-only-milestone.png"),
  });
  const emptyTarget = target.replace("/1", "/3");
  app.append("primary", "alpha", emptyTarget);
  const emptyReference = page.locator(`a[href="${emptyTarget}"]`);
  await expect(emptyReference).toBeAttached();
  await end(page);
  await emptyReference.click();
  await expect(
    panel.getByRole("heading", { name: "Description without activity #3" }),
  ).toBeVisible();
  await expect(conversation.getByRole("group")).toHaveCount(1);
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await expect(
    conversation.getByText(
      /That’s it|No discussion comments|Conversation loaded/,
    ),
  ).toHaveCount(0);
  const timeline = conversation
    .getByRole("group", { name: "Description" })
    .locator("..");
  await expect
    .poll(() =>
      timeline.evaluate((node) => getComputedStyle(node, "::before").content),
    )
    .toBe("none");
  await panel.screenshot({ path: testInfo.outputPath("description-only.png") });
});
