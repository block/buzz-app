import { test, expect } from "./fixture.mjs";
import { conversationList, openPage } from "./navigation.mjs";
import { readJournal } from "./reading.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
const conversations = (page) =>
  page.getByRole("region", { name: /^Conversation in / });
const sideTabs = (page) =>
  page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab");
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  agentPeers: true,
  pluginFixtures: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Review room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  screenshot: "off",
});

const filter = (page) =>
  page.getByRole("button", {
    name: "Filter and sort conversations",
    exact: true,
  });
const filterMenu = (page) =>
  page.getByRole("menu", { name: "Filter and sort conversations" });
// A conversation view tab: All, Threads, Mentions...
async function chooseView(page, name) {
  const tab = page
    .getByRole("tablist", { name: "Conversation view" })
    .getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
// A choice in the filter menu: From, Show or Sort.
async function choose(page, option) {
  await filter(page).click();
  const menu = filterMenu(page);
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: option, exact: true }).click();
  await expect(menu).toHaveCount(0);
}
// The filter menu marks the current choice; it closes again untouched.
async function expectChosen(page, option, chosen = true) {
  await filter(page).click();
  const menu = filterMenu(page);
  await expect(
    menu.getByRole("menuitemradio", { name: option, exact: true }),
  ).toHaveAttribute("aria-checked", String(chosen));
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

const markedNotice = (page) =>
  page.getByRole("dialog", { name: "Marked as read", exact: true });
// Typing in a just-mounted composer's first instant can be dropped on the
// unchanged base too, which these tests do not cover: retype until it lands.
const typeDraft = (editor, text) =>
  expect(async () => {
    await editor.fill(text);
    await expect(editor).toHaveText(text, { timeout: 1000 });
  }).toPass();
const eventRows = (page) =>
  conversationList(page).locator("[data-activity-event]");
const unreadDots = (row) => row.getByRole("img", { name: "Unread" });
// The row's check button waits for hover; the row's date shares its place.
const markRead = (row) => row.getByRole("button", { name: "Mark as read" });

test("Activity filter choices combine, persist, and hold menu focus through row updates", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  await chooseView(page, "Mentions");
  const rows = eventRows(page);
  await expect(rows).toHaveCount(1);
  // The unread row's ✓ waits for hover, where it takes the date's place.
  const check = markRead(rows);
  await page.mouse.move(0, 0);
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "0");
  await rows.hover();
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "1");

  // The thread's author is a person, so Agents leaves it out.
  await choose(page, "Agents");
  await expect(rows).toHaveCount(0);
  await choose(page, "People");
  await expect(rows).toHaveCount(1);
  await choose(page, "Unread only");
  await expect(rows).toHaveCount(1);
  await check.focus();
  await page.keyboard.press("Enter");
  // Under Unread the read row leaves.
  await expect(rows).toHaveCount(0);
  await expect(markedNotice(page)).toBeVisible();
  await expect(
    conversationList(page).getByText("All caught up", { exact: true }),
  ).toBeVisible();
  await expect(
    conversationList(page).getByText("Nothing unread in this view.", {
      exact: true,
    }),
  ).toBeVisible();
  await choose(page, "All conversations");
  await expect(rows).toHaveCount(1);
  await expect(unreadDots(rows)).toHaveCount(0);
  // A read row shows its date and no ✓.
  await expect(markRead(rows)).toHaveCount(0);
  await expectChosen(page, "People");
  await page.reload();
  await expect(rows.first()).toBeVisible();
  await expectChosen(page, "People");
  await expectChosen(page, "All conversations");
  await chooseView(page, "Mentions");
  await expect(rows).toHaveCount(1);
  // Keep the focused From choice while relay activity updates rows.
  await filter(page).focus();
  await page.keyboard.press("Enter");
  const menu = filterMenu(page);
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Anyone",
    "People",
    "Agents",
    "All conversations",
    "Unread only",
    "Recent activity",
    "A–Z",
  ]);
  const people = menu.getByRole("menuitemradio", {
    name: "People",
    exact: true,
  });
  // Keys before the opened menu takes focus would go to the trigger.
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('[role="menu"]')),
    )
    .toBe(true);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(people).toBeFocused();
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
  await expect(unreadDots(conversationList(page))).toHaveCount(1);
  await expect(people).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(filter(page)).toBeFocused();
  await expectChosen(page, "People");
});

