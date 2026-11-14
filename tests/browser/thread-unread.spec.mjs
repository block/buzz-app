import { pauseClock } from "./clock.mjs";
import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open, virtuaIdle } from "./timeline.mjs";
import {
  holdReadingFocus,
  readJournal,
  releaseReadingFocus,
} from "./reading.mjs";
import {
  channelRow,
  conversationList,
  rail,
  showConversationList,
} from "./navigation.mjs";
import { channelUnread } from "./unread-state.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  // The viewer joined the peer's thread outside the loaded window, so its
  // replies count only after the membership lookup.
  threadUnreadJoined: true,
  historyCounts: { alpha: 20, beta: 1 },
  largeSidebar: true,
  pluginFixtures: true, // Observe the real navigation completion, not reply mount timing.
});
// Team's Threads view lists each thread with activity as its own row, opened on
// its own beside the list; Mentions lists mentions the same way.
const teamView = (page, view) =>
  rail(page).locator(`[data-rail-team-view="${view}"]`).click();
// Team's Channels view, as open() left it; an opened thread may collapse it.
const go = async (page, channelId) => {
  await showConversationList(page);
  await channelRow(page, channelId).click();
};
const threadRow = (page, rootId, channelId = "alpha") =>
  conversationList(page).locator(
    `[data-activity-event="${channelId}:${rootId}"] [data-conversation-row]`,
  );
