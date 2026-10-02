import { test, expect, ids, sidebarJournals } from "./fixture.mjs";
import { open, virtuaIdle } from "./timeline.mjs";
import { holdReadingFocus, releaseReadingFocus } from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  // The viewer joined the peer's thread with a reply older than the loaded
  // window; only the relay's read model sees it, so it alone makes that count.
  threadUnreadJoined: true,
  historyCounts: { alpha: 20, beta: 1 },
  largeSidebar: true,
  pluginFixtures: true, // Observe the real navigation completion, not reply mount timing.
});
test.describe("mentioned reply priority", () => {
  test.use({ threadUnreadMentions: true, threadUnreadOrdinaryNested: true });

  test("a mention and broadcast remain distinguishable in Activity", async ({
    page,
    app,
  }) => {
    await holdReadingFocus(page);
    await open(page, app);
    const alpha = page.locator(`button[data-channel-id="${ids.alpha}"]`);
    await expect(
      alpha.getByRole("img", { name: /unread threads?/ }),
    ).toBeVisible();
    await alpha.hover();
    const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
    await expect(popover).toBeVisible();
    const items = popover.getByRole("button", {
      name: /Open unread thread from/,
    });
    await expect(items).toHaveCount(2);
    const names = await items.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("aria-label")),
    );

    expect(
      names.every((name) => name?.startsWith("Open unread thread from ")),
    ).toBe(true);
    // Each thread previews its newest relevant reply: the nested mention in
    // the viewer's thread, and the direct mention in the peer thread, not the
    // newer ordinary reply nested under a peer reply there.
    expect(new Set(names.map((name) => name?.split(": ").at(-1)))).toEqual(
      new Set(["Broadcast descendant", "Unread reply 1"]),
    );
  });
});

