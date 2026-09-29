import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

// Browser-only contract: actual sidebar/plugin routing -> exact thread target,
// browser history, and responsive/light-dark CSS. Matrices stay in RTL/unread tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("Inbox opens the exact thread, shares read state, and fits the workspace", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const inboxButton = page.getByRole("button", { name: "Inbox", exact: true });
  await inboxButton.click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(
    inbox.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  const chooseFilter = async (label, control = "Activity type") => {
    await inbox.getByRole("combobox", { name: control }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  await expect(inbox.getByRole("tab")).toHaveCount(0);
  await expect(
    inbox.getByRole("combobox", { name: "Activity type" }),
  ).toHaveText("All activity");
  await expect(inbox.getByRole("combobox", { name: "Sender" })).toHaveText(
    "Everyone",
  );
  await expect(inbox.getByText("Activity type")).toHaveClass(/sr-only/);
  await expect(inbox.getByText("Sender", { exact: true })).toHaveClass(
    /sr-only/,
  );
  await expect(
    inbox.getByText(
      /Verified recent conversations|Results are bounded|Feed history reached its result limit/,
    ),
  ).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Mark shown as read" }),
  ).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await chooseFilter("DMs");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Inbox DM fixture reply");
  const dmSource = rows.first().locator("[data-inbox-source]");
  await expect(dmSource).toHaveText("DM · Alice Fixture");
  await expect(dmSource.locator("svg")).toHaveCount(0);
  const dmStyle = await dmSource.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderRadius,
    inset: getComputedStyle(element).paddingInlineStart,
  }));
  await chooseFilter("Mentions");
  await expect(page.getByText("Activity", { exact: true })).toHaveCount(0);
  await chooseFilter("Humans", "Sender");
  await expect(rows).toHaveCount(1);
  await chooseFilter("Agents", "Sender");
  await expect(rows).toHaveCount(0);
  await chooseFilter("Everyone", "Sender");
  await expect(rows).toHaveCount(1);
  const source = rows.first().locator("[data-inbox-source]");
  await expect(source).toHaveText("#Alpha");
  expect(
    await source.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
      inset: getComputedStyle(element).paddingInlineStart,
    })),
  ).toEqual(dmStyle);
  await expect(rows.first()).not.toContainText(/ · (Mention|Thread|Agent)/);
  const hierarchy = await rows.first().evaluate((row) => {
    const sender = row.querySelector("strong");
    const source = row.querySelector("[data-inbox-source]");
    if (!sender || !source) return undefined;
    return {
      senderWeight: Number(getComputedStyle(sender).fontWeight),
      sourceSize: Number.parseFloat(getComputedStyle(source).fontSize),
      senderSize: Number.parseFloat(getComputedStyle(sender).fontSize),
      sourceFill: getComputedStyle(source).backgroundColor,
      rowFill: getComputedStyle(row).backgroundColor,
    };
  });
  expect(hierarchy?.senderWeight).toBeGreaterThanOrEqual(500);
  expect(hierarchy?.sourceSize).toBeLessThan(hierarchy?.senderSize);
  expect(hierarchy?.sourceFill).not.toBe(hierarchy?.rowFill);
  expect(
    await source.evaluate((element) => {
      const preview =
        element.parentElement.parentElement.querySelector("[class*='preview']");
      return (
        preview &&
        element.getBoundingClientRect().top <
          preview.getBoundingClientRect().top
      );
    }),
  ).toBe(true);
  await chooseFilter("Threads");
  await expect(
    inbox.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  await chooseFilter("Mentions");
  await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
  await expect(inbox.getByRole("combobox")).toHaveCount(0);
  await expect(
    inbox.getByRole("checkbox", { name: "Unread only" }),
  ).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(inbox.getByText("Saved drafts on this device.")).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Back to drafts" }),
  ).toHaveCount(0);
  await inbox.getByRole("button", { name: "Back to Inbox" }).click();
  await expect(
    inbox.getByRole("combobox", { name: "Activity type" }),
  ).toHaveText("Mentions");
  await expect(inbox.getByRole("combobox", { name: "Sender" })).toHaveText(
    "Everyone",
  );
  for (const [mode, width] of [
    ["light", 1280],
    ["dark", 760],
    ["dark", 390],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(
      inbox.getByRole("combobox", { name: "Activity type" }),
    ).toBeVisible();
    await expect(inbox.getByRole("combobox", { name: "Sender" })).toBeVisible();
    const toolbar = inbox.locator('[class*="toolbar"]').first();
    const layout = await toolbar.evaluate((element) => {
      const [activity, sender] = element.querySelectorAll('[role="combobox"]');
      const unread = element.querySelector('[role="checkbox"]');
      if (!activity || !sender || !unread) return;
      const a = activity.getBoundingClientRect();
      const s = sender.getBoundingClientRect();
      const u = unread.getBoundingClientRect();
      const t = element.getBoundingClientRect();
      return {
        pairGap: s.left - a.right,
        pairY: s.top - a.top,
        unreadY: u.top - a.top,
        left: t.left,
        right: t.right,
        bottom: t.bottom,
        unreadRight: u.right,
        unreadBottom: u.bottom,
      };
    });
    expect(layout?.pairY).toBe(0);
    expect(layout?.pairGap).toBeCloseTo(8, 0);
    expect(layout?.unreadRight).toBeLessThanOrEqual(layout.right);
    expect(layout?.unreadBottom).toBeLessThanOrEqual(layout.bottom);
    expect(layout?.unreadY).toBeGreaterThanOrEqual(0);
    if (width === 390) expect(layout?.unreadY).toBeGreaterThan(0);
    await expect(
      inbox.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    expect(
      await inbox.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`inbox-${mode}-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const expected = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 1");
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Enter");
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  await expect(detail).toBeVisible();
  const thread = detail.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(
    thread.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  // Main owns the floating message actions/grouping. Hover must not reserve a
  // new row or displace content in this embedded consumer.
  const firstMessage = thread.locator("[data-message-id]").first();
  const beforeHover = await firstMessage.boundingBox();
  await firstMessage.hover();
  await expect
    .poll(async () => (await firstMessage.boundingBox())?.height)
    .toBe(beforeHover?.height);
  const filter = inbox.getByRole("combobox", { name: "Activity type" });
  const heading = detail.getByRole("heading", { name: /^#/ });
  const filterBox = await filter.boundingBox();
  const headingBox = await heading.boundingBox();
  const listBox = await rows.first().boundingBox();
  const threadBox = await detail
    .locator('aside[aria-label="Thread"]')
    .boundingBox();
  expect(
    filterBox && headingBox && Math.abs(filterBox.y - headingBox.y),
  ).toBeLessThan(24);
  expect(
    listBox && threadBox && Math.abs(listBox.y - threadBox.y),
  ).toBeLessThan(3);
  const inset = await detail.evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    threadBottom: element
      .querySelector('aside[aria-label="Thread"]')
      .getBoundingClientRect().bottom,
    padding: Number.parseFloat(getComputedStyle(element).paddingBottom),
  }));
  expect(inset.bottom - inset.threadBottom).toBeCloseTo(inset.padding, 0);
  await expect(inbox.getByText("Back to list")).toHaveCount(0);
  await expect(inbox.getByText("Open in channel")).toHaveCount(0);
  await expect(rows.first().getByRole("img", { name: "Unread" })).toHaveCount(
    0,
  );
  await detail.getByRole("button", { name: "Open in channel" }).click();
  const target = await page.evaluate(
    () => history.state.buzzNavigationV1.entry.target,
  );
  expect(target.threadRootId).toBe(expected.id);
  expect(target.messageId).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(inbox).toBeVisible();
  await chooseFilter("Mentions");
  // Opening reads; right-click and keyboard still expose local unread.
  const row = rows.first();
  await expect(row.getByRole("button", { name: /^Actions for / })).toHaveCount(
    0,
  );
  await expect(
    row.getByRole("button", { name: /Mark as read|Mark unread/ }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Mark as read" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  let action = page.getByRole("menuitem", { name: "Mark unread" });
  await expect(action).toBeVisible();
  await expect(page.getByText("Mark unread on this device only.")).toHaveCount(
    0,
  );
  await action.click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Mark unread" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await inbox.getByRole("checkbox", { name: "Unread only" }).check();
  await expect(rows).toHaveCount(1);
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  action = page.getByRole("menuitem", { name: "Mark unread" });
  await action.click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  // A re-click does not undo the user's mark; a new visit after closing does.
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await detail.getByRole("button", { name: "Close thread" }).click();
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // The DM timeline and composer must occupy one vertical detail column.
  await chooseFilter("DMs");
  await rows
    .first()
    .getByRole("button", { name: /^Open / })
    .click();
  const direct = detail.getByRole("region", { name: "Conversation preview" });
  await expect(
    direct.getByRole("form", { name: /Send a message/ }),
  ).toBeVisible();
  const geometry = await direct.evaluate((element) => {
    const history = element.querySelector(
      '[aria-label="Channel message history"]',
    );
    const composer = element.querySelector("form");
    if (!history || !composer) return;
    return {
      direction: getComputedStyle(element).flexDirection,
      history: history.getBoundingClientRect().toJSON(),
      composer: composer.getBoundingClientRect().toJSON(),
    };
  });
  expect(geometry?.direction).toBe("column");
  expect(geometry?.composer.top).toBeGreaterThanOrEqual(
    geometry.history.bottom,
  );
  expect(geometry?.composer.left).toBeGreaterThanOrEqual(geometry.history.left);
  expect(geometry?.composer.right).toBeLessThanOrEqual(geometry.history.right);
});

// Browser-only: real shared frames, native rich editing, visible history,
// scroll ownership and responsive geometry; lifecycle matrices stay in RTL.
test("Draft and conversation previews share their frame and show real selected context", async ({
  page,
  app,
}, testInfo) => {
  // A bounded, scrollable DM tail exercises bottom positioning. These rows are
  // signed upstream fixture data, not a client cache or live-account mutation.
  for (let index = 0; index < 16; index++)
    app.append("primary", "dm-peer", `Context line ${index}`, false, false);
  const root = app.histories.get("primary/alpha")[0].id;
  const scope = `https://primary.example:${app.viewer}`;
  const canonicalPosition = {
    offset: 0,
    bottom: false,
    anchor: { id: app.histories.get("primary/dm-peer")[0].id, y: 0 },
  };
  await page.addInitScript(
    ({ scope, root, canonicalPosition }) => {
      const save = (key, value) =>
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([scope, key])}`,
          JSON.stringify(value),
        );
      save("draft:dm-peer", { text: "  hello\nBlossom  ", recipients: [] });
      save(`draft:alpha:thread:${root}`, {
        text: "Thread notes",
        recipients: [],
      });
      save("draft:beta", { text: "Channel notes", recipients: [] });
      save("scroll:dm-peer", canonicalPosition);
    },
    { scope, root, canonicalPosition },
  );
  await open(page, app);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const chooseActivity = async (label) => {
    await inbox.getByRole("combobox", { name: "Activity type" }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  await chooseActivity("Mentions");
  await inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("button", { name: /^Open / })
    .click();
  const styleOf = (frame) =>
    frame.evaluate((element) => {
      const style = getComputedStyle(element),
        header = element.querySelector("header");
      return {
        border: style.borderTopWidth,
        color: style.borderTopColor,
        radius: style.borderTopLeftRadius,
        fill: style.backgroundColor,
        headerMinHeight: getComputedStyle(header).minHeight,
      };
    });
  const reference = inbox.getByRole("complementary", { name: "Thread" });
  await expect(
    reference.getByText("Thread root 1", { exact: true }),
  ).toBeVisible();
  const mode = testInfo.project.name === "webkit" ? "dark" : "light";
  await page.evaluate((mode) => {
    document.documentElement.dataset.colorMode = mode;
  }, mode);
  const expectedStyle = await styleOf(reference);
  await reference.getByRole("button", { name: "Close thread" }).click();
  await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
  const draftList = inbox.getByRole("list", { name: "Drafts" });
  await expect(draftList.getByRole("listitem")).toHaveCount(3);
  await expect(inbox.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Back to drafts" }),
  ).toHaveCount(0);
  const detail = inbox.getByRole("region", { name: "Draft detail" });
  const readDraft = (key) =>
    page.evaluate(
      ({ scope, key }) =>
        JSON.parse(
          localStorage.getItem(`buzz-view.v1:${JSON.stringify([scope, key])}`),
        ),
      { scope, key },
    );
  const geometry = async (frame, history) => {
    await expect(frame.getByRole("form")).toHaveCount(1);
    await expect(frame.getByRole("textbox")).toBeVisible();
    const h = await history.boundingBox(),
      c = await frame.getByRole("form").boundingBox();
    expect(h.height).toBeGreaterThan(100);
    expect(c.y).toBeGreaterThanOrEqual(h.y + h.height);
    expect(c.x).toBeGreaterThanOrEqual(h.x);
    expect(c.x + c.width).toBeLessThanOrEqual(h.x + h.width + 1);
    expect(await inbox.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  };
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await draftList
      .getByRole("button", {
        name: "Open draft for Alice Fixture",
        exact: true,
      })
      .click();
    const dm = detail.getByRole("region", { name: "Conversation preview" });
    const history = dm.getByRole("region", { name: "Channel message history" });
    await detail.scrollIntoViewIfNeeded();
    await expect(
      detail.getByRole("heading", { name: "Draft · DM to Alice Fixture" }),
    ).toBeVisible();
    await expect(
      history.getByText("Context line 15", { exact: true }),
    ).toBeInViewport();
    await settle(page, history);
    expect(await styleOf(dm)).toEqual(expectedStyle);
    await geometry(dm, history);
    await expect
      .poll(() =>
        history.evaluate((el) =>
          Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
        ),
      )
      .toBeLessThan(2);
    const input = dm.getByRole("textbox", {
      name: "Message DM with Alice Fixture",
    });
    await expect(input).toContainText("Blossom");
    if (width === 1280) {
      await input.click();
      await input.press("ControlOrMeta+End");
      await input.pressSequentially("!");
      await expect
        .poll(async () => (await readDraft("draft:dm-peer")).text)
        .toBe("  hello\nBlossom  !");
    }
    await page.screenshot({
      path: testInfo.outputPath(`dm-draft-${width}.png`),
    });
    await draftList
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    const channel = detail.getByRole("region", {
      name: "Conversation preview",
    });
    const channelHistory = channel.getByRole("region", {
      name: "Channel message history",
    });
    await detail.scrollIntoViewIfNeeded();
    await expect(
      channelHistory.getByText(/primary beta message 0/),
    ).toBeInViewport();
    await geometry(channel, channelHistory);
    expect(await styleOf(channel)).toEqual(expectedStyle);
    await expect(
      channel.getByRole("textbox", { name: "Message #Beta" }),
    ).toContainText("Channel notes");
    await draftList
      .getByRole("button", { name: "Open draft for #Alpha", exact: true })
      .click();
    const thread = detail.getByRole("complementary", { name: "Thread" });
    const replies = thread.getByRole("region", { name: "Thread messages" });
    await detail.scrollIntoViewIfNeeded();
    await expect(
      replies.getByText("Unread reply 0", { exact: true }),
    ).toBeInViewport();
    // At narrow widths context can exceed the viewport. Bottom opens on the
    // latest returned reply; the root remains reachable in the same scroller.
    await replies
      .getByText("Thread root 0", { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      replies.getByText("Thread root 0", { exact: true }),
    ).toBeInViewport();
    await replies
      .getByText("Unread reply 0", { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      replies.getByText("Unread reply 0", { exact: true }),
    ).toBeInViewport();
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread" }),
    ).toContainText("Thread notes");
    await geometry(thread, replies);
    expect(await styleOf(thread)).toEqual(expectedStyle);
    await expect(
      detail.getByRole("button", { name: "Delete draft…" }),
    ).toHaveAttribute("data-size", "sm");
    await page.screenshot({
      path: testInfo.outputPath(`thread-draft-${width}.png`),
    });
  }
  expect(await readDraft("scroll:dm-peer")).toEqual(canonicalPosition);
  // Synthetic fixture publication exercises the real thread composer/outbox path.
  await detail.getByRole("button", { name: "Send message" }).click();
  await expect
    .poll(() => app.report.publications.filter(({ event }) => event.kind === 9))
    .toHaveLength(1);
  const sent = app.report.publications.find(
    ({ event }) => event.kind === 9,
  ).event;
  expect(sent.content).toBe("Thread notes");
  expect(sent.tags).toContainEqual(["h", "alpha"]);
  expect(sent.tags).toContainEqual(["e", root, "", "reply"]);
  expect((await readDraft("draft:dm-peer")).text).toBe("  hello\nBlossom  !");
});

// Newest-first integration: exact Inbox selection must not be replaced by the
// newest10 page, while a saved root draft opens that actual newest window.
test.describe("signed newest-first Inbox windows", () => {
  const channel = "00000000-0000-0000-0000-000000000123";
  test.use({
    threadUnread: false,
    threadUnreadMentions: false,
    inboxDm: false,
    inboxThreadWindow: true,
    channelIds: ["alpha", channel],
    channelNames: { [channel]: "Window room" },
    historyCounts: { alpha: 1, [channel]: 0 },
  });
  test("reveals an older exact unread anchor and reuses newest-first context for its saved draft", async ({
    page,
    app,
  }) => {
    const { root, replies } = app.inboxWindow;
    const oldest = replies[0],
      newest = replies.at(-1);
    await page.addInitScript(
      ({ viewer, root, channel }) => {
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([`https://primary.example:${viewer}`, `draft:${channel}:thread:${root}`])}`,
          JSON.stringify({ text: "Strict window draft", recipients: [] }),
        );
      },
      { viewer: app.viewer, root: root.id, channel },
    );
    await page.goto(app.origin);
    await openPage(page, "Inbox");

    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Inbox strict reply 0" });
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const target = detail.locator(`[data-message-id="${oldest.id}"]`);
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) =>
            filter.thread_window &&
            filter.limit === 10 &&
            filter["#h"]?.includes(channel),
        ),
      )
      .toBe(true);
    await expect(
      detail.locator(`[data-message-id="${newest.id}"]`),
    ).toBeAttached();
    // The selected anchor survives a later arrival; no fresh click/reveal was requested.
    const arrival = app.reply(root.id);
    await expect(
      detail.getByText("New peer reply", { exact: true }),
    ).toBeAttached();
    await expect(target).toBeInViewport();
    await detail.getByRole("button", { name: "Close thread" }).click();
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("list", { name: "Drafts" })
      .getByRole("button", { name: "Open draft for #Window room" })
      .click();
    const draft = inbox.getByRole("region", { name: "Draft detail" });
    await expect(
      draft.getByRole("textbox", { name: "Reply to thread" }),
    ).toContainText("Strict window draft");
    await expect(
      draft.getByText(newest.content, { exact: true }),
    ).toBeInViewport();
    await expect(draft.getByRole("form")).toHaveCount(1);
    await draft.getByRole("button", { name: "Close thread" }).click();
    await inbox.getByRole("button", { name: "Back to Inbox" }).click();
    const readRow = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Window room" });
    await readRow.getByRole("button", { name: /^Open / }).click();
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Open in channel" }).click();
    const origin = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target,
    );
    expect(origin.channelId).toBe(channel);
    expect(origin.threadRootId).toBe(root.id);
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(inbox).toBeVisible();
    const again = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Window room" });
    await again.getByRole("button", { name: /^Open / }).click();
    const current = detail
      .locator("[data-message-id]")
      .filter({ hasText: "New peer reply" });
    await expect(current).toBeFocused();
    // This removal is signed by the synthetic author and arrives through the
    // actual shared relay stream. It cannot turn a vanished target into a tail reveal.
    app.deleteInboxAnchor(arrival);
    await expect(current).toHaveCount(0);
    await expect(
      detail.getByText("Selected message unavailable."),
    ).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Retry thread" }),
    ).toBeVisible();
  });
});