test.describe("mentioned reply priority", () => {
  test.use({ threadUnreadMentions: true });

  test("a mention and broadcast remain distinguishable in Activity", async ({
    page,
    app,
  }) => {
    await holdReadingFocus(page);
    await open(page, app);
    await expect
      .poll(async () => (await channelUnread(page, "alpha")).threads)
      .toBe(2);
    await teamView(page, "threads");
    const items = conversationList(page).locator(
      '[data-activity-event^="alpha:"]',
    );
    await expect(items).toHaveCount(2);
    for (const item of await items.all())
      await expect(item.locator("[data-conversation-row]")).toHaveAttribute(
        "data-state",
        "unread",
      );
    // Each thread previews its latest relevant reply: the nested mention in
    // the broadcast thread, and the direct mention in the other.
    for (const preview of ["Broadcast descendant", "Unread reply 1"])
      await expect(items.filter({ hasText: preview })).toHaveCount(1);
  });

  test("opening an already-open thread from Activity reads it", async ({
    page,
    app,
  }) => {
    // Reading needs a 300ms dwell (use-reading.ts); hold the clock so the
    // thread cannot earn it while it opens.
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const unread = () =>
      page.evaluate(
        (rootId) =>
          window.fixtureRelay.snapshot().session.unread.snapshot({
            kind: "thread",
            channelId: "alpha",
            rootId,
          }),
        root.id,
      );
    await teamView(page, "threads");
    const item = threadRow(page, root.id);
    await expect(item).toContainText("Unread reply 1");
    await pauseClock(page, 1000);
    await item.click();
    await expect(panel).toBeVisible();
    // The reader is looking elsewhere: the open thread stays unread.
    await page.evaluate(() => document.activeElement?.blur());
    await page.clock.resume();
    expect((await unread()).observedCount).toBeGreaterThan(0);
    await releaseReadingFocus(page);
    const previousAttempt = await page.evaluate(
      () => window.fixtureNavigation.snapshot().attempt.id,
    );
    // Activity opens the thread that is already selected.
    await item.click();
    // The thread is already on screen, so its visibility proves nothing. Wait
    // for the click's own navigation, so a failure below means the thread was
    // opened and still not read, never that the click missed.
    await expect
      .poll(() =>
        page.evaluate((previous) => {
          const { status, attempt } = window.fixtureNavigation.snapshot();
          return { status, freshAttempt: attempt.id !== previous };
        }, previousAttempt),
      )
      .toEqual({ status: "opened", freshAttempt: true });
    try {
      await expect.poll(async () => (await unread()).observedCount).toBe(0);
    } catch (error) {
      // Reading needs focus inside the thread; say where it actually was.
      const focus = await page.evaluate(() => ({
        active:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.tagName,
        inThread: !!document.activeElement?.closest("[data-reading-surface]"),
        windowFocused: document.hasFocus(),
      }));
      throw new Error(
        `The thread opened but stayed unread. Focus: ${JSON.stringify(focus)}`,
        { cause: error },
      );
    }
  });

  test("opening a thread from Activity reads it when its channel's pane was collapsed", async ({
    page,
    app,
  }) => {
    // Hold the clock so the thread cannot be read before Activity opens it.
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const unread = () =>
      page.evaluate(
        (rootId) =>
          window.fixtureRelay.snapshot().session.unread.snapshot({
            kind: "thread",
            channelId: "alpha",
            rootId,
          }),
        root.id,
      );
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(panel).toBeVisible();
    await page.clock.runFor(1000);
    // Collapse Alpha's pane around its selected thread, then leave the channel.
    await page
      .getByRole("button", { name: "Toggle tab pane", exact: true })
      .click();
    await channelRow(page, "beta").click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    expect((await unread()).observedCount).toBeGreaterThan(0);
    await teamView(page, "threads");
    const item = threadRow(page, root.id);
    await expect(item).toContainText("Unread reply 1");
    await releaseReadingFocus(page);
    await item.click();
    await expect(panel).toBeVisible();
    await page.clock.runFor(1000);
    try {
      await expect.poll(async () => (await unread()).observedCount).toBe(0);
    } catch (error) {
      const focus = await page.evaluate(() => ({
        active:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.tagName,
        inThread: !!document.activeElement?.closest("[data-reading-surface]"),
      }));
      throw new Error(
        `The thread opened but stayed unread. Focus: ${JSON.stringify(focus)}`,
        { cause: error },
      );
    }
  });

  test("an Activity reopening leaves focus the person moved meanwhile", async ({
    page,
    app,
  }) => {
    // As above, hold the clock so the thread cannot be read while it opens.
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    // The reopening reveals the thread's latest reply; the person moves on to
    // its reply composer instead.
    const composer = panel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await teamView(page, "threads");
    const item = threadRow(page, root.id);
    await expect(item).toContainText("Unread reply 1");
    await pauseClock(page, 1000);
    await item.click();
    await expect(panel).toBeVisible();
    await page.evaluate(() => document.activeElement?.blur());
    await page.clock.resume();
    await releaseReadingFocus(page);
    const previousAttempt = await page.evaluate(
      () => window.fixtureNavigation.snapshot().attempt.id,
    );
    // Hold the reopening's reads so the person can move focus before the
    // thread receives its request.
    let held = false;
    let release;
    let sawRead;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const read = new Promise((resolve) => {
      sawRead = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (held) {
        sawRead();
        await gate;
      }
      await route.continue().catch(() => {});
    });
    held = true;
    try {
      await item.click();
      await read;
      await composer.click();
      await page.keyboard.type("Still typing");
    } finally {
      held = false;
      release();
    }
    await expect
      .poll(() =>
        page.evaluate((previous) => {
          const { status, attempt } = window.fixtureNavigation.snapshot();
          return { status, freshAttempt: attempt.id !== previous };
        }, previousAttempt),
      )
      .toEqual({ status: "opened", freshAttempt: true });
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText("Still typing");
  });

  test("search's Unread row opens the previewed thread reply with focus, and reading it updates the row", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const unread = () =>
      page.evaluate(() => {
        const { unread } = window.fixtureRelay.snapshot().session;
        return {
          count: unread.snapshot({ kind: "channel", channelId: "alpha" })
            .observedCount,
          items: unread.activity("alpha").items ?? [],
        };
      });
    // Reading the channel leaves Alpha unread only through its threads.
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .focus();
    await expect
      .poll(async () => {
        const { count, items } = await unread();
        return (
          items.length === 2 &&
          items[0].unreadCount + items[1].unreadCount === count
        );
      })
      .toBe(true);
    await channelRow(page, "beta").click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    const [newest, other] = (await unread()).items;
    const dialog = page.getByRole("dialog", { name: "Search Buzz" });
    const row = dialog
      .getByRole("group", { name: "Unread" })
      .getByRole("option")
      .filter({ hasText: /^Alpha/ });
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("combobox", { name: "Search Buzz" }).fill("");
    await expect(row).toContainText(`Alice Fixture: ${newest.preview}`);
    await expect(row).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(
      thread.locator(`[data-message-id="${newest.latestMessageId}"]`),
    ).toBeVisible();
    // The thread takes focus from search, so it reads without another gesture.
    await expect
      .poll(() =>
        page.evaluate(
          () => !!document.activeElement?.closest("[data-reading-surface]"),
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => (await unread()).items.map(({ rootId }) => rootId))
      .toEqual([other.rootId]);
    await showConversationList(page);
    await channelRow(page, "beta").click();
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("combobox", { name: "Search Buzz" }).fill("");
    await expect(row).toContainText(`Alice Fixture: ${other.preview}`);
  });
});