test("thread buttons show observed unread independently, clear only after reading, and expose hover/focus affordance", async ({
  page,
  app,
}, testInfo) => {
  // Reading needs a 300ms dwell (use-reading.ts). The clock runs that deadline
  // exactly where the test proves that something is not reading.
  await page.clock.install();
  const fullHistory = app.histories.get(`primary/${ids.alpha}`);
  const fullReplies = new Map(app.threadReplies);
  app.histories.set(`primary/${ids.alpha}`, fullHistory.slice(0, 1));
  app.threadReplies.clear();
  await holdReadingFocus(page);
  await open(page, app);
  const alpha = page.locator(`button[data-channel-id="${ids.alpha}"]`);
  const actions = page.getByRole("menu", { name: "Actions for Alpha" });
  await alpha.click({ button: "right" });
  await actions
    .getByRole("menuitem", { name: "Mark as Read", exact: true })
    .click();
  await expect(actions).toHaveCount(0);
  await expect(alpha.getByRole("img")).toHaveCount(0);
  await alpha.click({ button: "right" });
  await actions
    .getByRole("menuitem", { name: "Mark as Unread", exact: true })
    .click();
  await expect(actions).toHaveCount(0);
  await expect
    .poll(async () =>
      (await sidebarJournals(page)).some((journal) =>
        journal.manual.some(
          (target) =>
            target.kind === "channel" && target.channelId === ids.alpha,
        ),
      ),
    )
    .toBe(true);
  // Restore/deliver upstream signed history only after the real menu reminder.
  app.histories.set(`primary/${ids.alpha}`, fullHistory);
  for (const [root, replies] of fullReplies)
    app.threadReplies.set(root, replies);
  for (const event of fullHistory.slice(1)) app.relay.publish("primary", event);
  // Reload fetches the server's thread summaries as well as message rows;
  // live messages alone do not carry the fixture's 39005 summary events.
  await page.reload();
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  const roots = app.histories
    .get(`primary/${ids.alpha}`)
    .filter((row) => row.content.startsWith("Thread root"));
  const button = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const first = button(roots[0]);
  const other = button(roots[1]);
  const broadcast = button(
    app.histories
      .get(`primary/${ids.alpha}`)
      .find((row) => row.content === "Broadcast reply"),
  );
  const dot = (control) => control.locator('span[title$=" unread replies"]');
  await expect(first).toHaveAccessibleName(/23 replies\. \d+ unread replies/);
  await expect(other).toHaveAccessibleName(/23 replies\. \d+ unread replies/);
  await expect(dot(first)).toBeVisible();
  await expect(dot(other)).toBeVisible();
  await expect(broadcast).toHaveAccessibleName(/\d+ unread replies/);
  const activity = alpha.getByRole("img", { name: /unread threads?/ });
  await expect(activity).toBeVisible();
  await expect(alpha.getByText("Alpha", { exact: true })).toHaveCSS(
    "font-weight",
    "600",
  );
  await expect(
    alpha.getByRole("img", { name: /Marked unread on this device only/ }),
  ).toBeAttached();
  await expect(activity).toHaveAccessibleName(/unread threads?/);
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await alpha.hover();
  const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popover).toBeVisible();
  await expect(
    popover.getByText("Activity in Alpha", { exact: true }),
  ).toHaveCount(0);
  await popover.screenshot({
    path: testInfo.outputPath("activity-popover.png"),
  });
  // The viewer's own thread and the peer thread the viewer joined.
  await expect(
    popover.getByRole("button", { name: /Open unread thread from/ }),
  ).toHaveCount(2);
  // The relay decides membership; the client never looks up its own replies.
  expect(
    app.report.queries.filter(
      ({ filter }) => filter.authors?.includes(app.viewer) && filter["#e"],
    ),
  ).toEqual([]);
  const queries = () =>
    app.report.queries.filter(({ filter }) => filter.depth_limit);
  expect(queries()).toHaveLength(0); // Merely displaying buttons never fetches threads.
  // The sibling context trigger must not steal the activity button's props or
  // focus. Exercise the real portals while unread activity is still present.
  await alpha.click({ button: "right" });
  await expect(
    actions.getByRole("menuitem", { name: "New session" }),
  ).toBeVisible();
  // Leave the hover trigger while the context menu still owns focus. Otherwise
  // its delayed hover close can overlap the later keyboard-open assertion.
  await page.mouse.move(0, 0);
  await expect(popover).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await alpha.press("Shift+F10");
  await expect(actions).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await expect(popover).toHaveCount(0);
  await expect(alpha).toHaveAttribute("aria-expanded", "false");
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  const item = popover
    .getByRole("button", {
      name: /Open unread thread from/,
    })
    .first();
  await item.focus();
  await expect(item).toBeFocused();
  await releaseReadingFocus(page);
  await item.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close Thread tab", exact: true })
    .click();
  await expect(alpha).toBeFocused();
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
        .get(`primary/${ids.alpha}`)
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
  await expect
    .poll(
      () =>
        app.report.readWrites.some(({ intents, outcomes }) =>
          intents.some(
            (intent, i) =>
              intent.message_id === directId &&
              outcomes[i].status === "applied",
          ),
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  await expect(replyComposer).toBeFocused();
  await expect(other).toHaveAccessibleName(/\d+ unread replies/);
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toHaveCount(0);
  await expect(first).toHaveAccessibleName(/\d+ unread replies/);
  await panel.getByRole("button", { name: /^View 1 reply/ }).click();
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toBeInViewport();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(broadcast).toHaveAccessibleName("View thread: 23 replies");
  await expect(dot(first)).toHaveCount(0);
  await expect(dot(other)).toBeVisible();
  await expect(other).toHaveAccessibleName(/\d+ unread replies/); // No channel-wide shortcut.
  await page
    .getByRole("button", { name: "Close Thread tab", exact: true })
    .click();
  const own = app.reply(roots[0].id, true);
  // Barrier: the session indexed this reply under the exact root. A live own
  // reply need not have authoritative BFF message context to be non-unread.
  await expect
    .poll(() =>
      page.evaluate(
        ({ channelId, id }) =>
          window.fixtureRelay
            .snapshot()
            .session.unread.attention(channelId, id),
        { channelId: ids.alpha, id: own.id },
      ),
    )
    .toMatchObject({
      category: "thread",
      rootId: roots[0].id,
      unread: false,
    });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  app.reply(roots[0].id);
  await expect(first).toHaveAccessibleName(/\d+ unread replies/);
  await first.click();
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/\d+ unread replies/);
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
  await expect(other).toHaveAccessibleName(/\d+ unread replies/);
  // Restoring the visit waits for initial channel-membership discovery; it
  // must not publish an early one-channel roster through exact resolution.
  expect(
    app.report.queries
      .slice(beforeReload)
      .filter(
        ({ filter }) =>
          filter.kinds?.includes(39002) && filter["#d"]?.includes(ids.alpha),
      ),
  ).toEqual([]);
});