// Browser boundary: shared top-level head cannot reveal a row it does not contain.
// The exact thread fallback must own focus/scroll and canonical origin, not a mock DOM.
test.describe("DM exact opening outside the head", () => {
  test.use({ inboxDmOldAnchor: true });
  test("retains and focuses the selected old DM instead of silently substituting the newest head", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Inbox old DM anchor" });
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const target = detail.locator(
      `[data-message-id="${app.inboxDmAnchor.id}"]`,
    );
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();
    await expect(
      detail.getByRole("complementary", { name: "Thread" }),
    ).toBeVisible();
    await expect(detail.getByRole("form")).toHaveCount(1);
    await expect(detail.getByRole("button", { name: /^Close / })).toHaveCount(
      1,
    );
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) => filter.top_level && filter["#h"]?.includes("dm-peer"),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        app.report.queries.some(({ filter }) =>
          filter.ids?.includes(app.inboxDmAnchor.id),
        ),
      )
      .toBe(true);
    await detail.getByRole("button", { name: "Open in channel" }).click();
    const origin = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target,
    );
    expect(origin.channelId).toBe("dm-peer");
    expect(origin.messageId).toBe(app.inboxDmAnchor.id);
  });
});

// Session policy must survive bundled Inbox -> shared thread composer -> broker
// publication, including the inferred exact recipient and signed roster preflight.
test.describe("Inbox session reply admission", () => {
  test.use({
    sessionChannels: ["alpha"],
    agentPeers: true,
    inboxSessionAgent: true,
  });
  test("plain session reply notifies the sole member agent through the shared composer", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Unread reply 1" });
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const editor = detail.getByRole("textbox", { name: "Reply to thread" });
    await expect(editor).toBeVisible();
    await expect(
      detail.getByRole("button", {
        name: "Change selected agent",
        exact: true,
      }),
    ).toBeVisible();
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    if (!root) throw new Error("Missing session root fixture");
    const roster = app
      .startupCache()
      .discovery.find(
        (event) =>
          event.kind === 39002 &&
          event.tags.some(([name, value]) => name === "d" && value === "alpha"),
      );
    if (!roster) throw new Error("Missing verified session roster");
    const agents = roster.tags
      .filter(([name, key]) => name === "p" && key !== app.viewer)
      .map(([, key]) => key);
    expect(agents).toHaveLength(1);
    await editor.fill("Inbox session reply without a typed mention");
    await detail.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() =>
        app.report.publications.filter(({ event }) => event?.kind === 9),
      )
      .toHaveLength(1);
    const sent = app.report.publications.find(
      ({ event }) => event?.kind === 9,
    )?.event;
    if (!sent) throw new Error("Missing signed session reply");
    expect(sent.tags).toContainEqual(["h", "alpha"]);
    expect(sent.tags).toContainEqual(["e", root.id, "", "reply"]);
    expect(sent.tags.filter(([name]) => name === "p")).toEqual([
      ["p", agents[0]],
    ]);
  });
});

