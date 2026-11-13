import { test, expect } from "./fixture.mjs";

// A reveal may change its clip, but the underlying reading frame must stay put.
async function expectStableOpening(dialog) {
  await expect(dialog).toBeVisible();
  const frames = await dialog.evaluate(async (element) => {
    const frames = [];
    let request;
    const capture = () => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      frames.push({
        time: performance.now(),
        clip: style.clipPath,
        opacity: style.opacity,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        bottom: box.bottom,
      });
    };
    const tick = () => {
      capture();
      request = requestAnimationFrame(tick);
    };
    tick();
    try {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    } finally {
      cancelAnimationFrame(request);
    }
    capture();
    return frames;
  });
  const settled = frames.at(-1);
  for (const frame of frames)
    for (const coordinate of ["x", "y", "width", "height", "bottom"])
      expect(frame[coordinate]).toBeCloseTo(settled[coordinate], 1);
  return frames;
}

// Browser contract: real page routing, exact target reveal, native focus return,
// and the bottom sheet/composer fitting its host across widths and text sizes.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  enabledPlugins: ["buzz.todos"],
  historyCounts: { alpha: 2, beta: 1 },
});

test("Activity is the landing page and opens a composer sheet over its feed", async ({
  page,
  app,
}, testInfo) => {
  // Enough distinct threads to exercise scrolling behind the floating editor.
  for (let index = 0; index < 8; index++) {
    const root = app.append("primary", "alpha", `Feed topic ${index}`, false);
    app.append(
      "primary",
      "alpha",
      `Feed reply ${index}: a longer update that wraps in the reading column, while keeping the author, channel and time together.`,
      false,
      false,
      root.id,
    );
  }
  await page.goto(app.origin);
  await expect(
    page
      .getByRole("navigation", { name: "Apps", exact: true })
      .getByRole("button", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const appDock = page.getByRole("navigation", {
    name: "Apps",
    exact: true,
  });
  const dockBounds = await appDock.boundingBox();
  const inboxBounds = await inbox.boundingBox();
  expect(dockBounds.x + dockBounds.width).toBeLessThanOrEqual(inboxBounds.x);
  await expect(
    page.getByRole("complementary", { name: "Discover" }),
  ).toHaveCount(0);
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Search Buzz" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Search Buzz" })
    .click();
  const identitySearch = page.getByRole("dialog", {
    name: "Search Buzz",
    exact: true,
  });
  await identitySearch
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill("Alice Fixture");
  await expect(
    identitySearch.getByRole("option", { name: /Alice Fixture/ }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(identitySearch).toHaveCount(0);
  await appDock.getByRole("button", { name: "Open Plugins" }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  const feed = inbox.getByRole("list", { name: "Activity", exact: true });
  const opener = feed
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / });
  await expect(opener).toBeVisible();
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const newMessage = page.getByRole("region", {
    name: "New message",
    exact: true,
  });
  const to = newMessage.getByRole("combobox", { name: "Message recipients" });
  await expect(to).toHaveCount(0);
  await expect(
    newMessage.getByRole("tablist", { name: "Conversation" }),
  ).toHaveCount(0);
  const newEditor = newMessage.getByRole("textbox");
  await expect(newEditor).toBeInViewport();
  await newEditor.fill("A draft from the feed");
  await expect(newEditor).toHaveText("A draft from the feed");
  await expect(
    newMessage.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("buzzfeed-landing.png") });
  const sourceBounds = await newMessage.boundingBox();
  const sourceAnchor = await newMessage.evaluateHandle((element) => {
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (getComputedStyle(parent).position === "absolute") return parent;
    throw new Error("The floating composer needs an anchor");
  });
  const scrollBottom = await feed.evaluate((element) => {
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (getComputedStyle(parent).overflowY === "auto")
        return parent.getBoundingClientRect().bottom;
    throw new Error("Activity needs its own scrollport");
  });
  // The list continues behind the floating editor rather than ending above it.
  expect(scrollBottom).toBeGreaterThan(
    sourceBounds.y + sourceBounds.height / 2,
  );
  const feedBounds = await feed.boundingBox();
  const activityBounds = await inbox.boundingBox();
  expect(feedBounds.width).toBeCloseTo(activityBounds.width, 0);
  const viewFilter = inbox.getByRole("tablist", {
    name: "Activity views",
    exact: true,
  });
  const selectView = async (name) => {
    await viewFilter.getByRole("tab", { name, exact: true }).click();
  };
  expect(feedBounds.x + feedBounds.width / 2).toBeCloseTo(
    activityBounds.x + activityBounds.width / 2,
    0,
  );
  expect(sourceBounds.x + sourceBounds.width / 2).toBeCloseTo(
    feedBounds.x + feedBounds.width / 2,
    0,
  );
  const rowControl = feed.locator("[data-conversation-row]").first();
  await expect(rowControl).toBeVisible();
  const rowContentLeft = await rowControl.evaluate(
    (element) =>
      element.getBoundingClientRect().left +
      Number.parseFloat(getComputedStyle(element).paddingInlineStart),
  );
  const allFilter = await viewFilter
    .getByRole("tab", { name: "All", exact: true })
    .boundingBox();
  expect(allFilter.x).toBeCloseTo(rowContentLeft, 0);
  const viewBounds = await viewFilter.boundingBox();
  expect(viewBounds.y + viewBounds.height).toBeLessThanOrEqual(feedBounds.y);
  const filterBounds = await inbox
    .getByRole("button", { name: "From anyone", exact: true })
    .boundingBox();
  const headingBounds = await inbox
    .getByRole("heading", { level: 2, name: /^Activity/ })
    .boundingBox();
  expect(filterBounds.x).toBeGreaterThan(headingBounds.x + headingBounds.width);
  expect(filterBounds.y).toBeLessThan(headingBounds.y + headingBounds.height);
  await expect(
    inbox.getByRole("heading", { level: 2, name: /^Activity/ }),
  ).toBeVisible();
  await feed.evaluate((element) => {
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (getComputedStyle(parent).overflowY === "auto") {
        parent.scrollTop = parent.scrollHeight;
        return;
      }
  });
  const lastRow = feed.getByRole("listitem").last();
  await expect(lastRow).toBeInViewport();
  const lastBounds = await lastRow.boundingBox();
  expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(sourceBounds.y);
  await opener.scrollIntoViewIfNeeded();
  await feed.getByRole("button", { name: /^Open Alice Fixture in DM/ }).click();
  const dm = page.getByRole("dialog", { name: "Alice Fixture", exact: true });
  const dmFrames = await expectStableOpening(dm);
  await testInfo.attach("dm-reveal-frames", {
    body: JSON.stringify(dmFrames),
    contentType: "application/json",
  });
  await page.screenshot({
    path: testInfo.outputPath("buzzfeed-dm-header.png"),
  });
  const closeBounds = await dm
    .getByRole("button", { name: "Close", exact: true })
    .boundingBox();
  const actions = dm.getByRole("button", {
    name: "Conversation actions",
    exact: true,
  });
  const actionsBounds = await actions.boundingBox();
  expect(closeBounds.x).toBeLessThan(actionsBounds.x);
  await actions.click();
  await page.screenshot({ path: testInfo.outputPath("buzzfeed-actions.png") });
  await page
    .getByRole("button", { name: "Toggle channel todos", exact: true })
    .click();
  const todos = page.getByRole("dialog", { name: "Todos", exact: true });
  await expect(todos).toBeVisible();
  await todos.getByRole("button", { name: "Close", exact: true }).click();
  await expect(todos).toHaveCount(0);
  await expect(dm).toBeVisible();
  await expect(actions).toBeFocused();
  await dm.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dm).toHaveCount(0);
  await opener.click();
  const sheet = page.getByRole("dialog", { name: "Alpha", exact: true });
  await expect(sheet).toBeVisible();
  const openingBounds = await sheet.boundingBox();
  expect(openingBounds.x).toBeCloseTo(sourceBounds.x, 1);
  expect(openingBounds.x + openingBounds.width).toBeCloseTo(
    sourceBounds.x + sourceBounds.width,
    1,
  );
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 1");
  await expect(sheet.locator(`[data-message-id="${root.id}"]`)).toBeVisible();
  await expect(
    sheet.getByText("Unread reply 1", { exact: true }),
  ).toBeInViewport();
  await expect(page.getByRole("tablist", { name: "Panel tabs" })).toHaveCount(
    0,
  );
  const composer = sheet.getByRole("textbox");
  await expect(composer).toBeVisible();
  // Wait for actual surface motion to finish before inspecting its settled box.
  await sheet.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  for (const [mode, width, enlarged] of [
    ["light", 1440, false],
    ["dark", 1440, false],
    ["dark", 480, false],
    ["light", 480, true],
  ]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((large) => {
      document.documentElement.style.fontSize = large ? "125%" : "";
    }, enlarged);
    await expect(composer).toBeInViewport();
    await expect(
      sheet.getByRole("button", { name: "Close", exact: true }),
    ).toBeInViewport();
    expect(
      await sheet.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const bounds = await sheet.boundingBox();
    // The modal sheet makes the retained feed inert to accessibility queries.
    const hostBounds = await page
      .getByRole("region", {
        name: "Activity",
        exact: true,
        includeHidden: true,
      })
      .boundingBox();
    if (width > 1000) {
      expect(bounds.x).toBeCloseTo(hostBounds.x, 1);
      expect(bounds.width).toBeCloseTo(hostBounds.width, 1);
    }
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      hostBounds.y + hostBounds.height,
    );
    const clipBounds = await sourceAnchor.evaluate((element) =>
      element.parentElement.getBoundingClientRect().toJSON(),
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(clipBounds.bottom);
    await page.screenshot({
      path: testInfo.outputPath(
        `buzzfeed-${mode}-${width}${enlarged ? "-large" : ""}.png`,
      ),
    });
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    if (width <= 650) {
      await expect(appDock).toBeHidden();
      await page
        .getByRole("button", { name: "Show navigation", exact: true })
        .click();
    }
    await expect(appDock).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Search Buzz", exact: true }),
    ).toBeInViewport();
    await expect(
      appDock.getByRole("button", { name: "Open Plugins", exact: true }),
    ).toBeInViewport();
    await appDock
      .getByRole("button", { name: "Open Plugins", exact: true })
      .click({ trial: true });
    if (width <= 650)
      await page
        .getByRole("button", { name: "Hide navigation", exact: true })
        .click();
    await expect(newEditor).toBeInViewport();
    await expect(viewFilter).toBeInViewport();
    await expect(to).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(
        `buzzfeed-feed-${mode}-${width}${enlarged ? "-large" : ""}.png`,
      ),
    });
    await opener.click();
    await expect(sheet).toBeVisible();
  }
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(feed).toBeVisible();
  await page.goForward();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(`[data-message-id="${root.id}"]`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(feed).toBeVisible();
  await expect(newEditor).toHaveText("A draft from the feed");
  await newEditor.fill("@Alice");
  const originalEditor = await newEditor.elementHandle();
  const expansion = await originalEditor.evaluateHandle((editor) => {
    const frames = [];
    let request;
    const sample = () => {
      frames.push({
        time: performance.now(),
        connected: editor.isConnected,
        ...editor.getBoundingClientRect().toJSON(),
      });
      request = requestAnimationFrame(sample);
    };
    sample();
    return {
      stop() {
        cancelAnimationFrame(request);
        return frames;
      },
    };
  });
  const beforeAddress = await sourceAnchor.evaluate((element) =>
    element.getBoundingClientRect().toJSON(),
  );
  await page.getByRole("option", { name: /Alice Fixture/ }).click();
  await expect(
    page.getByRole("button", { name: "Close new message", exact: true }),
  ).toBeVisible();
  await expect(
    newMessage.getByText("Inbox DM fixture reply", { exact: true }),
  ).toBeVisible();
  await expect(newEditor).toBeFocused();
  expect(
    await newEditor.evaluate(
      (editor, original) => editor === original,
      originalEditor,
    ),
  ).toBe(true);
  const afterAddress = await sourceAnchor.evaluate((element) =>
    element.getBoundingClientRect().toJSON(),
  );
  expect(afterAddress.height).toBeCloseTo(beforeAddress.height, 1);
  expect(afterAddress.y).toBeCloseTo(beforeAddress.y, 1);
  await expectStableOpening(
    page.getByRole("dialog", { name: "New message", exact: true }),
  );
  const expansionFrames = await expansion.evaluate((recording) =>
    recording.stop(),
  );
  await expansion.dispose();
  await testInfo.attach("new-dm-editor-frames", {
    body: JSON.stringify(expansionFrames),
    contentType: "application/json",
  });
  expect(expansionFrames.every((frame) => frame.connected)).toBe(true);
  await page.keyboard.type("hello");
  const typed = await newEditor.textContent();
  expect(typed.indexOf("Alice")).toBeLessThan(typed.indexOf("hello"));
  await page.screenshot({
    path: testInfo.outputPath("buzzfeed-inline-new-message.png"),
  });
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Close new message", exact: true }),
  ).toHaveCount(0);
  await page.goForward();
  await expect(
    newMessage.getByText("Inbox DM fixture reply", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close new message", exact: true })
    .click();
  await expect(newEditor).toBeFocused();
  await newEditor.fill("");
  for (const [view, empty] of [
    ["Direct", undefined],
    ["Working", "No agent is working right now"],
    ["Waiting", "Nothing is waiting on you"],
  ]) {
    await selectView(view);
    if (empty)
      await expect(inbox.getByText(empty, { exact: true })).toBeVisible();
    else
      await expect(
        inbox.getByRole("list", { name: "Conversations", exact: true }),
      ).toBeVisible();
    if (view === "Direct")
      await page.screenshot({
        path: testInfo.outputPath("buzzfeed-direct-feed.png"),
      });
  }
  await selectView("Channels");
  await expect(inbox.locator('[data-activity-row="alpha"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("buzzfeed-channels.png") });
  await selectView("All");
  await opener.click();
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole("button", { name: "Conversation actions", exact: true })
    .click();
  await page.getByRole("button", { name: "Open in Team", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.goBack();
  await expect(feed).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await opener.click();
  await expect(sheet).toBeVisible();
  app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
    true,
    false,
    root.id,
  );
  await sheet.getByRole("link", { name: "Open Beta", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.goBack();
  await expect(feed).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  const dock = page.getByRole("navigation", { name: "Apps", exact: true });
  await dock.getByRole("button", { name: "Open Team", exact: true }).click();
  await expect(
    dock.getByRole("button", { name: "Open Team", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await dock.getByRole("button", { name: "Activity", exact: true }).click();
  await opener.click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/channelId/);
  await page.goBack();
  await expect(
    dock.getByRole("button", { name: "Open Team", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

// Browser boundary: a viewport scrim must paint above the rail/header while the
// anchored sheet keeps its composer geometry, focus and outside-dismissal guard.
test("Activity sheets use a light window-wide scrim above the rail and header", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Team", exact: true }),
  ).toBeVisible();
  await rail.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const openDm = activity.getByRole("button", {
    name: /^Open Alice Fixture in DM/,
  });
  await expect(openDm).toBeVisible();
  const composer = activity.getByRole("textbox");
  const anchor = await composer.boundingBox();
  await openDm.click();
  const dialog = page.getByRole("dialog", {
    name: "Alice Fixture",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  const backdrop = page.locator('.buzz-dialog-backdrop[data-tone="subtle"]');
  await expect(backdrop).toBeVisible();
  const viewport = page.viewportSize();
  const bounds = await backdrop.boundingBox();
  expect(bounds).toEqual({
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  });
  for (const [x, y] of [
    [30, 20],
    [100, 180],
  ]) {
    expect(
      await page.evaluate(
        ([left, top]) =>
          document
            .elementFromPoint(left, top)
            ?.classList.contains("buzz-dialog-backdrop"),
        [x, y],
      ),
    ).toBe(true);
  }
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  const sheet = await dialog.boundingBox();
  expect(sheet.x).toBeLessThanOrEqual(anchor.x);
  expect(sheet.x + sheet.width).toBeGreaterThanOrEqual(anchor.x + anchor.width);
  await expect(dialog.getByRole("textbox")).toBeInViewport();
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.screenshot({
      path: testInfo.outputPath(`window-scrim-${mode}.png`),
    });
  }
  await page.mouse.click(100, 180);
  await expect(dialog).toHaveCount(0);
  await expect(activity).toBeVisible();
  await expect(openDm).toBeFocused();
  await page.goBack();
  await expect(
    page.getByRole("region", { name: "Team", exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