// Browser focus plus actual controller/React wiring: a same-target open must not
// leave the timeline's trigger installed merely because the history entry is reused.
test("same-thread sidebar activity replaces timeline focus return", async ({
  page,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  const root = app.histories
    .get(`primary/${ids.alpha}`)
    .find((row) => row.content === "Thread root 0");
  const alpha = page.locator(`button[data-channel-id="${ids.alpha}"]`);
  await expect(
    alpha.getByRole("img", { name: /unread threads?/ }),
  ).toBeVisible();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    ) {
      requested = true;
      await held;
    }
    await route.continue().catch(() => {});
  });
  try {
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    await virtuaIdle(page);
    await releaseReadingFocus(page);
    await trigger.click();
    await expect.poll(() => requested).toBe(true);
    const before = await page.evaluate(() => {
      const { entry, attempt } = window.fixtureNavigation.snapshot();
      return { entry: entry.id, attempt: attempt.id };
    });
    await alpha.hover();
    const activity = page.getByRole("dialog", { name: "Activity in Alpha" });
    await activity
      .getByRole("button", {
        name: /Open unread thread from.*Broadcast descendant/,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate((before) => {
          const { entry, attempt } = window.fixtureNavigation.snapshot();
          return {
            sameEntry: entry.id === before.entry,
            freshAttempt: attempt.id !== before.attempt,
          };
        }, before),
      )
      .toEqual({ sameEntry: true, freshAttempt: true });
    release();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await page
      .getByRole("button", {
        name: "Close Thread tab",
        exact: true,
      })
      .click();
    await expect(alpha).toBeFocused();
  } finally {
    release();
  }
});