test("thread buttons show observed unread independently, clear only after reading, and expose hover/focus affordance", async ({
  page,
  app,
}, testInfo) => {
  // Reading needs a 300ms dwell (use-reading.ts). An installed clock still
  // flows, so pause it wherever an open surface must not earn that dwell, and
  // run the deadline exactly where the test proves reading.
  await page.clock.install();
  await holdReadingFocus(page);
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const button = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const first = button(roots[0]);
  const other = button(roots[1]);
  const broadcast = button(
    app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Broadcast reply"),
  );
  const dot = (control) =>
    control.locator('span[title^="Observed unread replies"]');
  await expect(first).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(other).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(dot(first)).toBeVisible();
  await expect(dot(other)).toBeVisible();
  await expect(broadcast).toHaveAccessibleName(/Observed unread replies/);
  // The open channel's threads stay unread while its timeline is read.
  await expect
    .poll(async () => (await channelUnread(page, "alpha")).threads)
    .toBe(2);
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  // Marking it unread keeps the mark on this device, its threads included.
  await expect
    .poll(async () => await channelUnread(page, "alpha"))
    .toMatchObject({ manual: "local-only", threads: 2 });
  // The viewer's own thread and the peer thread the viewer joined. Channel
  // evidence never returns the viewer's displaced reply, so only the
  // conversation lookup can make the second thread count.
  expect(
    app.report.queries.some(
      ({ filter }) =>
        filter.authors?.[0] === app.viewer &&
        filter["#e"]?.includes(roots[1].id),
    ),
  ).toBe(true);
  const queries = () =>
    app.report.queries.filter(({ filter }) => filter.depth_limit);
  expect(queries()).toHaveLength(0); // Merely counting threads never fetches them.
  await releaseReadingFocus(page);
  const beforeRect = await first.boundingBox();
  await first.hover();
  const afterRect = await first.boundingBox();
  expect(afterRect).not.toBeNull();
  expect(beforeRect).not.toBeNull();
  expect(afterRect.width).toBe(beforeRect.width);
  expect(afterRect.height).toBe(beforeRect.height);
  await expect(first).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const hover = await first.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, radius: s.borderTopLeftRadius };
  });
  expect(hover.border).toBe("0px");
  expect(hover.radius).not.toBe("0px");
  await first.screenshot({
    path: testInfo.outputPath("thread-button-hover.png"),
  });
  // WebKit's macOS tab policy skips buttons; keyboard input still selects
  // focus-visible modality, then focus the actual control in both engines.
  await page.keyboard.press("Tab");
  await first.focus();
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-style", "solid");
  await expect(first).toHaveCSS("outline-width", "2px");
  await broadcast.focus();
  const previousAttempt = await page.evaluate(
    () => window.fixtureNavigation.snapshot().attempt.id,
  );
  await broadcast.press("Enter");
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(
    panel.getByText("Unread reply 0", { exact: true }),
  ).toBeVisible();
  // Content visibility precedes the navigation's deferred reveal/focus. Finish
  // that owner before testing composer-only dwell; faster reads expose the race.
  await expect
    .poll(() =>
      page.evaluate((previous) => {
        const { status, entry, attempt } = window.fixtureNavigation.snapshot();
        return {
          status,
          messageId: entry.target.messageId,
          freshAttempt: attempt.id !== previous,
        };
      }, previousAttempt),
    )
    .toEqual({
      status: "opened",
      freshAttempt: true,
      messageId: app.histories
        .get("primary/alpha")
        .find((row) => row.content === "Broadcast reply").id,
    });
  const replyComposer = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  // Own-composer dwell acknowledges the visible reply without list focus;
  // the collapsed descendant and sibling thread remain independent.
  const directId = await panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" })
    .getAttribute("data-message-id");
  await replyComposer.focus();
  await page.clock.runFor(300);
  await expect(replyComposer).toBeFocused();
  // The isolated message read is durable on this device and never published.
  await expect
    .poll(
      async () =>
        Object.hasOwn(
          (await readJournal(page)).state.frontiers,
          `msg:${directId}`,
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  expect(
    app.report.readPublications.some(({ blob }) =>
      Object.hasOwn(blob.contexts, `msg:${directId}`),
    ),
  ).toBe(false);
  await expect(replyComposer).toBeFocused();
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toHaveCount(0);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await panel.getByRole("button", { name: /^View 1 reply/ }).click();
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toBeInViewport();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(broadcast).toHaveAccessibleName("View thread: 23 replies");
  await expect(dot(first)).toHaveCount(0);
  await expect(dot(other)).toBeVisible();
  await expect(other).toHaveAccessibleName(/Observed unread replies/); // No channel-wide shortcut.
  // The close transition owns channel width; unread receipt does not mean its
  // resulting Virtua remeasurement and native scrolling have finished.
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(
    page.locator('[data-panel-dock][data-closing="true"]'),
  ).toHaveCount(0);
  const own = app.reply(roots[0].id, true);
  // Barrier: the session has indexed the reply, so its unread effect is final.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("alpha", id),
        own.id,
      ),
    )
    .toMatchObject({ status: "ineligible", unread: false });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  app.reply(roots[0].id);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await virtuaIdle(page);
  // Remeasurement while geometry settles may start another native scroll.
  await expect(page.locator("[data-channel-timeline] ol")).toHaveCSS(
    "pointer-events",
    "auto",
  );
  const reopenAttempt = await page.evaluate(
    () => window.fixtureNavigation.snapshot().attempt.id,
  );
  await first.click();
  await expect
    .poll(() =>
      page.evaluate((before) => {
        const { status, entry, attempt } = window.fixtureNavigation.snapshot();
        return {
          status,
          freshAttempt: attempt.id !== before,
          messageId: entry.target.messageId,
        };
      }, reopenAttempt),
    )
    .toEqual({ status: "opened", freshAttempt: true, messageId: roots[0].id });
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  const savedEntry = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry,
  );
  const beforeReload = app.report.queries.length;
  await page.reload();
  // Reload restores this visit itself. Reopening Messages through Search races
  // startup results and could hide a broken restoration by starting a new visit.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = window.fixtureNavigation?.snapshot();
        return snapshot && { status: snapshot.status, entry: snapshot.entry };
      }),
    )
    .toEqual({ status: "opened", entry: savedEntry });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  // Restoring a joined conversation waits for initial membership discovery;
  // it must not publish an early one-channel roster through exact resolution.
  expect(
    app.report.queries
      .slice(beforeReload)
      .filter(
        ({ filter }) =>
          filter.kinds?.includes(39002) && filter["#d"]?.includes("alpha"),
      ),
  ).toEqual([]);
});

