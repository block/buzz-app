import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { holdReadingFocusNow, releaseReadingFocus } from "./reading.mjs";
import { open, settle, virtuaIdle } from "./timeline.mjs";

test.use({
  threadPlacement: "inline",
  historyCounts: { alpha: 1, beta: 0 },
  detailsMessage: `The sidebar keeps its place.\n\n${"It holds while channels load. ".repeat(30)}`,
});

// Only a real engine lays the sheet out around the composer and decides which
// surface a press at the composer reaches; jsdom has neither layout nor paint.
test("details grow out of the composer, which stays usable above them", async ({
  page,
  app,
}) => {
  await open(page, app);
  const more = page.getByRole("button", { name: "Show more" });
  await more.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const composer = page.locator("[data-message-composer]");
  // The settled sheet surrounds the composer: no growth animation is running.
  await expect
    .poll(() =>
      sheet.evaluate((element) =>
        element.getAnimations().some((a) => a.playState === "running"),
      ),
    )
    .toBe(false);
  const [outer, inner] = [
    await sheet.boundingBox(),
    await composer.boundingBox(),
  ];
  expect(outer.x).toBeLessThan(inner.x);
  expect(outer.x + outer.width).toBeGreaterThan(inner.x + inner.width);
  expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
  expect(outer.y).toBeLessThan(inner.y - 200);
  // The composer paints above the sheet and takes a reply without closing it.
  expect(
    await composer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return element.contains(hit);
    }),
  ).toBe(true);
  const reply = page.getByRole("textbox", { name: "Message #Alpha" });
  await reply.click();
  await reply.pressSequentially("Thanks");
  await expect(sheet).toBeVisible();
  await reply.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("Thanks");
});

// Base UI's initial focus and the header's focus tooltips only meet in a real
// engine: opening from the keyboard must leave one Escape closing the sheet.
// Every sheet without its own composer, reader or not, focuses itself.
test("a details sheet opened from the keyboard closes with one Escape", async ({
  page,
  app,
}) => {
  await open(page, app);
  const more = page.getByRole("button", { name: "Show more" });
  await more.focus();
  await page.keyboard.press("Enter");
  const sheet = page.locator("[data-details-sheet-surface]");
  await expect(sheet).toBeVisible();
  await expect(sheet).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
});

