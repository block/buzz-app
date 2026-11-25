import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { readJournal, releasing } from "./reading.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
const conversations = (inbox) =>
  inbox.getByRole("region", { name: /^Conversation in / });
const sideTabs = (inbox) =>
  inbox.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab");
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  agentPeers: true,
  inboxSoloAgent: true,
  pluginFixtures: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Review room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  screenshot: "off",
});

const showTab = (inbox, name) =>
  inbox
    .getByRole("tablist", { name: "Show", exact: true })
    .getByRole("tab", { name, exact: true });
const unreadSwitch = (inbox) =>
  inbox.getByRole("switch", { name: "Unread", exact: true });
const chooseShow = (inbox, name) => showTab(inbox, name).click();

const markedNotice = (page) =>
  page.getByRole("dialog", { name: "Marked as read", exact: true });
const toggleUnreadOnly = (inbox) => unreadSwitch(inbox).click();
// Typing in a just-mounted composer's first instant can be dropped on the
// unchanged base too, which these tests do not cover: retype until it lands.
const typeDraft = (editor, text) =>
  expect(async () => {
    await editor.fill(text);
    await expect(editor).toHaveText(text, { timeout: 1000 });
  }).toPass();

test("Activity filter choices combine, persist, and hold menu focus through row updates", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  const unread = unreadSwitch(inbox);

  await expect(unread).toHaveAttribute("aria-checked", "false");
  await expect(rows).toHaveCount(1);
  // The unread dot is the row's ✓: hover turns the dot into the check, in the
  // dot's place, and the date stays.
  const check = rows.getByRole("button", { name: /^Mark as read / });
  const dot = rows.getByRole("img", { name: "Unread" });
  const date = rows.locator("[data-inbox-date]");
  await page.mouse.move(0, 0);
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "0");
  await expect(dot).toHaveCSS("opacity", "1");
  const center = async (locator) => {
    const { x, y, width, height } = await locator.boundingBox();
    return { x: x + width / 2, y: y + height / 2 };
  };
  const [checkCenter, dotCenter] = [await center(check), await center(dot)];
  expect(Math.abs(checkCenter.x - dotCenter.x)).toBeLessThan(1);
  expect(Math.abs(checkCenter.y - dotCenter.y)).toBeLessThan(1);
  // The check's hover fill clears the date.
  const [checkBox, dateBox] = [
    await check.boundingBox(),
    await date.boundingBox(),
  ];
  expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(checkBox.x);
  await rows.hover();
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "1");
  await expect(dot).toHaveCSS("opacity", "0");
  await expect(date).toHaveCSS("opacity", "1");

  await chooseShow(inbox, "Mentions");
  await toggleUnreadOnly(inbox);
  await expect(showTab(inbox, "Mentions")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(unread).toHaveAttribute("aria-checked", "true");
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  // An unread row offers only Mark as read.
  await expect(page.getByRole("menuitem")).toHaveText(["Mark as read"]);
  await page
    .getByRole("menuitem", { name: "Mark as read", exact: true })
    .click();
  // Under Unread the read row leaves; a narrowed view offers Clear filters.
  await expect(rows).toHaveCount(0);
  await expect(markedNotice(page)).toBeVisible();
  await expect(
    inbox.getByText("No unread activity in this view", { exact: true }),
  ).toBeVisible();
  await expect(
    inbox.getByRole("button", { name: "Clear filters", exact: true }),
  ).toBeVisible();
  await toggleUnreadOnly(inbox);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // A read row shows its date and no ✓.
  await expect(
    rows.getByRole("button", { name: /^Mark as read / }),
  ).toHaveCount(0);
  await expect(unread).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await openPage(page, "Activity");
  await expect(rows).toHaveCount(1);
  await expect(showTab(inbox, "Mentions")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(unread).toHaveAttribute("aria-checked", "false");
  await expect(conversations(inbox)).toHaveCount(0);
  // Keep the focused Unread switch while relay activity updates rows.
  await unread.focus();
  app.append(
    "primary",
    channel,
    "Another review request",
    true,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(1);
  await expect(unread).toBeFocused();
  await page.keyboard.press("Space");
  await expect(unread).toHaveAttribute("aria-checked", "true");
  await expect(unread).toBeFocused();
});

test("the toolbar keeps the who-tabs and quick filters on one row when wide and inside the toolbar when narrower", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const groups = inbox.getByRole("tablist", { name: "Activity groups" });
  const show = inbox.getByRole("tablist", { name: "Show", exact: true });
  const unread = unreadSwitch(inbox);
  await expect(
    inbox
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  expect(
    await groups
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.title)),
  ).toEqual(["All", "My team", "Others"]);
  await expect(show.getByRole("tab")).toHaveText([
    "All",
    "Threads",
    "Mentions",
    "Reactions",
  ]);
  await expect(unread).toBeVisible();
  const layout = () =>
    inbox.evaluate((root) => {
      const toolbar = root.querySelector(
        'header:has([role="tablist"][aria-label="Activity groups"])',
      );
      const box = (element) => element.getBoundingClientRect().toJSON();
      const style = getComputedStyle(toolbar);
      return {
        pane: toolbar.parentElement.getBoundingClientRect().width,
        toolbar: box(toolbar),
        inset: parseFloat(style.paddingInlineEnd),
        controls: [
          '[role="tablist"][aria-label="Activity groups"]',
          '[role="tablist"][aria-label="Show"]',
          '[role="switch"]',
        ].map((selector) => box(toolbar.querySelector(selector))),
      };
    });
  const middle = (box) => box.top + box.height / 2;
  const wide = await layout();
  // Wide: the tabs, then Show and Unread after them, on one row inside the
  // toolbar's inset.
  const [tabs, kinds, unreadBox] = wide.controls;
  expect(Math.abs(middle(tabs) - middle(kinds))).toBeLessThan(2);
  expect(Math.abs(middle(kinds) - middle(unreadBox))).toBeLessThan(2);
  expect(kinds.left).toBeGreaterThanOrEqual(tabs.right);
  expect(unreadBox.left).toBeGreaterThanOrEqual(kinds.right);
  expect(
    wide.toolbar.right - wide.inset - unreadBox.right,
  ).toBeGreaterThanOrEqual(0);
  // Size the list pane to 540px: the sidebar keeps its width as the window narrows.
  await page.setViewportSize({
    width: Math.round(1280 - (wide.pane - 540)),
    height: 720,
  });
  await expect.poll(async () => Math.round((await layout()).pane)).toBe(540);
  // Narrower, the quick filters may wrap to their own line, but every control
  // stays inside the toolbar and none overlap.
  for (const width of [null, 420, 390, 280]) {
    if (width) await page.setViewportSize({ width, height: 720 });
    await expect(show).toBeVisible();
    await expect(unread).toBeVisible();
    const narrow = await layout();
    narrow.controls.forEach((control, index) => {
      expect(control.left).toBeGreaterThanOrEqual(narrow.toolbar.left);
      expect(control.right).toBeLessThanOrEqual(narrow.toolbar.right);
      expect(control.bottom).toBeLessThanOrEqual(narrow.toolbar.bottom);
      for (const other of narrow.controls.slice(index + 1))
        expect(
          control.right <= other.left ||
            other.right <= control.left ||
            control.bottom <= other.top ||
            other.bottom <= control.top,
        ).toBe(true);
    });
  }
});