// Browser-only contract: fitting rows generate no scroll/resize when an empty
// legacy continuation finishes. Opening alone must still earn reading dwell.
test("opening a fitting thread reads after unchanged-row continuation without another gesture", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  const button = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let continuation = false;
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) =>
          filter.depth_limit &&
          filter["#e"]?.[0] === root.id &&
          filter.thread_cursor !== undefined,
      )
    ) {
      continuation = true;
      await gate;
    }
    await route.continue();
  });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  try {
    await button.click();
    await expect.poll(() => continuation).toBe(true);
    await expect(
      panel.getByText("Unread reply 1", { exact: true }),
    ).toBeInViewport();
    await expect(
      panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeFocused();
    expect(
      await history.evaluate(
        (element) => element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    await page.clock.runFor(300);
    await expect(button).toHaveAccessibleName(/Observed unread replies/);
  } finally {
    release();
  }
  await expect(button).not.toHaveAccessibleName(/Observed unread replies/);
  // An explicit retarget of the still-open panel also transfers reading focus.
  const otherRoot = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const other = page
    .locator(`[data-channel-timeline] [data-message-id="${otherRoot.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await other.click();
  await expect(panel).toHaveCount(1);
  await expect(
    panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeFocused();
  const reply = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  await expect(reply).toBeInViewport();
  const id = await reply.getAttribute("data-message-id");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("alpha", id)
            .unread,
        id,
      ),
    )
    .toBe(false);
});

test("channel bottom quiets ordinary replies newer than the latest top-level message without reading their threads", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  const button = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .focus();
  // Team's row stays unread for the channel's threads (conversation-index.ts).
  await expect(channelRow(page, "alpha")).toHaveAttribute(
    "data-state",
    "unread",
  );
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
});

// Real tab restoration and browser focus must hand an explicit channel visit
// to its already-visible thread; a mounted panel alone is not reading evidence.
for (const { paneOpen, width } of [
  { paneOpen: true, width: 1440 },
  { paneOpen: true, width: 1280 },
  { paneOpen: false, width: 1440 },
])
  test(`returning to a channel ${paneOpen ? "reads it and its already-open thread" : "leaves its hidden thread unread"} at ${width}px`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.clock.install();
    await holdReadingFocus(page);
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const otherRoot = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    const observed = (target) =>
      page.evaluate(
        (target) =>
          window.fixtureRelay.snapshot().session.unread.snapshot(target)
            .observedCount,
        target,
      );
    const unread = (rootId = root.id) =>
      observed({ kind: "thread", channelId: "alpha", rootId });
    // The neighboring thread is never opened, so once the channel is read its
    // replies are all that remains unread there.
    const unreadBeyondNeighbor = async () =>
      (await observed({ kind: "channel", channelId: "alpha" })) -
      (await unread(otherRoot.id));
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(
      panel.getByText("Unread reply 1", { exact: true }),
    ).toBeInViewport();
    // Setup must stay unread even when opening and switching channels is slow.
    await page.clock.runFor(1000);
    if (!paneOpen)
      await page
        .getByRole("button", { name: "Toggle tab pane", exact: true })
        .click();
    await go(page, "beta");
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    expect(await unread()).toBeGreaterThan(0);
    expect(await unreadBeyondNeighbor()).toBeGreaterThan(0);
    await releaseReadingFocus(page);
    await go(page, "alpha");
    if (!paneOpen) {
      await expect(panel).toBeHidden();
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeFocused();
      await page.clock.runFor(1000);
      expect(await unread()).toBeGreaterThan(0);
      return;
    }
    await expect(
      panel.getByText("Unread reply 1", { exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeFocused();
    await expect.poll(() => unread()).toBe(0);
    // The channel's own conversation is read too.
    await expect.poll(unreadBeyondNeighbor).toBe(0);
    // The other thread was never opened and remains unread.
    await expect(
      page
        .locator(`[data-channel-timeline] [data-message-id="${otherRoot.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    ).toHaveAccessibleName(/Observed unread replies/);
  });

// A link to a message reads only the conversation it focuses: the channel's
// already-open thread stays unread until the person goes there.
test("opening a message link reads the channel but not its already-open thread", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await holdReadingFocus(page);
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const root = history.find((row) => row.content === "Thread root 1");
  // An ordinary message, not the open thread's root: a link to the root can
  // open its thread instead, which then takes focus and reads it.
  const message = history.findLast((row) =>
    row.content.startsWith("primary alpha message"),
  );
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const observed = (target) =>
    page.evaluate(
      (target) =>
        window.fixtureRelay.snapshot().session.unread.snapshot(target)
          .observedCount,
      target,
    );
  const unread = () =>
    observed({ kind: "thread", channelId: "alpha", rootId: root.id });
  const channel = () => observed({ kind: "channel", channelId: "alpha" });
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  await expect(
    panel.getByText("Unread reply 1", { exact: true }),
  ).toBeInViewport();
  // Setup must stay unread even when opening and switching channels is slow.
  await page.clock.runFor(1000);
  await go(page, "beta");
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  const before = await channel();
  expect(await unread()).toBeGreaterThan(0);
  await releaseReadingFocus(page);
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    messageId: message.id,
    scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  });
  await expect(
    page.locator(`[data-channel-timeline] [data-message-id="${message.id}"]`),
  ).toBeInViewport();
  await expect(
    panel.getByText("Unread reply 1", { exact: true }),
  ).toBeInViewport();
  // The channel earned its dwell; the thread had the same chance.
  await expect.poll(channel).toBeLessThan(before);
  await page.clock.runFor(1000);
  expect(await unread()).toBeGreaterThan(0);
});