// Real hit testing proves the replacement composer is above the scrim, while
// the channel draft remains mounted and cannot receive the thread reply.
// Focus is a real-engine contract: the sheet unmounting must not pull it
// back to the timeline after the tab placed it.
test("Open as tab hands the reply target, draft and focus to the thread tab", async ({
  page,
  app,
}) => {
  await open(page, app);
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator("[data-message-id]")
    .first();
  const rootId = await row.getAttribute("data-message-id");
  const parent = app.append(
    "primary",
    "alpha",
    "Nested parent",
    true,
    false,
    rootId,
  );
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const sheet = page.getByRole("dialog");
  const nested = sheet.locator(`[data-message-id="${parent.id}"]`);
  await expect(nested).toBeVisible();
  await hoverMessage(nested);
  await nested.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Reply to thread" });
  await expect(editor).toBeFocused();
  await page.keyboard.type("Nested draft");
  await sheet.getByRole("button", { name: "Open as tab", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(
    page
      .getByRole("tablist", { name: "Panel tabs" })
      .getByRole("tab", { selected: true }),
  ).toHaveText(/primary alpha message 0/);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("Nested draft");
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  await page.keyboard.type(" continues");
  await expect(editor).toHaveText("Nested draft continues");
});

// Only the app's tab host shows a reader tab outliving a collapsed row.
test("a diff tab keeps its layout on Expand and outlives its branch", async ({
  page,
  app,
}) => {
  await open(page, app);
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator("[data-message-id]")
    .first();
  const rootId = await row.getAttribute("data-message-id");
  const branch = app.append("primary", "alpha", "Branch", true, false, rootId);
  app.append(
    "primary",
    "alpha",
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    true,
    false,
    rootId,
    branch.id,
    [["file", "a.ts"]],
    undefined,
    40008,
  );
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^View 1 reply/ }).click();
  // The sheet fits its content, so it resizes when the highlighted diff
  // replaces the raw patch, and Open as tab moves with it.
  await expect(sheet.locator("diffs-container pre").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Open as tab", exact: true }).click();
  await expect(sheet).toBeHidden();
  const tabs = page.getByRole("tablist", { name: "Panel tabs" });
  const threadTab = tabs.getByRole("tab", { name: /primary alpha message 0/ });
  await page.getByRole("button", { name: /^View 1 reply/ }).click();
  const card = page.getByRole("region", { name: "Diff: a.ts" });
  const expand = card.getByRole("button", { name: "Expand diff" });
  // Expand moves when the highlighted diff replaces the raw patch.
  await expect(card.locator("diffs-container pre").first()).toBeVisible();
  await expand.click();
  const reader = page.getByRole("dialog");
  await reader
    .getByRole("button", { name: "Open as tab", exact: true })
    .click();
  await expect(reader).toBeHidden();
  const diffTab = tabs.getByRole("tab", { name: "a.ts" });
  await expect(diffTab).toHaveAttribute("aria-selected", "true");
  const split = page.getByRole("button", { name: "Split", exact: true });
  await split.click();
  await threadTab.click();
  await expand.click();
  // Expand selects the diff's tab as it was, not a new reader at Unified.
  await expect(diffTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(split).toHaveAttribute("aria-pressed", "true");
  // The tab reads its own copy of the diff, so the branch can collapse.
  await threadTab.click();
  await page.getByRole("button", { name: "Collapse 1 reply" }).click();
  await expect(threadTab).toHaveAttribute("aria-selected", "true");
  await diffTab.click();
  await expect(split).toHaveAttribute("aria-pressed", "true");
});

test("thread sheet keeps its reply composer usable and restores the channel draft", async ({
  page,
  app,
}) => {
  await open(page, app);
  const channelEditor = page.getByRole("textbox", { name: "Message #Alpha" });
  await channelEditor.fill("Channel draft");
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator("[data-message-id]")
    .first();
  const rootId = await row.getAttribute("data-message-id");
  const sourceComposer = page.locator("[data-message-composer]").first();
  let release, observed;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit || filter.ids)
    )
      return route.continue();
    observed();
    await held;
    await route.continue().catch(() => {});
  });
  const sheet = page.getByRole("dialog", { name: "Thread", exact: true });
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches("[data-contained-composer]")) {
        Element.prototype.animate = animate;
        animation.pause();
        animation.currentTime = 0;
      }
      return animation;
    };
  });
  try {
    await hoverMessage(row);
    await row.getByRole("button", { name: "Reply", exact: true }).click();
    await started;
    await expect(sheet).toBeVisible();
    // Opening a known root must paint its cached message and scoped editor
    // while the real network gate still holds the reply refresh back.
    await expect(sheet.locator(`[data-message-id="${rootId}"]`)).toBeVisible();
    await expect(sheet.getByRole("textbox")).toBeVisible();
    // The folded surface starts on the editor outline, without painting the
    // extra surrounding gutter until it opens (including rem-scaled spacing).
    expect(
      await sheet.evaluate((element) => {
        const editor = element
          .querySelector("[data-message-composer]")
          .getBoundingClientRect();
        const hit = (x, y) => element.contains(document.elementFromPoint(x, y));
        return [
          hit(editor.left - 2, editor.top + editor.height / 2),
          hit(editor.right + 2, editor.top + editor.height / 2),
          hit(editor.left + editor.width / 2, editor.bottom + 2),
        ];
      }),
    ).toEqual([false, false, false]);
    // Hold the opening at its folded boundary after cached content mounts.
    // Its header must still be clipped, while the bottom editor stays painted.
    expect(
      await sheet.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 10),
        );
      }),
    ).toBe(false);
  } finally {
    await sheet.evaluate((element) =>
      element.getAnimations().forEach((animation) => {
        animation.play();
      }),
    );
    release();
  }
  const reply = sheet.getByRole("textbox");
  await reply.fill("Thread draft");
  await expect(reply).toHaveText("Thread draft");
  await expect(reply).toBeInViewport();
  await expect(channelEditor).toBeHidden();
  // Thread expansion uses the same stationary composer footprint as Show more.
  // Await the real handoff before comparing layout; editor content may change height.
  await expect
    .poll(() =>
      sheet
        .locator("[data-message-composer]")
        .evaluate((element) =>
          element
            .getAnimations()
            .some((animation) => animation.playState === "running"),
        ),
    )
    .toBe(false);
  const originalBounds = await sourceComposer.boundingBox();
  const replyBounds = await sheet
    .locator("[data-message-composer]")
    .boundingBox();
  expect(replyBounds.x).toBeCloseTo(originalBounds.x, 0);
  expect(replyBounds.width).toBeCloseTo(originalBounds.width, 0);
  expect(replyBounds.y + replyBounds.height).toBeCloseTo(
    originalBounds.y + originalBounds.height,
    0,
  );
  // Hold the actual exit mid-flight, not an arbitrary sleep after clicking.
  await sheet.evaluate((element) => {
    element.addEventListener(
      "click",
      () =>
        requestAnimationFrame(() => {
          const animations = element.getAnimations();
          for (const animation of animations) {
            animation.pause();
            animation.currentTime =
              Number(animation.effect.getTiming().duration) / 2;
          }
          element.dataset.exitSampled = String(animations.length);
        }),
      { once: true },
    );
  });
  try {
    await sheet
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(sheet).toHaveAttribute("data-exit-sampled", /^[1-9]/);
    await expect(sourceComposer).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("thread-sheet-exit.png"),
    });
  } finally {
    await sheet.evaluate((element) =>
      element.getAnimations().forEach((animation) => {
        animation.play();
      }),
    );
  }
  await expect(sheet).toBeHidden();
  await expect(channelEditor).toBeVisible();
  await expect(channelEditor).toHaveText("Channel draft");
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(sheet.getByRole("textbox")).toHaveText("Thread draft");
  await expect
    .poll(() =>
      sheet.evaluate((element) =>
        element
          .getAnimations()
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
  await sheet.getByRole("textbox").press("Escape");
  await expect(sheet).toBeHidden();
  await expect(channelEditor).toHaveText("Channel draft");
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(sheet.getByRole("textbox")).toHaveText("Thread draft");
  const shortHeight = (await sheet.boundingBox()).height;
  await page.screenshot({
    path: test.info().outputPath("thread-sheet-short.png"),
  });
  // Keep reading focus out of the thread until the sheet reopens, so the
  // reading dwell cannot mark the long reply read before the reopen checks
  // where an unread reply places the thread.
  await holdReadingFocusNow(page);
  const longReply = app.append(
    "primary",
    "alpha",
    "Long thread reply\n".repeat(80),
    true,
    false,
    rootId,
  );
  await expect(
    sheet.locator(`[data-message-id="${longReply.id}"]`),
  ).toBeAttached();
  await expect
    .poll(() =>
      sheet.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(shortHeight);
  const history = sheet.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect
    .poll(() =>
      history.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  // The scrollport reaches behind the fixed header; its controls still win hits.
  const header = sheet.locator("header");
  const [headerBounds, historyBounds] = await Promise.all([
    header.boundingBox(),
    history.boundingBox(),
  ]);
  expect(historyBounds.y).toBeLessThanOrEqual(headerBounds.y + 1);
  expect(
    await header.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(box.x + 24, box.y + 24),
      );
    }),
  ).toBe(true);
  expect(
    await sheet.evaluate(
      (element) =>
        element.getBoundingClientRect().height <=
        Number.parseFloat(getComputedStyle(element).maxHeight) + 1,
    ),
  ).toBe(true);
  await expect(sheet.getByRole("textbox")).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath("thread-sheet-long.png"),
  });
  await sheet.getByRole("textbox").press("Escape");
  await expect(sheet).toBeHidden();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    sheet.locator(`[data-message-id="${longReply.id}"]`),
  ).toBeAttached();
  await expect(history).toHaveAttribute("aria-busy", "false");
  // Reopening starts at the first unread reply, as a side-pane thread does:
  // the long reply begins in view instead of the thread scrolling past it.
  await expect(history.locator("[data-new-messages-boundary]")).toBeAttached();
  await expect
    .poll(() =>
      history.evaluate((element, id) => {
        const reply = element.querySelector(`[data-message-id="${id}"]`);
        const top =
          reply.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        return top >= 0 && top < element.clientHeight;
      }, longReply.id),
    )
    .toBe(true);
  await releaseReadingFocus(page);
  // A sheet belongs to this conversation, not to the whole application.
  // Real clicks prove the sidebar and global controls remain reachable.
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta" }),
  ).toBeVisible();
  await expect(sheet).toBeHidden();
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: /^Alpha\b/ })
    .click();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(sheet.getByRole("textbox")).toHaveText("Thread draft");
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  await expect(search).toBeVisible();
  await search.getByRole("combobox").press("Escape");
  await expect(search).toBeHidden();
  await expect(sheet.getByRole("textbox")).toHaveText("Thread draft");
  await sheet.getByRole("button", { name: "Open as tab", exact: true }).click();
  await expect(sheet).toBeHidden();
  // The thread opens as its own thread tab, named by its root, draft and all.
  await expect(
    page
      .getByRole("tablist", { name: "Panel tabs" })
      .getByRole("tab", { selected: true }),
  ).toHaveText(/primary alpha message 0/);
  await expect(
    page.getByRole("textbox", { name: "Reply to thread" }),
  ).toHaveText("Thread draft");
});

