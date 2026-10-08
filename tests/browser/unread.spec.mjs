import { openPage } from "./navigation.mjs";
import { test, expect, ids } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import {
  readJournal as journal,
  holdReadingFocus,
  releaseReadingFocus,
} from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  pluginFixtures: true, // Existing read-only session exposure for owner barriers.
  historyCounts: { alpha: 640, beta: 20 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const alpha = (page) => page.getByRole("button", { name: /^Alpha/ });
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
// The list and its own composer read; the sidebar only selects.
const park = (page) => alpha(page).focus();
const alphaManual = (j) =>
  j.manual.some(
    (target) => target.kind === "channel" && target.channelId === ids.alpha,
  );
const alphaWrites = (app) =>
  app.report.readWrites.flatMap(({ intents, outcomes }) =>
    intents.map((intent, i) => ({ intent, outcome: outcomes[i] })),
  );
async function visible(page) {
  return history(page).evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return [...element.querySelectorAll("[data-message-id]")]
      .filter((row) => {
        const b = row.getBoundingClientRect();
        return (
          b.width > 0 &&
          b.height > 0 &&
          b.top >= viewport.top &&
          b.bottom <= viewport.bottom &&
          b.left >= viewport.left &&
          b.right <= viewport.right
        );
      })
      .map((row) => row.dataset.messageId);
  });
}
async function channelReadAction(page, name) {
  await alpha(page).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Alpha" });
  await menu.getByRole("menuitem", { name, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

// The real startup composition must order optional catalog reads after channel
// authority; completing that first roster cancels reads already in flight.
test("Messages startup waits for channel discovery before loading templates", async ({
  page,
  app,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let catalogRequested = false;
  page.on("request", (request) => {
    if (!request.url().endsWith("/query")) return;
    const filters = request.postDataJSON();
    if (filters.some((filter) => filter["#t"]?.includes("buzz-channel-kit-v1")))
      catalogRequested = true;
  });
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.some((filter) => filter.kinds?.includes(39002) && filter["#p"]))
      await gate;
    await route.continue();
  });
  // Emoji loading is a later effect in the same mounted Messages workspace.
  // Observing it establishes that the earlier template effect has run.
  const workspaceStarted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/query") &&
      request.postDataJSON().some((filter) => filter.kinds?.includes(30030)),
  );
  const catalogLoaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/query") &&
      response
        .request()
        .postDataJSON()
        .some((filter) => filter["#t"]?.includes("buzz-channel-kit-v1")),
  );
  try {
    await page.goto(app.origin);
    await workspaceStarted;
    expect(catalogRequested).toBe(false);
  } finally {
    release();
  }
  await catalogLoaded;
  await composer(page).waitFor();
  await settle(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("built sidebar → visible dwell → durable journal → relay write; reload keeps the relay frontier", async ({
  page,
  app,
}) => {
  await open(page, app);
  const all = app.histories.get(`primary/${ids.alpha}`);
  // The relay counts the whole channel; there is no client-side repair bound.
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${all.length} unread messages`),
  );
  await park(page);
  // Install after startup and focus cancellation have settled on the real
  // clock; pause at a fixed instant rather than the page's ticking clock.
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 20_000);
  await page.clock.runFor(900); // Sidebar focus is not reading, even past dwell.
  expect(await journal(page)).toEqual({ pending: [], manual: [] });
  expect(app.report.readWrites).toEqual([]);
  const visibleIds = await visible(page);
  expect(visibleIds.length).toBeGreaterThan(0);
  // Own-composer focus earns the same dwell as the list.
  await composer(page).focus();
  await page.clock.runFor(299);
  expect(app.report.readWrites).toEqual([]);
  expect(await journal(page)).toEqual({ pending: [], manual: [] });
  await page.clock.runFor(1);
  // Every distinct dwelled ID is an operand; the client cannot choose an
  // arrival-latest anchor using author time or delivery order.
  await expect
    .poll(() =>
      alphaWrites(app)
        .map(({ intent }) => intent.message_id)
        .sort(),
    )
    .toEqual([...visibleIds].sort());
  expect(alphaWrites(app)).toEqual(
    visibleIds.map((message_id) => ({
      intent: {
        type: "mark_through",
        target: { channel_id: ids.alpha },
        message_id,
      },
      outcome: { status: "applied" },
    })),
  );
  const through = Math.max(
    ...all
      .filter((event) => visibleIds.includes(event.id))
      .map(app.relay.sidebarApi.received),
  );
  await page.clock.resume();
  await expect.poll(async () => (await journal(page)).pending).toEqual([]);
  const remaining = all.filter(
    (event) => app.relay.sidebarApi.received(event) > through,
  ).length;
  const settledBadge = async () =>
    remaining
      ? expect(alpha(page).getByRole("img")).toHaveAttribute(
          "aria-label",
          new RegExp(`^${remaining} unread messages`),
        )
      : expect(alpha(page).getByRole("img")).toHaveCount(0);
  await settledBadge();
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await settle(page);
  expect(await journal(page)).toEqual({ pending: [], manual: [] });
  await settledBadge();
});

test("focus cancellation and local manual-unread survive dwell/reload until explicit channel read", async ({
  page,
  app,
}) => {
  app.relay.sidebarApi.hold();
  try {
    await open(page, app);
    await expect.poll(() => app.report.sidebarHolds.length).toBeGreaterThan(0);
    // Mounted history is not proof that the relay sidebar snapshot is ready.
    expect(
      await page.evaluate(
        () => window.fixtureRelay.snapshot().session.unread.sync().completeness,
      ),
    ).toBe("unknown");
  } finally {
    app.relay.sidebarApi.release();
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sync = window.fixtureRelay.snapshot().session.unread.sync();
        return { status: sync.status, completeness: sync.completeness };
      }),
    )
    .toEqual({ status: "reconciled", completeness: "snapshot" });
  await park(page);
  // As above: install after startup and focus cancellation, then pause at
  // fixed instants from one base.
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 20_000);
  await history(page).focus();
  const visibleIds = await visible(page);
  expect(visibleIds.length).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        ({ visibleIds, channelId }) =>
          visibleIds.every(
            (id) =>
              window.fixtureRelay
                .snapshot()
                .session.unread.attention(channelId, id).viewing,
          ),
        { visibleIds, channelId: ids.alpha },
      ),
    )
    .toBe(true);
  await page.clock.runFor(299);
  await park(page);
  await page.clock.runFor(900);
  await page.clock.resume();
  expect(app.report.readWrites).toEqual([]); // Focus left before dwell.
  // The real menu offers a local reminder only once the channel is read.
  await channelReadAction(page, "Mark as Read");
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
  await expect.poll(async () => (await journal(page)).pending).toEqual([]);
  const writesBeforeManual = [...app.report.readWrites];
  await channelReadAction(page, "Mark as Unread");
  await expect.poll(async () => alphaManual(await journal(page))).toBe(true);
  expect((await journal(page)).pending).toEqual([]);
  expect(app.report.readWrites).toEqual(writesBeforeManual);
  const arrival = app.append(
    "primary",
    ids.alpha,
    "After local reminder",
    true,
    false,
  );
  await expect(
    history(page).getByText(arrival.content, { exact: true }),
  ).toBeVisible();
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await park(page);
  // Native append/layout ran with the clock resumed; pause on its advanced clock.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await history(page).focus();
  await page.clock.runFor(1000);
  expect(alphaManual(await journal(page))).toBe(true);
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await page.clock.resume();
  app.relay.holdContent(); // Reload must use verified disk evidence, not wait for network repair.
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await channelReadAction(page, "Mark as Read");
  await expect.poll(async () => alphaManual(await journal(page))).toBe(false);
  await expect
    .poll(() => app.relay.sidebarApi.frontier("primary", ids.alpha).channel)
    .toBe(
      app.relay.sidebarApi.received(
        app.histories.get(`primary/${ids.alpha}`).at(-1),
      ),
    );
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
});

test("a surviving window delivers a closed window's saved read intent", async ({
  page,
  context,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  await park(page);
  const survivor = await context.newPage();
  app.watchPageErrors(survivor);
  survivor.on("console", (message) => {
    if (message.type() === "error")
      app.report.consoleErrors.push(message.text());
  });
  // The origin window saves its read but never gets its write out.
  await page.route("**/sidebar-api", (route) =>
    route.request().postDataJSON()?.type === "write"
      ? new Promise(() => {})
      : route.continue(),
  );
  try {
    await holdReadingFocus(survivor);
    await open(survivor, app);
    await park(survivor);
    await expect
      .poll(() =>
        survivor.evaluate(
          () => window.fixtureRelay.snapshot().session.unread.sync().status,
        ),
      )
      .toBe("reconciled");
    for (const window of [page, survivor])
      await window.evaluate(() =>
        window.fixtureRelay.snapshot().session.unread.ensure(),
      );
    // Both windows are parked and their durable owners are ready before the
    // context-wide clock is installed. No ticking startup interval to overtake.
    const base = Date.now();
    await page.clock.install({ time: base });
    await page.clock.pauseAt(base + 20_000);
    expect(await journal(page)).toEqual({ pending: [], manual: [] });
    await page.bringToFront();
    const visibleIds = await visible(page);
    expect(visibleIds.length).toBeGreaterThan(0);
    await releaseReadingFocus(page);
    await history(page).focus();
    await page.clock.runFor(300);
    await expect
      .poll(async () => (await journal(page)).pending.length)
      .toBeGreaterThan(0);
    await park(page);
    const [saved] = (await journal(page)).pending;
    expect(app.report.readWrites).toEqual([]);
    await page.close();
    await survivor.clock.resume(); // The controlled clock is shared by this context.
    await survivor.bringToFront();
    // Headless bringToFront does not deliver window focus; activation is what
    // flushes the shared journal, so dispatch the event the OS would.
    await survivor.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(() => alphaWrites(app).map(({ intent }) => intent))
      .toContainEqual(saved.intent);
    await expect
      .poll(async () => (await journal(survivor)).pending)
      .toEqual([]);
    await expect
      .poll(() =>
        survivor.evaluate(
          () => window.fixtureRelay.snapshot().session.unread.sync().status,
        ),
      )
      .toBe("reconciled");
  } finally {
    await survivor.close();
  }
});

test.describe("explicit channel read with membership activity", () => {
  test.use({ membershipActivity: true });

  for (const activityOnly of [false, true]) {
    test(
      activityOnly
        ? "membership-only channel clears manual unread without a relay intent"
        : "chat after a local reminder advances the channel cut past membership activity",
      async ({ page, app }) => {
        const loaded = app.histories.get(`primary/${ids.alpha}`).slice(-4);
        const activity = loaded.filter((event) => event.kind === 40099);
        const chats = loaded.filter((event) => event.kind === 9);
        // Start read, so the user can reach Mark as Unread in the real menu.
        app.histories.set(`primary/${ids.alpha}`, activity);
        await open(page, app);
        await park(page);
        await expect(
          history(page).locator("[data-membership-row]"),
        ).toHaveCount(1);
        await channelReadAction(page, "Mark as Unread");
        await expect
          .poll(async () => alphaManual(await journal(page)))
          .toBe(true);
        const writes = [...app.report.readWrites];
        if (!activityOnly) {
          app.histories.set(`primary/${ids.alpha}`, loaded);
          for (const event of chats) app.relay.publish("primary", event);
          await expect(
            history(page).getByText(chats.at(-1).content, { exact: true }),
          ).toBeVisible();
          await expect
            .poll(() =>
              page.evaluate(
                (channelId) =>
                  window.fixtureRelay
                    .snapshot()
                    .session.unread.snapshot({ kind: "channel", channelId })
                    .unread,
                ids.alpha,
              ),
            )
            .toEqual({ status: "exact", value: 2 });
        }
        await expect(alpha(page).getByRole("img")).toHaveAttribute(
          "aria-label",
          "Marked unread on this device only",
        );
        await channelReadAction(page, "Mark as Read");
        await expect
          .poll(async () => alphaManual(await journal(page)))
          .toBe(false);
        await expect
          .poll(async () => (await journal(page)).pending)
          .toEqual([]);
        if (activityOnly) {
          expect(app.report.readWrites).toEqual(writes);
          expect(
            app.relay.sidebarApi.frontier("primary", ids.alpha).channel,
          ).toBeNull();
        } else {
          await expect
            .poll(
              () => app.relay.sidebarApi.frontier("primary", ids.alpha).channel,
            )
            .toBe(app.relay.sidebarApi.received(chats.at(-1)));
          expect(app.report.readWrites.at(-1).intents).toEqual([
            {
              type: "mark_channel_read",
              channel_id: ids.alpha,
              message_id: chats.at(-1).id,
            },
          ]);
        }
        await expect(alpha(page).getByRole("img")).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(app.report.errors).toEqual([]);
      },
    );
  }
});

// This is a browser storage migration case: a previous version's raw IndexedDB
// partition must survive the real strict transaction, broker retry and reload.
test("legacy journal normalization preserves operands, operation IDs and manual marks across windows", async ({
  page,
  context,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  await park(page);
  await page.evaluate(() =>
    window.fixtureRelay.snapshot().session.unread.ensure(),
  );
  const messages = app.histories.get(`primary/${ids.alpha}`).slice(-2);
  const intents = messages.map((event) => ({
    type: "mark_through",
    target: { channel_id: ids.alpha },
    message_id: event.id,
  }));
  const pending = intents.map((intent, i) => ({
    id: `legacy-operation-${i}`,
    intent,
    createdAt: i ? 1 : 2_000_000_000,
  }));
  const manual = [{ kind: "channel", channelId: ids.alpha }];
  // The relay reports unknown outcomes: local normalization still commits,
  // but no operation may be acknowledged away before another window retries.
  await context.route("**/sidebar-api", (route) => {
    const request = route.request().postDataJSON();
    return request?.type === "write"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            outcomes: request.intents.map(() => ({
              status: "unknown",
              retryable: true,
            })),
            projection_status: "not_requested",
          }),
        })
      : route.continue();
  });
  await page.evaluate(
    async ({ pending, manual }) => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-sidebar-v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("partitions", "readwrite", {
            durability: "strict",
          });
          const store = tx.objectStore("partitions");
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (row) row.update({ pending, manual });
            else {
              tx.abort();
              reject(new Error("Missing app-owned partition"));
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    },
    { pending, manual },
  );
  // Reopen the real storage owner, as an upgrade from the previous app would.
  // ensure() on an already-requested session does not reload its journal.
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await page.evaluate(() =>
    window.fixtureRelay.snapshot().session.unread.ensure(),
  );
  const normalized = pending.map(({ createdAt, ...operand }) => operand);
  await expect
    .poll(() => journal(page))
    .toEqual({ pending: normalized, manual });
  const survivor = await context.newPage();
  try {
    app.watchPageErrors(survivor);
    await holdReadingFocus(survivor);
    await open(survivor, app);
    await survivor.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.ensure(),
    );
    await expect
      .poll(() => journal(survivor))
      .toEqual({ pending: normalized, manual });
    await page.reload();
    await openPage(page, "Messages");
    await composer(page).waitFor();
    await page.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.ensure(),
    );
    await expect
      .poll(() => journal(page))
      .toEqual({ pending: normalized, manual });
    await context.unroute("**/sidebar-api");
    await survivor.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.retrySync(),
    );
    await expect
      .poll(async () => (await journal(survivor)).pending)
      .toEqual([]);
    expect(alphaWrites(app).map(({ intent }) => intent)).toEqual(
      expect.arrayContaining(intents),
    );
    expect((await journal(survivor)).manual).toEqual(manual);
  } finally {
    await context.unroute("**/sidebar-api");
    await survivor.close();
  }
});

// Browser wiring: the real menu captures the opaque summary anchor, and reload
// preserves its read cut without masking a subsequently admitted old-time row.
test("channel menu follows arrival anchors despite future and backward author clocks", async ({
  page,
  app,
}) => {
  const future = app.append(
    "primary",
    ids.alpha,
    "Future-authored first",
    false,
    false,
    undefined,
    undefined,
    [],
    2_000_000_000,
  );
  const older = app.append(
    "primary",
    ids.alpha,
    "Older-authored second",
    false,
    false,
    undefined,
    undefined,
    [],
    1_700_000_001,
  );
  await holdReadingFocus(page);
  await open(page, app);
  const snapshot = () =>
    page.evaluate(
      (channelId) =>
        window.fixtureRelay
          .snapshot()
          .session.unread.snapshot({ kind: "channel", channelId }),
      ids.alpha,
    );
  await expect.poll(snapshot).toMatchObject({
    latestMessageId: older.id,
    latestActivityAt: future.created_at,
  });
  await channelReadAction(page, "Mark as Read");
  await expect
    .poll(() => alphaWrites(app).map(({ intent }) => intent))
    .toEqual([
      {
        type: "mark_channel_read",
        channel_id: ids.alpha,
        message_id: older.id,
      },
    ]);
  await expect.poll(async () => (await journal(page)).pending).toEqual([]);
  await expect
    .poll(snapshot)
    .toMatchObject({ unread: { status: "exact", value: 0 } });
  const late = app.append(
    "primary",
    ids.alpha,
    "Late old author",
    true,
    false,
    undefined,
    undefined,
    [],
    1_700_000_000,
  );
  await page.evaluate(() =>
    window.fixtureRelay.snapshot().session.unread.refresh(),
  );
  await expect.poll(snapshot).toMatchObject({
    latestMessageId: late.id,
    latestActivityAt: future.created_at,
    unread: { status: "exact", value: 1 },
    unreadVisible: true,
  });
  await page.reload();
  await openPage(page, "Messages");
  await composer(page).waitFor();
  await expect.poll(snapshot).toMatchObject({
    unread: { status: "exact", value: 1 },
    unreadVisible: true,
  });
  await channelReadAction(page, "Mark as Read");
  await expect
    .poll(snapshot)
    .toMatchObject({ unread: { status: "exact", value: 0 } });
  expect(alphaWrites(app).at(-1).intent.message_id).toBe(late.id);
});
