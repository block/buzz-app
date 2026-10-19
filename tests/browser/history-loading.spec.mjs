import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { anchor, expectAnchor, open, settle, wheel } from "./timeline.mjs";

test.use({
  productionBroker: true,
  historyCounts: { alpha: 640, beta: 20 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

const tall = test.extend({ tallMessages: true });

tall(
  "automatic history starts before the top in a production broker session",
  async ({ page, app }) => {
    await open(page, app);
    await expect(
      page.getByRole("status", {
        name: "Reconnecting to relay…",
        exact: true,
      }),
    ).toHaveCount(0);
    await history(page).hover();
    for (let i = 0; i < 100 && !app.pending.length; i++) {
      const before = await history(page).evaluate((e) => e.scrollTop);
      await page.mouse.wheel(0, -450);
      // Each wheel step must land (scroll moves or the older page is
      // requested) before the next one.
      await expect
        .poll(
          async () =>
            app.pending.length > 0 ||
            (await history(page).evaluate((e) => e.scrollTop)) < before,
        )
        .toBe(true);
      if (
        await history(page)
          .getByRole("button", { name: "Loading older…", exact: true })
          .count()
      )
        break;
    }
    await expect.poll(() => app.pending.length).toBe(1);
    const top = await history(page).evaluate((e) => e.scrollTop);
    app.report.measurements.push({ automaticRequestTop: top });
    expect(top).toBeGreaterThan(1000);
    app.pending.shift().release();
    await settle(page);
  },
);

test("returning to the top continues history loading on wheel without a button", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("status", {
      name: "Reconnecting to relay…",
      exact: true,
    }),
  ).toHaveCount(0);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  // Navigate away while a real cursor request is in flight, then return to the
  // saved top before releasing it; this must remain an ordinary scroll journey.
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  app.pending.shift().release();
  await settle(page);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  app.pending.shift().release();
});

test("saved top resumes automatic history on an upward gesture after remount", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("status", {
      name: "Reconnecting to relay…",
      exact: true,
    }),
  ).toHaveCount(0);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  await expect.poll(() => history(page).evaluate((e) => e.scrollTop)).toBe(0);
  await openPage(page, "Workflows");
  // Remounting Channels captures the normal reading anchor in localStorage.
  // Reload gives a new session/finite head but preserves that user-owned anchor.
  await page.reload();
  app.pending.shift().release();
  await openPage(page, "Messages");
  await expect(history(page)).toBeVisible();
  await expect(
    page.getByRole("status", {
      name: "Reconnecting to relay…",
      exact: true,
    }),
  ).toHaveCount(0);
  await settle(page);
  await expect.poll(() => history(page).evaluate((e) => e.scrollTop)).toBe(0);
  expect(app.pending).toHaveLength(0);
  await history(page).hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => app.pending.length).toBe(1);
  app.pending.shift().release();
});

test.describe("quota retry without threshold-driven continuation", () => {
  test.use({ tallMessages: true });
  test("older-page quota errors require deliberate retry instead of more scrolling requests", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect(
      page.getByRole("status", {
        name: "Reconnecting to relay…",
        exact: true,
      }),
    ).toHaveCount(0);
    const olderAlpha = (filter) =>
      filter.until !== undefined &&
      filter["#h"]?.includes("alpha") &&
      filter.kinds?.some((kind) => kind === 9 || kind === 40002);
    // Observe before broker admission: a bad retry may be rejected locally.
    // Unrelated background reads (including unread repair) must not count.
    const browserCursors = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/relay/primary/query"
      ) {
        const filters = request.postDataJSON();
        if (filters.some(olderAlpha)) browserCursors.push(filters);
      }
    });
    app.relay.quotaNextOlder("alpha", 0);
    const cursors = () =>
      app.report.queries.filter(({ filter }) => olderAlpha(filter));
    await history(page).hover();
    await page.mouse.wheel(0, -100000);
    await expect(history(page).getByRole("alert")).toContainText(
      "rate-limited",
    );
    const count = cursors().length;
    expect(count).toBe(1);
    expect(browserCursors).toHaveLength(1);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -500);
    await settle(page);
    expect(cursors()).toHaveLength(count);
    expect(browserCursors).toHaveLength(count);
    // Only the broker lane holds older-page retries; it reopens at this bound.
    await expect.poll(() => app.relay.brokerCooldownOver()).toBe(true);
    await history(page)
      .getByRole("button", { name: "Retry older messages", exact: true })
      .click();
    await expect.poll(() => app.pending.length).toBe(1);
    expect(cursors()).toHaveLength(count + 1);
    expect(browserCursors).toHaveLength(count + 1);
    app.pending.shift().release();
    await expect(history(page).getByRole("alert")).toHaveCount(0);
    await expect(
      history(page).getByRole("button", {
        name: "Load older messages",
        exact: true,
      }),
    ).toBeEnabled(); // Still more history: retry success must not enqueue it.
    await settle(page);
    expect(cursors()).toHaveLength(count + 1);
    expect(browserCursors).toHaveLength(count + 1);
    expect(app.pending).toHaveLength(0);
  });
});

