import { openPage } from "./navigation.mjs";
import { test, expect, ids, sidebarJournals } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

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
// Observe the real durable result, never seed state or call an engine test hook.
async function journal(page) {
  const all = await sidebarJournals(page);
  return {
    pending: all.flatMap((journal) => journal.pending),
    manual: all.flatMap((journal) => journal.manual),
  };
}
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
  await page.clock.install();
  await open(page, app);
  const all = app.histories.get(`primary/${ids.alpha}`);
  // The relay counts the whole channel; there is no client-side repair bound.
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${all.length} unread messages`),
  );
  await composer(page).focus();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.clock.runFor(900); // Composer focus is not reading, even past dwell.
  expect(await journal(page)).toEqual({ pending: [], manual: [] });
  expect(app.report.readWrites).toEqual([]);
  const visibleIds = await visible(page);
  expect(visibleIds.length).toBeGreaterThan(0);
  await history(page).focus();
  await page.clock.runFor(300);
  expect(app.report.readWrites).toEqual([]);
  await page.clock.runFor(750);
  // One mark_through per context, anchored on the newest dwelled message.
  const newest = all
    .filter((event) => visibleIds.includes(event.id))
    .reduce((a, b) => (b.created_at > a.created_at ? b : a));
  await expect
    .poll(() => alphaWrites(app))
    .toEqual([
      {
        intent: {
          type: "mark_through",
          target: { channel_id: ids.alpha },
          message_id: newest.id,
        },
        outcome: { status: "applied" },
      },
    ]);
  await page.clock.resume();
  await expect.poll(async () => (await journal(page)).pending).toEqual([]);
  const remaining = all.filter(
    (event) => event.created_at > newest.created_at,
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
  await page.clock.install();
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
  await composer(page).focus();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
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
  await page.clock.runFor(300);
  await composer(page).focus();
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
  await composer(page).focus();
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
    .toBe(app.histories.get(`primary/${ids.alpha}`).at(-1).created_at);
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
});

test("a surviving window delivers a closed window's saved read intent", async ({
  page,
  context,
  app,
}) => {
  await open(page, app);
  await composer(page).focus();
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
    await open(survivor, app);
    await composer(survivor).focus();
    await expect
      .poll(() =>
        survivor.evaluate(
          () => window.fixtureRelay.snapshot().session.unread.sync().status,
        ),
      )
      .toBe("reconciled");
    await page.bringToFront();
    await history(page).focus();
    await expect
      .poll(async () => (await journal(page)).pending.length)
      .toBeGreaterThan(0);
    const [saved] = (await journal(page)).pending;
    expect(app.report.readWrites).toEqual([]);
    await page.close();
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
        await composer(page).focus();
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
            .toBe(chats.at(-1).created_at);
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