// Browser-only: CSS hides the list at this width. Real IndexedDB rejection must
// remain visible/retryable while the selected detail is mounted, not just in DOM.
test("narrow selected detail keeps a rejected read save and its captured Retry visible", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    window.inboxReadFailure = { armed: false, failures: 0, saves: 0 };
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        this.name === "partitions" &&
        this.transaction.db.name === "buzz-read-state-v1"
      ) {
        if (
          window.inboxReadFailure.armed &&
          Object.keys(value?.state?.frontiers ?? {}).length
        ) {
          window.inboxReadFailure.failures++;
          throw new Error("Synthetic read storage failure");
        }
        this.transaction.addEventListener(
          "complete",
          () => {
            window.inboxReadFailure.saves++;
          },
          { once: true },
        );
      }
      return put.call(this, value, ...args);
    };
  });
  await open(page, app);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await inbox.getByRole("combobox", { name: "Activity type" }).click();
  await page.getByRole("option", { name: "Mentions", exact: true }).click();
  const row = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .first();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await page.evaluate(() => {
    window.inboxReadFailure.armed = true;
  });
  try {
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(detail).toBeVisible();
    const alert = inbox
      .getByRole("alert")
      .filter({ hasText: "Synthetic read storage failure" });
    await expect(alert).toBeVisible();
    await expect(
      alert.getByRole("button", { name: "Retry inbox" }),
    ).toBeInViewport();
    await expect(
      inbox.getByRole("list", { name: "Inbox conversations" }),
    ).not.toBeVisible();
    const saves = await page.evaluate(() => {
      window.inboxReadFailure.armed = false;
      return window.inboxReadFailure.saves;
    });
    await alert.getByRole("button", { name: "Retry inbox" }).click();
    await expect(alert).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.inboxReadFailure.saves))
      .toBeGreaterThan(saves);
    await expect(detail).toBeVisible();
    await detail
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  } finally {
    await page.evaluate(() => {
      window.inboxReadFailure.armed = false;
    });
  }
});