test.describe("image comments", () => {
  test.use({ productionBroker: true });

  test("photo opens above an editable comment composer", async ({
    page,
    app,
  }) => {
    const picture = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      context.fillStyle = "#4d80b0";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.route("**/api/relay/primary/media?**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(picture, "base64"),
      }),
    );
    await open(page, app);
    const event = app.append(
      "primary",
      "alpha",
      "Photo to discuss",
      true,
      true,
      undefined,
      undefined,
      [["imeta", "url https://primary.example/media/photo.png", "m image/png"]],
    );
    const row = page
      .getByRole("region", { name: "Channel message history" })
      .locator(`[data-message-id="${event.id}"]`);
    let release, observed;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      observed = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.depth_limit || filter.ids)
      )
        return route.continue();
      observed();
      await held;
      await route.continue().catch(() => {});
    });
    await row.getByRole("link", { name: "Open image attachment" }).click();
    const sheet = page.getByRole("dialog", { name: "photo.png" });
    const stage = sheet.locator("[data-review-stage]");
    let loadingBounds;
    let pendingEditor;
    let composerBounds;
    try {
      await started;
      await sheet
        .getByRole("textbox", { name: "Reply to thread" })
        .fill("Photo comment draft");
      pendingEditor = await sheet
        .getByRole("textbox", { name: "Reply to thread" })
        .elementHandle();
      await sheet
        .getByRole("textbox", { name: "Reply to thread" })
        .press("Enter");
      await expect(
        sheet.getByRole("textbox", { name: "Reply to thread" }),
      ).toHaveText("Photo comment draft");
      await expect(
        sheet.getByRole("img", { name: "Attachment preview" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          sheet.evaluate((element) =>
            element
              .getAnimations()
              .some((animation) => animation.playState === "running"),
          ),
        )
        .toBe(false);
      loadingBounds = await stage.boundingBox();
      composerBounds = await sheet
        .locator("[data-message-composer]")
        .boundingBox();
    } finally {
      release();
    }
    const comment = sheet.getByRole("textbox", { name: "Reply to thread" });
    await expect(sheet.getByText("Loading comments…")).toHaveCount(0);
    await expect(comment).toHaveText("Photo comment draft");
    expect(await pendingEditor.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    const readyComposerBounds = await sheet
      .locator("[data-message-composer]")
      .boundingBox();
    expect(readyComposerBounds.y).toBeCloseTo(composerBounds.y, 0);
    const readyBounds = await stage.boundingBox();
    expect(readyBounds.height).toBeCloseTo(loadingBounds.height, 0);
    expect(readyBounds.y).toBeCloseTo(loadingBounds.y, 0);
    await expect(comment).toBeInViewport();
    await expect(
      sheet.getByRole("button", { name: "Zoom in", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("photo-sheet.png") });
    await sheet
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      sheet.getByText("Photo comment draft", { exact: true }),
    ).toBeVisible();
    expect((await stage.boundingBox()).height).toBeCloseTo(
      readyBounds.height,
      0,
    );
    const commentsBounds = await sheet
      .getByRole("complementary", { name: "Media comments" })
      .boundingBox();
    expect(commentsBounds.x).toBeGreaterThanOrEqual(
      readyBounds.x + readyBounds.width - 1,
    );
    await expect(comment).toBeInViewport();
    await expect(comment).toBeEmpty();
    await page.screenshot({
      path: test.info().outputPath("photo-sheet-commented.png"),
    });
    await sheet.getByRole("button", { name: "Close media viewer" }).click();
    await expect(sheet).toBeHidden();
    await row.getByRole("link", { name: "Open image attachment" }).click();
    await expect(
      sheet.getByText("Photo comment draft", { exact: true }),
    ).toBeVisible();
    expect((await stage.boundingBox()).width).toBeCloseTo(readyBounds.width, 0);
    await page.getByRole("button", { name: "Beta", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta" }),
    ).toBeVisible();
  });
});