test.describe("top-level mention activity", () => {
  test.use({ historyCounts: { alpha: 20, beta: 0 } });
  // Team's Mentions view lists each mention as its own row.
  const mentionRow = async (page, text) => {
    await teamView(page, "mentions");
    return conversationList(page)
      .locator("[data-activity-event]")
      .filter({ hasText: text })
      .locator("[data-conversation-row]");
  };

  // Browser-only: the exact opening in the timeline and the visibility read
  // depend on real layout and focus.
  test("a mention-only row opens from Mentions, and opening its mention reads it", async ({
    page,
    app,
  }) => {
    await open(page, app);
    // Load Beta's window first: an exact opening that arrives while the window
    // is still settling opens the message as its own tab instead.
    await go(page, "beta");
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await go(page, "alpha");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    const mention = app.append(
      "primary",
      "beta",
      "Can you sign off on Beta?",
      true,
      false,
      undefined,
      undefined,
      [["p", app.viewer]],
    );
    const row = await mentionRow(page, "Can you sign off on Beta?");
    await expect(row).toHaveAttribute("data-state", "unread");
    await row.click();
    const message = page.locator(
      `[data-channel-timeline] [data-message-id="${mention.id}"]`,
    );
    await expect(message).toBeInViewport();
    await expect(message).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.fixtureRelay.snapshot().session.unread.attention("beta", id)
              .unread,
          mention.id,
        ),
      )
      .toBe(false);
    await expect(row).toHaveAttribute("data-state", "read");
  });

  // Browser-only: the reveal's fractional scroll position and the visibility
  // read depend on real layout.
  test("opening a mention above the bottom from Mentions reads it there", async ({
    page,
    app,
  }) => {
    await open(page, app);
    // Leave Alpha, its window loaded, so its new messages arrive unseen.
    await go(page, "beta");
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    const mention = app.append(
      "primary",
      "alpha",
      "Can you sign off on Alpha?",
      true,
      false,
      undefined,
      undefined,
      [["p", app.viewer]],
    );
    // Enough later messages that revealing the mention cannot reach the
    // bottom, whose catch-up would read it anyway.
    for (let index = 0; index < 40; index++)
      app.append("primary", "alpha", `Later update ${index}`, true, false);
    const row = await mentionRow(page, "Can you sign off on Alpha?");
    await expect(row).toHaveAttribute("data-state", "unread");
    await row.click();
    const message = page.locator(
      `[data-channel-timeline] [data-message-id="${mention.id}"]`,
    );
    await expect(message).toBeInViewport();
    await expect(message).toBeFocused();
    expect(
      await page
        .getByRole("region", { name: "Channel message history" })
        .evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      "the reveal stops above the bottom",
    ).toBeGreaterThan(1);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.fixtureRelay.snapshot().session.unread.attention("alpha", id)
              .unread,
          mention.id,
        ),
      )
      .toBe(false);
    await expect(row).toHaveAttribute("data-state", "read");
    // Alpha's unread threads stay in Threads; only the mention was read.
    await teamView(page, "threads");
    await expect(
      conversationList(page)
        .locator('[data-activity-event^="alpha:"] [data-conversation-row]')
        .first(),
    ).toHaveAttribute("data-state", "unread");
  });
});