test("the view tabs and filter button stay inside the list header as the window narrows", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const list = conversationList(page);
  await expect(list.getByRole("listitem").first()).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Conversation view" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "All",
    "Threads",
    "DMs",
    "Mentions",
    "Channels",
    "Reactions",
  ]);
  // The strip scrolls its tabs inside the header, with the filter button first.
  const header = tabs.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " buzz-tabs ")][1]',
  );
  for (const width of [1280, 760, 420, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(filter(page)).toBeInViewport({ ratio: 1 });
    expect(
      await header.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const bounds = await header.boundingBox();
    const box = await filter(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
});

test("All caught up: Undo returns the row unread, and All conversations shows it again", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  await chooseView(page, "Mentions");
  const rows = eventRows(page);
  await expect(rows).toHaveCount(1);
  await choose(page, "Unread only");
  await expect(rows).toHaveCount(1);
  await rows.hover();
  await markRead(rows).click();
  await expect(rows).toHaveCount(0);
  const list = conversationList(page);
  await expect(list.getByText("All caught up", { exact: true })).toBeVisible();
  await expect(
    list.getByText("Nothing unread in this view.", { exact: true }),
  ).toBeVisible();
  await markedNotice(page)
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  // Undo returns it unread on this device, so Unread shows it again.
  await expect(rows).toHaveCount(1);
  await expect(unreadDots(rows)).toBeVisible();
  await rows.hover();
  await markRead(rows).click();
  await expect(rows).toHaveCount(0);
  await choose(page, "All conversations");
  await expectChosen(page, "All conversations");
  await expect(rows).toHaveCount(1);
  await expect(unreadDots(rows)).toHaveCount(0);
});

// Browser coverage proves list/thread/composer wiring: sending leaves both open.
test("Activity sending keeps the conversation and its row open", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const rows = eventRows(page);
  await expect(rows).toHaveCount(1);
  await rows.locator("[data-conversation-row]").click();
  const detail = conversations(page);
  const editor = detail.getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`).last(),
  ).toBeVisible();
  await typeDraft(editor, "Keep this conversation");
  await detail.getByRole("button", { name: "Send message" }).click();
  await expect(editor).toHaveText("");
  await expect(
    detail.getByText("Keep this conversation", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(editor).toBeVisible();
  await expect(sideTabs(page)).toHaveCount(1);
});

// Browser-only: marking a neighbor read beside a live rich editor must not
// replace it, and Undo must restore the row's unread mark.
test("under Unread, a neighbor's ✓ keeps the open draft and Undo restores it", async ({
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
  const rows = eventRows(page);
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(thread).toHaveCount(1);
  await thread.locator("[data-conversation-row]").click();
  const editor = conversations(page).getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    conversations(page)
      .locator(`[data-message-id="${app.inboxWindow.root.id}"]`)
      .last(),
  ).toBeVisible();
  await typeDraft(editor, "Keep the open draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  // The neighbor is a mention: Mentions lists it beside the open thread.
  await chooseView(page, "Mentions");
  await choose(page, "Unread only");
  await expect(unreadDots(next)).toBeVisible();
  await expect(next).toHaveCount(1);
  await next.hover();
  await markRead(next).click();
  await expect(next).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
    )
    .toBe(neighbor.created_at);
  await expect(sideTabs(page)).toHaveCount(1);
  await expect(editor).toHaveText("Keep the open draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
  await markedNotice(page)
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(next).toHaveCount(1);
  await expect(unreadDots(next)).toBeVisible();
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
  const rows = eventRows(page);
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(thread).toHaveCount(1);
  await thread.locator("[data-conversation-row]").click();
  const target = conversations(page).locator(
    `[data-message-id="${app.inboxWindow.replies[0].id}"]`,
  );
  await expect(target).toBeInViewport();
  // Finish entry reveal and its next-frame acknowledgement before taking the
  // editor/row-focus baseline; the reader positions after the list settles.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const editor = conversations(page).getByRole("textbox");
  await typeDraft(editor, "Keep the unselected draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  // The open conversation is read, so only the neighbor offers a ✓.
  await expect(markRead(thread)).toHaveCount(0);
  // The neighbor is a mention: Mentions lists it beside the open thread.
  await chooseView(page, "Mentions");
  await markRead(next).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
    )
    .toBe(neighbor.created_at);
  await expect(next).toHaveCount(1);
  await expect(unreadDots(next)).toHaveCount(0);
  await expect(markRead(next)).toHaveCount(0);
  await expect(next.locator("[data-conversation-row]")).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(sideTabs(page)).toHaveCount(1);
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
  const rows = eventRows(page);
  await expect(rows).toHaveCount(1);
  await rows.locator("[data-conversation-row]").click();
  const detail = conversations(page);
  const editor = detail.getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`).last(),
  ).toBeVisible();
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
  // The conversation stays open while the view tabs change.
  await chooseView(page, "Threads");
  await chooseView(page, "Mentions");
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
    const rows = eventRows(page);
    const siblingRows = eventRows(other);
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
    await chooseView(page, "Mentions");
    await choose(page, "People");
    await choose(page, "Unread only");
    await expectChosen(other, "People");
    await expectChosen(other, "Unread only");
    await expect(
      other
        .getByRole("tablist", { name: "Conversation view" })
        .getByRole("tab", { name: "Mentions", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await choose(other, "All conversations");
    await expectChosen(page, "All conversations");
    await choose(other, "Anyone");
    await expectChosen(page, "Anyone");
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
  } finally {
    await other.close();
  }
});