test.describe("pages inside one second", () => {
  // More rows share a second than a page holds. Relay pages break ties by id,
  // rows by send time, so the next page lands among the loaded rows of that second.
  test.use({ historyRowsPerSecond: 30 });
  // Hold the next older page while reading `depth` px above the newest rows.
  async function reading(page, app, depth) {
    await open(page, app);
    await history(page).hover();
    await wheel(page, -250);
    await expect.poll(() => app.pending.length).toBe(1);
    if (depth > 250) await wheel(page, 250 - depth);
    const pending = app.pending.shift();
    expect(
      pending.events.every(
        (event) => event.created_at === pending.filter.until,
      ),
    ).toBe(true);
    return pending;
  }
  const latest = (page) =>
    page.getByRole("button", { name: /^(Jump to latest|\d+ new messages?)$/ });
  for (const depth of [250, 1400])
    test(`an older page among the loaded rows keeps a reader ${depth}px up`, async ({
      page,
      app,
    }) => {
      const pending = await reading(page, app, depth);
      const before = await anchor(page);
      const height = await history(page).evaluate((e) => e.scrollHeight);
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await settle(page);
      await expectAnchor(page, before);
      // History is not new; a live message still is.
      await expect(latest(page)).toHaveText("Jump to latest");
      app.append("primary", "alpha", undefined, true, false);
      await expect(latest(page)).toHaveText("1 new message");
      await expectAnchor(page, before);
    });

  test("input after the page lands starts from the reader's row", async ({
    page,
    app,
  }) => {
    const pending = await reading(page, app, 1400);
    const before = await anchor(page);
    const height = await history(page).evaluate((e) => e.scrollHeight);
    // Hold every animation frame: input can arrive before any deferred work.
    await page.evaluate(() => {
      const { requestAnimationFrame: request, cancelAnimationFrame: cancel } =
        window;
      const held = new Map();
      let id = 0;
      window.requestAnimationFrame = (callback) => {
        held.set(--id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) =>
        id < 0 ? held.delete(id) : cancel(id);
      window.releaseFrames = () => {
        Object.assign(window, {
          requestAnimationFrame: request,
          cancelAnimationFrame: cancel,
        });
        for (const callback of held.values()) request(callback);
      };
    });
    try {
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await expectAnchor(page, before);
      await page.mouse.wheel(0, -40);
      await expectAnchor(page, { ...before, y: before.y + 40 });
    } finally {
      await page.evaluate(() => window.releaseFrames());
    }
  });

  test("a held pointer scrolls across the page without being pulled back", async ({
    page,
    app,
  }) => {
    const pending = await reading(page, app, 1400);
    const box = await history(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      const height = await history(page).evaluate((e) => e.scrollHeight);
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await settle(page);
      // A scrollbar drag moves the scroller with no further input events,
      // into older rows that measure as they mount.
      for (let step = 0; step < 10; step++) {
        const before = await anchor(page);
        await history(page).evaluate((e) => {
          e.scrollTop -= 150;
        });
        await settle(page);
        await expectAnchor(page, { ...before, y: before.y + 150 });
      }
    } finally {
      await page.mouse.up();
    }
  });

  for (const distance of [600, 1200])
    test(`a row in view grows downward ${distance}px above the page's reader`, async ({
      page,
      app,
    }) => {
      const pending = await reading(page, app, 1400);
      const height = await history(page).evaluate((e) => e.scrollHeight);
      pending.release();
      await expect
        .poll(() => history(page).evaluate((e) => e.scrollHeight))
        .toBeGreaterThan(height);
      await settle(page);
      await wheel(page, -distance);
      const before = await anchor(page);
      // An image or embed finishing below the reader's paragraph.
      await history(page).evaluate((e, id) => {
        const extra = document.createElement("div");
        extra.style.height = "300px";
        e.querySelector(`[data-message-id="${id}"] p`).after(extra);
      }, before.id);
      await settle(page);
      await expectAnchor(page, before);
    });

  test("a live message in the loaded first second is new", async ({
    page,
    app,
  }) => {
    const pending = await reading(page, app, 1400);
    const before = await anchor(page);
    // Sorted among loaded history by a sender clock, before any page lands.
    app.relay.publish(
      "primary",
      app.sign({
        kind: 9,
        created_at: pending.filter.until,
        tags: [
          ["h", "alpha"],
          ["ms", "999"],
        ],
        content: "Delayed live message",
      }),
    );
    await expect(latest(page)).toHaveText("1 new message");
    pending.release();
    await settle(page);
    await expectAnchor(page, before);
    await expect(latest(page)).toHaveText("1 new message");
  });
});

test("cancelled navigation keeps relay reads usable in the same document", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.evaluate(() => {
    window.addEventListener(
      "beforeunload",
      (event) => {
        event.preventDefault();
        event.returnValue = "";
      },
      { once: true },
    );
  });
  const sessions = app.report.sessions.length;
  const dialog = page.waitForEvent("dialog");
  await page.evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });
  await (await dialog).dismiss();
  // This must be the same session, not a replacement that bypasses a stuck gate.
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(history(page)).toContainText("primary beta message");
  expect(app.report.sessions).toHaveLength(sessions);
});