test("All caught up: Undo returns the row unread, and Show all turns Unread off", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await toggleUnreadOnly(inbox);
  await expect(rows).toHaveCount(1);
  await rows.hover();
  await rows.getByRole("button", { name: /^Mark as read / }).click();
  await expect(rows).toHaveCount(0);
  await expect(inbox.getByText("All caught up", { exact: true })).toBeVisible();
  await expect(
    inbox.getByText("New replies, mentions and DMs show up here.", {
      exact: true,
    }),
  ).toBeVisible();
  await markedNotice(page)
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  // Undo returns it unread on this device, so Unread shows it again.
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(list).toHaveAttribute("aria-busy", "false");
  await rows.hover();
  await rows.getByRole("button", { name: /^Mark as read / }).click();
  await expect(rows).toHaveCount(0);
  await inbox.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(unreadSwitch(inbox)).toHaveAttribute("aria-checked", "false");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(unreadSwitch(inbox)).toBeFocused();
});

// Browser coverage proves Activity/thread/composer wiring: sending leaves both open.
test("Activity sending keeps the conversation and its row open", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  await expect(
    inbox.getByText("Checking recent activity…", { exact: true }),
  ).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = conversations(inbox);
  const editor = detail.getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await expect(
    inbox.getByRole("list", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await typeDraft(editor, "Keep this conversation");
  await detail.getByRole("button", { name: "Send message" }).click();
  await expect(editor).toHaveText("");
  await expect(
    detail.getByText("Keep this conversation", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(editor).toBeVisible();
  await expect(sideTabs(inbox)).toHaveCount(1);
});

// Browser-only: a row menu beside a live rich editor must not replace it, and
// Undo must restore the row's unread mark. Focus matrices live in InboxPage.test.tsx.
test("under Unread, a neighbor's menu Mark as read keeps the open draft and Undo restores it", async ({
  page,
  app,
}) => {
  const neighbor = app.append(
    "primary",
    channel,
    "Unread neighbor",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(rows).toHaveCount(2);
  await thread.getByRole("button", { name: /^Open / }).click();
  const editor = conversations(inbox).getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    conversations(inbox).locator(
      `[data-message-id="${app.inboxWindow.root.id}"]`,
    ),
  ).toBeVisible();
  await expect(list).toHaveAttribute("aria-busy", "false");
  await typeDraft(editor, "Keep the open draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  // The open conversation is read now, but stays listed under Unread.
  await toggleUnreadOnly(inbox);
  await expect(rows).toHaveCount(2);
  await expect(thread).toHaveAttribute("data-selected", "true");
  await expect(next.getByRole("img", { name: "Unread" })).toBeVisible();
  await next.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Mark as read", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect
    .poll(
      async () =>
        (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
    )
    .toBe(neighbor.created_at);
  // Focus the menu held moves to the remaining row; the open tab stays.
  await expect(thread.getByRole("button", { name: /^Open / })).toBeFocused();
  await expect(sideTabs(inbox)).toHaveCount(1);
  await expect(editor).toHaveText("Keep the open draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
  await markedNotice(page)
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(rows).toHaveCount(2);
  await expect(next.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(next).not.toHaveAttribute("data-selected", "true");
  await expect(editor).toHaveText("Keep the open draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
});

// Browser-only: the row ✓ beside a live rich editor reads that row in place.
test("with Unread off, an unselected row's ✓ reads it in place and preserves the open editor", async ({
  page,
  app,
}) => {
  const neighbor = app.append(
    "primary",
    channel,
    "Unread neighbor",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(rows).toHaveCount(2);
  await thread.getByRole("button", { name: /^Open / }).click();
  const target = conversations(inbox).locator(
    `[data-message-id="${app.inboxWindow.replies[0].id}"]`,
  );
  await releasing(app, () => expect(target).toBeInViewport({ timeout: 100 }));
  // Finish entry reveal and its next-frame acknowledgement before taking the
  // editor/row-focus baseline; list aria-busy does not cover reader positioning.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const editor = conversations(inbox).getByRole("textbox");
  await typeDraft(editor, "Keep the unselected draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  await expect(list).toHaveAttribute("aria-busy", "false");
  // The open conversation is read, so only the neighbor offers a ✓.
  await expect(
    thread.getByRole("button", { name: /^Mark as read / }),
  ).toHaveCount(0);
  await next.getByRole("button", { name: /^Mark as read / }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
    )
    .toBe(neighbor.created_at);
  await expect(rows).toHaveCount(2);
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(next.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(
    next.getByRole("button", { name: /^Mark as read / }),
  ).toHaveCount(0);
  // The ✓ goes with the unread mark; its focus stays on the row.
  await expect(next.getByRole("button", { name: /^Open / })).toBeFocused();
  await expect(next).not.toHaveAttribute("data-selected", "true");
  await expect(thread).toHaveAttribute("data-selected", "true");
  await expect(sideTabs(inbox)).toHaveCount(1);
  await expect(markedNotice(page)).toHaveCount(0);
  await expect(editor).toHaveText("Keep the unselected draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
});

test("incoming replies and mentions update the open conversation without replacing its draft", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = conversations(inbox);
  const editor = detail.getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await expect(
    inbox.getByRole("list", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await typeDraft(editor, "Unsent mention retention draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-composer";
  });
  const seed = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", channel],
      ["e", app.inboxWindow.root.id, "", "reply"],
    ],
    content: "Current thread context",
  });
  app.histories.get(`primary/${channel}`).push(seed);
  app.relay.publish("primary", seed);
  app.append(
    "primary",
    channel,
    "Ordinary peer reply",
    true,
    false,
    app.inboxWindow.root.id,
  );
  await expect(detail).toContainText("Ordinary peer reply");
  await expect(rows).toHaveCount(1);
  await expect(editor).toHaveText("Unsent mention retention draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-composer",
  );
  // The conversation stays open while the type tabs change.
  await chooseShow(inbox, "Threads");
  await chooseShow(inbox, "Mentions");
  await expect(detail).toHaveCount(1);
  await expect(editor).toHaveText("Unsent mention retention draft");
  app.append(
    "primary",
    channel,
    "Fresh peer explicit mention",
    true,
    false,
    app.inboxWindow.root.id,
    undefined,
    [["p", app.viewer]],
  );
  await expect(detail).toContainText("Fresh peer explicit mention");
  await expect(rows).toHaveCount(1);
  await expect(editor).toHaveText("Unsent mention retention draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-composer",
  );
});

// Browser-only: real same-origin storage events must reconcile two mounted windows.
test("same-account windows reconcile filters without reload", async ({
  page,
  context,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const other = await context.newPage();
  app.watchPageErrors(other);
  try {
    await other.goto(app.origin);
    await openPage(other, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    const sibling = other.getByRole("region", {
      name: "Activity",
      exact: true,
    });
    const rows = inbox
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem");
    const siblingRows = sibling
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
    await chooseShow(inbox, "Mentions");
    await toggleUnreadOnly(inbox);
    await expect(showTab(sibling, "Mentions")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(unreadSwitch(sibling)).toHaveAttribute("aria-checked", "true");
    await toggleUnreadOnly(sibling);
    await expect(unreadSwitch(inbox)).toHaveAttribute("aria-checked", "false");
    await chooseShow(sibling, "All");
    await expect(showTab(inbox, "All")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
  } finally {
    await other.close();
  }
});