// Browser paint is the contract: a descendant can override inherited visibility.
test.describe("expanded thread scroll controls", () => {
  test.use({ historyCounts: { alpha: 30, beta: 0 } });

  test("only the expanded thread shows its jump control", async ({
    page,
    app,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("buzz-appearance.v1", "dark");
    });
    await open(page, app);
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    const channel = page.getByRole("region", {
      name: "Channel message history",
    });
    const backgroundJump = channel.locator("[data-jump-to-latest]");
    const row = channel.locator("[data-message-id]").last();
    const rootId = await row.getAttribute("data-message-id");
    await hoverMessage(row);
    await row.getByRole("button", { name: "Reply", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Thread", exact: true });
    const thread = sheet.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await expect(thread).toHaveAttribute("aria-busy", "false");
    const reply = app.append(
      "primary",
      "alpha",
      "Long expanded reply\n".repeat(80),
      true,
      false,
      rootId,
    );
    await expect(
      thread.locator(`[data-message-id="${reply.id}"]`),
    ).toBeAttached();
    await expect(thread).toHaveAttribute("aria-busy", "false");
    await expect
      .poll(() =>
        thread.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    // The channel follows its latest message through its own re-measures, so
    // a scroll while it still moves is not the reader's.
    await virtuaIdle(page, channel);
    // Establish the geometry under test independently of native wheel inertia.
    for (const scroller of [channel, thread]) {
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(scroller).toHaveAttribute("data-jump-visible", "true");
    }
    await expect(thread.locator("[data-jump-to-latest]")).toBeVisible();
    await expect(backgroundJump).toBeHidden();
    await page.screenshot({
      path: test.info().outputPath("thread-scroll-edge-dark.png"),
    });
    await sheet
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(sheet).toBeHidden();
    // Closing restores focus to the opener near the bottom. Read above it again
    // to prove the background control is available once the sheet is gone.
    await channel.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(backgroundJump).toBeVisible();
  });
});

// Windowing needs real layout, scroll anchoring and focus: jsdom cannot prove
// the first visible frame or that virtual rows become reachable again.
// Read up until `row` shows. One long wheel need not reach it: Linux WebKit
// animates a wheel and can end it early when a row measures mid-scroll.
async function readUpTo(page, row, deltaY) {
  await expect(async () => {
    await page.mouse.wheel(0, deltaY);
    await expect(row).toBeInViewport({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

test("long thread sheet windows replies while preserving reading, branches, and drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.append("primary", "alpha", "Windowed thread root", true);
  const replies = Array.from({ length: 80 }, (_, i) =>
    app.append(
      "primary",
      "alpha",
      `Windowed reply ${i}`,
      false,
      false,
      root.id,
    ),
  );
  const nested = app.append(
    "primary",
    "alpha",
    "Nested windowed reply",
    false,
    false,
    root.id,
    replies.at(-1).id,
  );
  app.append(
    "primary",
    "alpha",
    "Another nested windowed reply",
    false,
    false,
    root.id,
    replies.at(-1).id,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await expect(row).toBeVisible();
  await page.evaluate(() => {
    window.firstWindowedFrame = undefined;
    const sample = () => {
      const sheet = document.querySelector("[data-details-sheet-surface]");
      const el = sheet?.querySelector('[aria-label="Thread messages"]');
      if (el && !el.hasAttribute("data-positioning"))
        window.firstWindowedFrame = {
          gap: el.scrollHeight - el.clientHeight - el.scrollTop,
        };
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Thread", exact: true });
  const history = sheet.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(history.locator("[data-thread-window]")).toBeVisible();
  await expect(history).not.toHaveAttribute("data-positioning");
  await expect
    .poll(() => page.evaluate(() => window.firstWindowedFrame))
    .toBeTruthy();
  expect(
    Math.abs((await page.evaluate(() => window.firstWindowedFrame)).gap),
  ).toBeLessThanOrEqual(1);
  await expect
    .poll(() => history.locator("[data-message-id]").count())
    .toBeLessThan(81);
  const last = history.locator(`[data-message-id="${replies.at(-1).id}"]`);
  await expect(last).toBeInViewport();
  // Visible rows can still be settling; the virtualizer blocks input until then.
  await virtuaIdle(page, history);
  await history.getByRole("button", { name: /^View 2 replies/ }).click();
  await expect(
    history.locator(`[data-message-id="${nested.id}"]`),
  ).toBeFocused();
  const editor = sheet.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await editor.fill("Windowed thread draft");
  // The branch just opened can still be measuring; wheel input waits for it.
  // Its replies are a list of their own, so name the window's.
  await expect(history.locator("[data-thread-window] > ol")).toHaveCSS(
    "pointer-events",
    "auto",
  );
  await settle(page, history);
  await history.hover();
  await readUpTo(
    page,
    history.locator(`[data-message-id="${replies[0].id}"]`),
    -10000,
  );
  await expect(
    history.locator(`[data-message-id="${replies[0].id}"]`),
  ).toBeInViewport();
  await history.focus();
  await history.press("End");
  await expect(last).toBeInViewport();
  await expect(
    history.locator(`[data-message-id="${nested.id}"]`),
  ).toBeAttached();
  await expect(editor).toHaveText("Windowed thread draft");
  await sheet
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  await expect(sheet).toHaveCount(0);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    sheet.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toHaveText("Windowed thread draft");
});

// Collapsed activity renders nothing for every grouped update after the
// first, so the window must position against the rows it actually renders.
test("long thread sheet settles when it ends in collapsed activity", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.append("primary", "alpha", "Collapsed thread root", true);
  const post = (content, tags) =>
    app.append(
      "primary",
      "alpha",
      content,
      false,
      false,
      root.id,
      undefined,
      tags,
    );
  const replies = Array.from({ length: 19 }, (_, i) =>
    post(`Collapsed thread reply ${i}`),
  );
  const agents = [["audience", "agents"]];
  post("Agents update one", agents);
  const last = post("Agents update two", agents);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await expect(row).toBeVisible();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Thread", exact: true });
  const history = sheet.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(history.locator("[data-thread-window]")).toBeVisible();
  await expect(history).not.toHaveAttribute("data-positioning");
  const toggle = history.getByRole("button", {
    name: /^Show activity history:/,
  });
  await expect(toggle).toBeInViewport();
  await expect(history.locator(`[data-message-id="${last.id}"]`)).toHaveCount(
    0,
  );
  await expect(
    history.locator(`[data-message-id="${replies.at(-1).id}"]`),
  ).toBeInViewport();
});

// Retained branches are chosen by index, so after compaction an expanded
// branch must keep its own row mounted, not a neighbour's.
test("long thread sheet keeps an expanded branch mounted after collapsed activity", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.append("primary", "alpha", "Retained thread root", true);
  const post = (content, parent, tags) =>
    app.append(
      "primary",
      "alpha",
      content,
      false,
      false,
      root.id,
      parent,
      tags,
    );
  const agents = [["audience", "agents"]];
  for (const n of [1, 2, 3]) post(`Agents update ${n}`, undefined, agents);
  const replies = Array.from({ length: 120 }, (_, i) =>
    post(`Retained thread reply ${i}`),
  );
  const branch = replies.at(-6);
  const nested = post("Retained nested reply", branch.id);
  post("Another retained nested reply", branch.id);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await expect(row).toBeVisible();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Thread", exact: true });
  const history = sheet.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(history.locator("[data-thread-window]")).toBeVisible();
  await expect(history).not.toHaveAttribute("data-positioning");
  // Virtua drops pointer events while the opening scroll settles; a click
  // then lands on the window instead of the branch's button.
  await virtuaIdle(page, history);
  await history
    .locator(`[data-message-id="${branch.id}"]`)
    .locator("xpath=ancestor::*[@data-thread-window-index][1]")
    .getByRole("button", { name: /^View 2 replies/ })
    .click();
  await expect(
    history.locator(`[data-message-id="${nested.id}"]`),
  ).toBeVisible();
  await sheet
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .focus();
  await history.hover();
  await readUpTo(
    page,
    history.locator(`[data-message-id="${replies[0].id}"]`),
    -100000,
  );
  await expect(
    history.locator(`[data-message-id="${replies[0].id}"]`),
  ).toBeInViewport();
  await expect(
    history.locator(`[data-message-id="${nested.id}"]`),
  ).toBeAttached();
});

// Only real layout bounds a panel's scrollport; jsdom reports no overflow.
test("a long GitHub panel over the composer scrolls under the wheel", async ({
  page,
  app,
}) => {
  const target = "https://github.com/block/buzz-app/pull/327";
  const body = Array.from(
    { length: 80 },
    (_, i) => `Paragraph ${i} of the description.`,
  ).join("\n\n");
  await page.route(
    "https://api.github.com/repos/block/buzz-app/pulls/327",
    (route) => route.fulfill({ json: { title: "A PR", state: "open", body } }),
  );
  await page.route(
    /https:\/\/api\.github\.com\/repos\/.*\/(?:comments|reviews)\?/,
    (route) => route.fulfill({ json: [] }),
  );
  await open(page, app);
  app.append("primary", "alpha", target);
  await page.locator(`a[href="${target}"]`).click();
  const sheet = page.locator("[data-details-sheet-surface]");
  await expect(
    sheet.getByText("Paragraph 79 of the description."),
  ).toBeAttached();
  await expect
    .poll(() =>
      sheet.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
  await sheet.getByText("Paragraph 3 of the description.").hover();
  await page.mouse.wheel(0, 800);
  await expect
    .poll(() =>
      sheet.evaluate((element) =>
        [...element.querySelectorAll("*")].some((node) => node.scrollTop > 0),
      ),
    )
    .toBe(true);
});

test.describe("first inline thread", () => {
  test.use({ threadIntro: true });

  // Anchoring each step to the sheet's title and pop-out button needs real
  // layout; jsdom reports every element at the origin.
  test("walks through replying here, then the pop-out button and inline switch", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const row = page
      .getByRole("region", { name: "Channel message history" })
      .locator("[data-message-id]")
      .first();
    await hoverMessage(row);
    await row.getByRole("button", { name: "Reply", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Thread", exact: true });
    await expect(sheet).toBeVisible();
    const first = page.getByRole("dialog", {
      name: "Threads can now open without a tab",
    });
    await expect(first).toBeVisible();
    const title = sheet.locator("header [data-shape='pill']");
    await expect
      .poll(async () => {
        const [card, anchor] = await Promise.all([
          first.boundingBox(),
          title.boundingBox(),
        ]);
        return Math.abs(card.y - (anchor.y + anchor.height + 8)) <= 1;
      })
      .toBe(true);
    await page.screenshot({ path: test.info().outputPath("intro-step-1.png") });

    await first.getByRole("button", { name: "Next" }).click();
    const second = page.getByRole("dialog", { name: "Open in a tab anytime" });
    await expect(second).toBeVisible();
    const popOut = sheet.getByRole("button", { name: "Open as tab" });
    await expect
      .poll(async () => {
        const [card, anchor] = await Promise.all([
          second.boundingBox(),
          popOut.boundingBox(),
        ]);
        return card.y > anchor.y + anchor.height;
      })
      .toBe(true);
    await page.screenshot({ path: test.info().outputPath("intro-step-2.png") });
    await second.getByRole("button", { name: "Got it" }).click();
    await expect(second).toBeHidden();
    await expect(sheet).toBeVisible();
    // Afterwards the button names itself on hover, as before.
    await popOut.hover();
    await expect(
      page.getByRole("tooltip", { name: "Open as tab" }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("intro-done-hover.png"),
    });
  });
});
