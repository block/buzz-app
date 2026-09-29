import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 640, beta: 1 },
});
const button = (page, name) => page.getByRole("button", { name, exact: true });
const state = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot());

test("Buzz channel and message links render, reveal verified targets, and preserve navigation history", async ({
  page,
  app,
}) => {
  app.relay.holdProfiles([app.viewer]);
  await open(page, app);
  const libraryReads = () =>
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/agent-library"),
    ).length;
  // Owner inventory survives the startup roster; previews add no further read.
  await expect.poll(libraryReads).toBe(1);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append(
    "primary",
    "alpha",
    `Open <${href}> or <buzz://channel/beta>.`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  await expect(
    row.getByRole("link", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("link", { name: "#Beta", exact: true }),
  ).toBeVisible();
  await expect(row).not.toContainText("<buzz:");
  const link = row.getByRole("link", { name: "Alpha", exact: true });
  await expect(link).toHaveCSS("text-decoration-line", "none");
  await expect(link).toHaveCSS("color", "rgb(13, 116, 206)");
  await link.hover();
  const preview = page.getByLabel("Message preview", { exact: true });
  await expect(
    preview.getByText("Broadcast reply", { exact: true }),
  ).toBeVisible();
  await expect(preview).toHaveClass(/buzz-preview-card/);
  await expect(preview.getByRole("img")).toHaveClass(/buzz-avatar/);
  await expect(preview).toHaveCSS("font-size", "14px");
  await expect(preview.locator("strong")).not.toBeEmpty();
  await expect(preview.locator("time")).toHaveAttribute(
    "datetime",
    new Date(target.created_at * 1000).toISOString(),
  );
  await expect(preview).toHaveRole("link");
  await expect(preview).toHaveAttribute("href", href);
  // Crossing the trigger-to-card gap must keep the destination clickable.
  await preview.hover();
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("buzz-link-preview.png"),
  });
  await preview.click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.messageId).toBe(target.id);
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await button(page, "Close thread").click();
  await expect(panel).toHaveCount(0);
  await button(page, "Go back").click();
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await button(page, "Go back").click();
  await expect(panel).toHaveCount(0);
  await page.mouse.move(1400, 10);
  await row.getByRole("link", { name: "#Beta", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  // WebKit follows macOS's tab-to-links preference; retain keyboard modality
  // while focusing the specific trigger under test.
  await link.focus();
  await expect(link).toBeFocused();
  expect(
    await link.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  const focusedTrigger = await link.elementHandle();
  app.relay.releaseProfiles();
  await expect(
    row.getByRole("button", {
      name: "View Fixture Reader profile",
      exact: true,
    }),
  ).toBeVisible();
  expect(await focusedTrigger.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(link).toBeFocused();
  await expect(preview).toBeVisible();
  expect(libraryReads()).toBe(1);
  await link.press("Tab");
  await expect(preview).toBeFocused();
  await preview.press("Enter");
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await button(page, "Close thread").click();
  await expect(link).toBeFocused();
  await row.getByRole("link", { name: "#Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("activating a panel from a linked thread retires the navigation-owned thread instead of splitting the rail", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append("primary", "alpha", `Open <${href}>.`);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", { name: "Alpha", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // Open a panel while the linked thread is showing. Navigation still owns the
  // thread target, so it must be retired rather than share the rail slot with
  // the newly activated panel. (The fixture registers a catch-all panel.)
  await row
    .getByRole("button", { name: "View Fixture Reader profile", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Wrong panel", exact: true }),
  ).toBeVisible();
  await expect(thread).toHaveCount(0);
  // Exactly the sidebar plus one panel: the thread does not survive alongside it.
  await expect(page.getByRole("complementary")).toHaveCount(2);
});

// Retained DOM, scroll geometry, focus, and CSS motion need a real browser.
test("thread profile back preserves reading position and draft in the same panel slot", async ({
  page,
  app,
}) => {
  await open(page, app);
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Broadcast reply");
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    messageId: target.id,
    threadRootId: target.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root",
    )?.[1],
    scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  });
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  const history = thread.getByRole("region", { name: "Thread messages" });
  const editor = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await editor.fill("Keep this thread draft");
  const trigger = thread
    .getByRole("button", { name: /^View .+ profile$/ })
    .first();
  await trigger.scrollIntoViewIfNeeded();
  const originalHistory = await history.elementHandle();
  const top = await history.evaluate((el) => el.scrollTop);
  const originalTrigger = await trigger.elementHandle();
  await trigger.click();
  const detail = page.locator("[data-thread-detail]");
  const back = button(page, "Back to thread");
  await expect(back).toBeVisible();
  await expect(back).toBeFocused();
  await expect(thread).toHaveCount(0); // retained but inert, outside the accessibility tree
  expect(await originalHistory.evaluate((el) => el.isConnected)).toBe(true);
  const header = detail.locator("header.panel-header");
  expect((await header.boundingBox()).height).toBe(56);
  const dock = page.locator("[data-panel-dock]");
  expect((await detail.boundingBox()).height).toBeCloseTo(
    (await dock.boundingBox()).height,
    0,
  );
  await expect(detail).toHaveCSS("transition-duration", "0.18s, 0.18s");
  // Nested targets preserve their predecessor, not just the original thread.
  const profileDraft = page.getByRole("textbox", { name: "Panel draft" });
  await profileDraft.fill("Keep profile state");
  const profileInput = await profileDraft.elementHandle();
  await button(page, "Open child detail").click();
  await expect(button(page, "Back to wrong panel")).toBeVisible();
  await expect(profileDraft).toHaveValue("");
  await profileDraft.fill("Keep instance state");
  const instanceInput = await profileDraft.elementHandle();
  await button(page, "Open child detail").click();
  await button(page, "Back to wrong panel").click();
  await expect(profileDraft).toHaveValue("Keep instance state");
  expect(await instanceInput.evaluate((el) => el.isConnected)).toBe(true);

  // Local authorized details use the same header and leave the base DOM intact.
  await button(page, "Open local log").click();
  const log = page.getByRole("region", { name: "Fixture log", exact: true });
  await expect(log).toBeVisible();
  await expect(button(page, "Back to detail")).toBeFocused();
  expect((await log.locator("header.panel-header").boundingBox()).height).toBe(
    56,
  );
  expect((await log.boundingBox()).height).toBeCloseTo(
    (await dock.boundingBox()).height,
    0,
  );
  await expect(
    page.locator("[data-panel-dock] header.panel-header:visible"),
  ).toHaveCount(1);
  await button(page, "Back to detail").press("Escape");
  await expect(button(page, "Open local log")).toBeFocused();
  await expect(profileDraft).toHaveValue("Keep instance state");
  await button(page, "Back to wrong panel").click();
  expect(await profileInput.evaluate((el) => el.isConnected)).toBe(true);
  await expect(profileDraft).toHaveValue("Keep profile state");
  await expect(button(page, "Open child detail")).toBeFocused();
  await back.click();
  await expect(thread).toBeVisible();
  await expect
    .poll(() => originalTrigger.evaluate((el) => document.activeElement === el))
    .toBe(true);
  expect(await originalHistory.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(editor).toHaveText("Keep this thread draft");
  expect((await state(page)).entry.target.messageId).toBe(target.id);

  // Keyboard drill-in and Escape return are immediate and use the same focus path.
  await trigger.press("Enter");
  await expect(back).toBeFocused();
  await expect(detail).toHaveCSS("transition-duration", "0s");
  await back.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(editor).toHaveText("Keep this thread draft");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(detail).toHaveCSS("transition-property", "opacity");
  await expect(detail).toHaveCSS("transform", "none");
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(back).toBeVisible();
    const backBounds = await back.boundingBox();
    const closeBounds = await button(page, "Close channel panel").boundingBox();
    expect(backBounds.x + backBounds.width).toBeLessThan(closeBounds.x);
    expect((await header.boundingBox()).height).toBe(56);
  }
  await button(page, "Close channel panel").click();
  await expect(dock).toHaveCount(0);
});

test("a mixed-case Buzz scheme activates in-app instead of falling through to an external tab", async ({
  page,
  app,
}) => {
  await open(page, app);
  // parseBuzzLink normalizes the scheme via URL, so a BUZZ:// link is a valid
  // internal destination; activation must classify it the same way rather than
  // treating it as an external _blank link.
  const message = app.append(
    "primary",
    "alpha",
    "Jump to <BUZZ://channel/beta>.",
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", { name: "#Beta", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("unavailable messages fail honestly and legacy links still open when Links is disabled", async ({
  page,
  app,
}) => {
  await open(page, app);
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const href = `buzz://message?channel=alpha&id=${target.id}&thread=${"f".repeat(64)}`;
  const message = app.append(
    "primary",
    "alpha",
    `<${href}> <buzz://message?channel=alpha&id=${"0".repeat(64)}>`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  await expect(
    row.getByRole("link", { name: "Alpha", exact: true }).first(),
  ).toBeVisible();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Plugins").click();
  await page
    .getByRole("switch", { name: "Enable Links", exact: true })
    .uncheck();
  await openPage(page, "Messages");
  await row.locator("a").first().click();
  const targetRow = page.locator(`[data-message-id="${target.id}"]`);
  await expect(targetRow).toBeFocused();
  await expect(targetRow).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // The deliberately wrong hint must not select a different root or force a
  // visible root out of the ordinary timeline.
  // Revealing the prior target can still reposition the timeline. Activate the
  // unavailable link by keyboard so this routing check does not click a moving row.
  const unavailable = row.locator("a").nth(1);
  await unavailable.focus();
  await expect(unavailable).toBeFocused();
  await unavailable.press("Enter");
  await expect
    .poll(async () => (await state(page)).entry.target.messageId)
    .toBe("0".repeat(64));
  await expect(button(page, "Retry navigation")).toBeVisible();
  expect((await state(page)).status).toBe("failed");
});