// Browser-only: readiness must wake dwell without another focus/geometry gesture.
// Strict completes its first window; legacy completes an empty forward continuation.
for (const legacy of [false, true]) {
  test(
    legacy
      ? "UUID fallback reads fitting unchanged rows after the empty legacy continuation"
      : "strict fitting thread reads after its held initial window without another gesture",
    async ({ page, app }, testInfo) => {
      await page.clock.install();
      const root = app.histories
        .get(`primary/${ids.alpha}`)
        .find((row) => row.content === "Thread root 1");
      // Keep the original uppercase-reference reply; add legitimate canonical
      // signed evidence for the missing-bounds fallback's exact-reference check.
      const canonical = legacy ? app.reply(root.id, false, false) : undefined;
      const replies = app.threadReplies.get(root.id);
      const newest = replies.at(-1);
      await open(page, app);
      const button = page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      await expect(button).toHaveAccessibleName(/\d+ unread replies/);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let pending = false;
      const exchanges = [];
      const routes = [];
      const owns = (filter) =>
        filter.depth_limit && filter["#e"]?.[0] === root.id;
      await page.route("**/query", (route) => {
        const task = (async () => {
          const filters = route.request().postDataJSON();
          const filter = filters.find(owns);
          if (!filter) return route.continue();
          if (
            legacy
              ? filter.thread_cursor !== undefined
              : filter.thread_window && filter.until === undefined
          ) {
            pending = true;
            await gate;
          }
          if (legacy && !filter.thread_window) {
            // The broker fixture models strict windows, not legacy batches.
            // Model this root's fallback locally using untouched signed events;
            // this is browser fallback coverage, not broker-transport coverage.
            expect(filters).toHaveLength(2);
            expect(filters[0]).toEqual({
              ids: [root.id],
              "#h": [ids.alpha],
              limit: 1,
            });
            expect(filter).toMatchObject({
              "#h": [ids.alpha],
              "#e": [root.id],
              depth_limit: 100,
              include_aux: true,
              limit: 50,
            });
            expect(filter.kinds.toSorted((a, b) => a - b)).toEqual([
              9, 40002, 40008,
            ]);
            for (const key of ["thread_window", "until", "before_id"])
              expect(filter[key]).toBeUndefined();
            const continuation = filter.thread_cursor !== undefined;
            if (continuation) {
              expect(filter.thread_cursor).toBe(newest.created_at);
              expect(filter.thread_cursor_id).toBe(newest.id);
            } else expect(filter.thread_cursor_id).toBeUndefined();
            const events = continuation ? [root] : [root, ...replies];
            exchanges.push({ filters, events });
            return route.fulfill({ json: events });
          }
          const response = await route.fetch();
          const original = await response.json();
          const events =
            legacy && filter.thread_window && filter.until === undefined
              ? original.filter((event) => event.kind !== 39007)
              : original;
          exchanges.push({ filters, events });
          await route.fulfill({ response, json: events });
        })();
        routes.push(task);
        return task;
      });
      const panel = page.getByRole("complementary", {
        name: "Thread",
        exact: true,
      });
      const history = panel.getByRole("region", { name: "Thread messages" });
      const applied = () =>
        app.report.readWrites.some(({ intents, outcomes }) =>
          intents.some(
            (intent, i) =>
              replies.some((reply) => reply.id === intent.message_id) &&
              outcomes[i].status === "applied",
          ),
        );
      const geometry = () =>
        history.evaluate((element) => ({
          ids: [...element.querySelectorAll("[data-message-id]")].map(
            (row) => row.dataset.messageId,
          ),
          height: element.scrollHeight,
          clientHeight: element.clientHeight,
          top: element.scrollTop,
        }));
      let before;
      try {
        await button.click();
        await expect.poll(() => pending).toBe(true);
        await expect(
          page.getByRole("tab", { name: "Thread", exact: true }),
        ).toBeFocused();
        await expect(history.locator("[data-thread-rows]")).not.toHaveAttribute(
          "inert",
        );
        await expect(
          history.locator(`[data-message-id="${root.id}"]`),
        ).toBeVisible();
        await expect(history.locator("[data-message-id]")).toHaveCount(
          legacy ? 3 : 1,
        );
        if (legacy) {
          await expect(
            panel.getByText("Unread reply 1", { exact: true }),
          ).toBeInViewport();
          await expect(
            panel.getByText("New peer reply", { exact: true }),
          ).toBeInViewport();
          expect(exchanges).toHaveLength(2);
          const probe = exchanges[0];
          expect(probe.filters.find(owns)).toMatchObject({
            thread_window: true,
            limit: 10,
          });
          expect(probe.events.some((event) => event.id === canonical.id)).toBe(
            true,
          );
          expect(probe.events.some((event) => event.kind === 39007)).toBe(
            false,
          );
          const restart = exchanges[1].filters;
          expect(restart.some((filter) => filter.ids?.includes(root.id))).toBe(
            true,
          );
          expect(restart.find(owns)).toMatchObject({ limit: 50 });
          for (const key of [
            "thread_window",
            "until",
            "before_id",
            "thread_cursor",
            "thread_cursor_id",
          ])
            expect(restart.find(owns)[key]).toBeUndefined();
        }
        before = await geometry();
        expect(before.height).toBeLessThanOrEqual(before.clientHeight);
        await page.clock.runFor(300);
        await expect(button).toHaveAccessibleName(/\d+ unread replies/);
        expect(applied()).toBe(false);
        release();
        await expect.poll(() => exchanges.length).toBe(legacy ? 3 : 1);
        await expect(history.locator("[data-message-id]")).toHaveCount(
          replies.length + 1,
        );
        await expect(
          panel.getByText("Unread reply 1", { exact: true }),
        ).toBeInViewport();
        const completed = exchanges.at(-1);
        if (legacy) {
          expect(completed.filters.find(owns)).toMatchObject({
            thread_cursor: newest.created_at,
            thread_cursor_id: newest.id,
          });
          expect(
            completed.events.filter(
              (event) => event.kind === 9 && event.id !== root.id,
            ),
          ).toEqual([]);
          expect(await geometry()).toEqual(before);
        } else {
          expect(
            completed.events
              .filter((event) => event.kind === 39007)
              .map((event) => JSON.parse(event.content)),
          ).toMatchObject([{ has_more: false, next_cursor: null }]);
          expect(
            app.report.queries.filter(
              ({ filter }) =>
                owns(filter) && filter.thread_cursor !== undefined,
            ),
          ).toEqual([]);
          const fitted = await geometry();
          expect(fitted.height).toBeLessThanOrEqual(fitted.clientHeight);
        }
        // No gesture after release. React's readiness notification, not a test
        // focus/scroll event, must start the dwell. Badge refresh is separately debounced.
        await page.clock.runFor(300);
        await expect.poll(applied, { timeout: 12000 }).toBe(true);
        await expect(button).not.toHaveAccessibleName(/\d+ unread replies/);
        await testInfo.attach("fitting-thread-readiness", {
          body: JSON.stringify(
            {
              legacy,
              before,
              after: await geometry(),
              exchanges,
              readWrites: app.report.readWrites,
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
        // An explicit retarget of the still-open panel also transfers reading focus.
        const otherRoot = app.histories
          .get(`primary/${ids.alpha}`)
          .find((row) => row.content === "Thread root 0");
        const other = page
          .locator(
            `[data-channel-timeline] [data-message-id="${otherRoot.id}"]`,
          )
          .getByRole("button", { name: /^View thread:/ });
        await other.click();
        await expect(panel).toHaveCount(1);
        await expect(
          page.getByRole("tab", { name: "Thread", exact: true }),
        ).toBeFocused();
        const reply = panel
          .locator("[data-message-id]")
          .filter({ hasText: "Unread reply 0" });
        await expect(reply).toBeInViewport();
        const id = await reply.getAttribute("data-message-id");
        await expect
          .poll(() =>
            page.evaluate(
              ({ id, channelId }) =>
                window.fixtureRelay
                  .snapshot()
                  .session.unread.attention(channelId, id).unread,
              { id, channelId: ids.alpha },
            ),
          )
          .toBe(false);
      } finally {
        release();
        await Promise.all(routes);
        await page.unroute("**/query");
      }
    },
  );
}

test.describe("peer thread without the viewer", () => {
  test.use({ threadUnreadJoined: false });

  // Control for the joined-thread count above: the same peer thread is quiet
  // when nothing the relay can see puts the viewer in its conversation.
  test("a peer thread the viewer never joined stays out of Activity", async ({
    page,
    app,
  }) => {
    await holdReadingFocus(page);
    await open(page, app);
    const alpha = page.locator(`button[data-channel-id="${ids.alpha}"]`);
    await expect(
      alpha.getByRole("img", { name: /unread threads?/ }),
    ).toBeVisible();
    await alpha.hover();
    const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
    await expect(popover).toBeVisible();
    await expect(
      popover.getByRole("button", { name: /Open unread thread from/ }),
    ).toHaveCount(1);
  });
});

test("channel catch-up never reads replies newer than the latest top-level message", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get(`primary/${ids.alpha}`)
    .find((row) => row.content === "Thread root 1");
  const button = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await expect(button).toHaveAccessibleName(/\d+ unread replies/);
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .focus();
  // Barrier: the channel bottom has been read through a top-level write.
  await expect
    .poll(() =>
      app.report.readWrites.some(({ intents, outcomes }) =>
        intents.some(
          (intent, i) =>
            (intent.target?.channel_id ?? intent.channel_id) === ids.alpha &&
            intent.target?.root_id === undefined &&
            outcomes[i].status === "applied",
        ),
      ),
    )
    .toBe(true);
  await expect(button).toHaveAccessibleName(/\d+ unread replies/);
});
