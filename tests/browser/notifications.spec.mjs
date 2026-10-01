import { test, expect, ids } from "./fixture.mjs";
import { end, open, settle } from "./timeline.mjs";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 1 },
});

// Only the browser's OS boundary is replaced. The built host, session,
// verified WS → broker → SSE and navigation/Channels consumers are production.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.notificationEvents = [];
    window.notificationRequests = 0;
    window.Notification = class {
      static permission = "granted";
      static async requestPermission() {
        window.notificationRequests++;
        window.Notification.permission = "granted";
        return window.Notification.permission;
      }
      constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closed = false;
        window.notificationEvents.push(this);
      }
      close() {
        this.closed = true;
        this.onclose?.();
      }
    };
  });
});
const systemCount = (page) =>
  page.evaluate(() => window.notificationEvents.length);
async function settings(page) {
  expect(
    await page.evaluate(() =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "settings",
        section: "notifications",
      }),
    ),
  ).toEqual({ status: "opened" });
  await expect(
    page.getByRole("heading", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Sound", exact: true }).uncheck();
}
async function ready(page, app) {
  await open(page, app);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = window.fixtureRelay.snapshot().session;
        return (
          session.live
            .snapshot()
            .routes.some(
              (r) => r.channelId === ids.beta && r.status === "live",
            ) && session.unread.sync().completeness === "snapshot"
        );
      }),
    )
    .toBe(true);
  await settings(page);
}
function liveMessage(
  app,
  content,
  { age = 0, replyTo, mentioned = true } = {},
) {
  const event = finalizeEvent(
    {
      kind: 9,
      content,
      created_at: Math.floor(Date.now() / 1000) - age,
      tags: [
        ["h", ids.beta],
        ...(mentioned ? [["p", app.viewer]] : []),
        ...(replyTo ? [["e", replyTo, "", "reply"]] : []),
      ],
    },
    generateSecretKey(),
  );
  app.histories.get(`primary/${ids.beta}`).push(event);
  app.relay.publish("primary", event);
  return event;
}

// Verified live receipt, recorded from the session's incoming stream. Install
// before publishing; the stream is ordered, so a fresh receipt also proves that
// every earlier row on it (including replays) was consumed.
async function recordIncoming(page) {
  await page.evaluate(() => {
    window.incomingIds = [];
    window.fixtureRelay
      .snapshot()
      .session.subscribeIncoming((batch) =>
        window.incomingIds.push(...batch.map((item) => item.messageId)),
      );
  });
}
const received = (page, id) =>
  expect
    .poll(() => page.evaluate((id) => window.incomingIds.includes(id), id))
    .toBe(true);
// Attention is a pure selector over retained relay evidence; it answers only
// while some consumer holds the message's context. Production notification
// retention is proven by the OS-count journeys that take no lease here. This
// helper is for rows production intentionally stops retaining (disabled
// category, viewed, retired): the test owns one lease after verified receipt
// and must dispose it.
async function owned(page, id, expected) {
  await received(page, id);
  await page.evaluate((id) => {
    window.testLeases ??= new Map();
    window.testLeases.set(
      id,
      window.fixtureRelay
        .snapshot()
        .session.unread.subscribe(
          { kind: "message", channelId: ids.beta, messageId: id },
          () => {},
        ),
    );
  }, id);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention(ids.beta, id)
            .status,
        id,
      ),
    )
    .toBe(expected);
  return () =>
    page.evaluate((id) => {
      window.testLeases.get(id)?.();
      window.testLeases.delete(id);
    }, id);
}
// Relay attention for a row production itself retains, such as a candidate
// held for browser permission. Taking no lease keeps retention under test.
async function retained(page, id) {
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention(ids.beta, id)
            .status,
        id,
      ),
    )
    .toBe("eligible");
}
// Run the presentation deadline and its immediate browser-permission
// continuation, rather than sleeping on wall time.
const presentation = (page) => page.clock.runFor(100);

test("real live traffic alerts once; replay/reload stay quiet and choices persist", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  await recordIncoming(page);
  expect(await systemCount(page)).toBe(0);
  const row = liveMessage(app, "Fresh mention");
  await expect.poll(() => systemCount(page)).toBe(1);
  app.relay.publish("primary", row);
  // A later fresh row on the same ordered stream proves replay consumption.
  const sentinel = liveMessage(app, "Replay consumption sentinel", {
    mentioned: false,
  });
  await received(page, sentinel.id);
  await presentation(page);
  expect(await systemCount(page)).toBe(1);
  await page.getByRole("switch", { name: "Mentions", exact: true }).uncheck();
  const muted = liveMessage(app, "Muted mention");
  const releaseMuted = await owned(page, muted.id, "eligible");
  await presentation(page);
  expect(await systemCount(page)).toBe(1);
  await releaseMuted();
  await page.reload();
  await settings(page);
  await expect(
    page.getByRole("switch", { name: "Mentions", exact: true }),
  ).not.toBeChecked();
  expect(await systemCount(page)).toBe(0);
  expect(await page.evaluate(() => window.notificationRequests)).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Recent notifications" }),
  ).toHaveCount(0);
});

test("explicit Allow releases the first fresh alert; master off preserves categories", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  await recordIncoming(page);
  await page.evaluate(() => {
    window.Notification.permission = "default";
  });
  await page
    .getByRole("button", { name: "Check permission", exact: true })
    .click();
  const row = liveMessage(app, "Permission wait");
  await retained(page, row.id);
  await presentation(page);
  expect(await systemCount(page)).toBe(0);
  expect(await page.evaluate(() => window.notificationRequests)).toBe(0);
  await page
    .getByRole("button", { name: "Allow notifications", exact: true })
    .click();
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.getByRole("switch", { name: "Mentions", exact: true }).uncheck();
  await page
    .getByRole("switch", { name: "Desktop alerts", exact: true })
    .uncheck();
  await page
    .getByRole("switch", { name: "Desktop alerts", exact: true })
    .check();
  await expect(
    page.getByRole("switch", { name: "Mentions", exact: true }),
  ).not.toBeChecked();
  const muted = liveMessage(app, "Disabled category");
  const releaseMuted = await owned(page, muted.id, "eligible");
  await presentation(page);
  expect(await systemCount(page)).toBe(1);
  await releaseMuted();
});

test("a fully visible incoming row stays quiet without publishing read intent", async ({
  page,
  app,
}) => {
  await page.clock.install();
  const following = finalizeEvent(
    {
      kind: 9,
      content: "Following row",
      created_at: Math.floor(Date.now() / 1000) + 20,
      tags: [["h", ids.beta]],
    },
    generateSecretKey(),
  );
  // Keep both rows wholly inside the viewport. A long virtualized history can
  // leave its last row fractionally clipped in WebKit, which is not "viewing".
  app.histories.set(`primary/${ids.beta}`, [following]);
  await ready(page, app);
  await recordIncoming(page);
  await page.evaluate(
    (viewer) =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "conversation",
        channelId: ids.beta,
        scope: { viewer, communityOrigin: "https://primary.example" },
      }),
    app.viewer,
  );
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  await settle(page);
  await page.bringToFront();
  await history.focus();
  // Establish the real reading lease before publishing: mounted DOM alone does
  // not prove that the document is focused and the timeline is ready to observe.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention(ids.beta, id)
            .viewing,
        following.id,
      ),
    )
    .toBe(true);
  // Controlled policy/dwell ordering, not evidence about native frame scheduling.
  // Exact-row navigation and reflow journeys below retain native rAF.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  // Live rows are newer than anything already read. `following` is dated
  // +20 s and dwell may mark through it first, so date the mention after it.
  const row = liveMessage(app, "Visible mention", { age: -21 });
  const releaseVisible = await owned(page, row.id, "eligible");
  await presentation(page);
  await expect(history.locator(`[data-message-id="${row.id}"]`)).toBeInViewport(
    { ratio: 1 },
  );
  expect(await systemCount(page)).toBe(0);
  expect(
    await page.evaluate(
      (id) =>
        window.fixtureRelay.snapshot().session.unread.attention(ids.beta, id)
          .unread,
      row.id,
    ),
  ).toBe(true);
  await releaseVisible();
  await page.clock.resume();
  await settings(page);
  await page
    .getByRole("switch", { name: "Notify while viewing", exact: true })
    .check();
  await page.evaluate(
    (viewer) =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "conversation",
        channelId: ids.beta,
        scope: { viewer, communityOrigin: "https://primary.example" },
      }),
    app.viewer,
  );
  await settle(page);
  await history.focus();
  liveMessage(app, "Allowed visible mention", { age: -22 });
  await expect.poll(() => systemCount(page)).toBe(1);
});

for (const kind of ["mention", "thread reply"]) {
  test(`live ${kind} notification focuses its exact row in the normal conversation, then ordinary dwell reads it`, async ({
    page,
    app,
  }) => {
    // Only this geometry scenario needs an overflowing Beta history.
    if (kind === "mention") {
      for (let i = 0; i < 20; i++) {
        app.append("primary", ids.beta, `Earlier message ${i}`, false, false);
      }
    }
    // Model a real prior contribution in relay history, not a client-side
    // participation/readiness override. The incoming reply itself has no p tag.
    const root =
      kind === "thread reply"
        ? app.append("primary", ids.beta, "My prior thread", false)
        : undefined;
    await ready(page, app);
    // The relay derives participation from the own root; the client holds no
    // root evidence before this. The root itself must never alert.
    expect(await systemCount(page)).toBe(0);
    const incoming = liveMessage(app, `Selected **${kind}**`, {
      mentioned: !root,
      replyTo: root?.id,
    });
    await expect.poll(() => systemCount(page)).toBe(1);
    expect(
      await page.evaluate(() => window.notificationEvents[0].options.body),
    ).toBe(`Selected ${kind}`);
    expect(await page.evaluate(() => window.notificationEvents[0].title)).toBe(
      `${incoming.pubkey.slice(0, 10)} ${root ? "replied" : "mentioned you"} in #Beta`,
    );
    const before = app.report.readWrites.length;
    const start = performance.now();
    await page.evaluate(() => window.notificationEvents[0].onclick());
    expect(app.report.readWrites.length).toBe(before);
    const surface = page.getByRole("region", {
      name: root ? "Thread messages" : "Channel message history",
      exact: true,
    });
    const row = surface.locator(`[data-message-id="${incoming.id}"]`);
    await expect(row).toBeFocused();
    await expect(row).toBeVisible();
    await expect(row.locator("strong").filter({ hasText: kind })).toHaveText(
      kind,
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    app.report.measurements.push({
      mode: `live ${kind} click to exact conversation row`,
      clickToOpenedMs: performance.now() - start,
    });
    expect(app.report.readWrites.length).toBe(before);
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    if (root) {
      await expect(
        surface.locator(`[data-message-id="${root.id}"]`),
      ).toBeAttached();
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => app.report.queries.some((q) => q.filter.depth_limit))
        .toBe(true);
    } else {
      await expect(
        page.getByRole("region", { name: "Thread messages", exact: true }),
      ).toHaveCount(0);
      expect(
        app.report.queries.filter((q) => q.filter.depth_limit),
      ).toHaveLength(0);
    }
    await expect
      .poll(() => app.report.readWrites.length)
      .toBeGreaterThan(before);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.fixtureRelay
              .snapshot()
              .session.unread.attention(ids.beta, id).unread,
          incoming.id,
        ),
      )
      .toBe(false);
    if (!root) {
      // Fractional reflow must not leave the last row clipped at maximum scroll.
      await row.evaluate((element) => {
        element.style.paddingBottom = "0.125px";
      });
      // Keep the same small history overflowing with the condensed headers,
      // including when the sidebar disappears at the narrow breakpoint.
      for (const width of [1440, 640]) {
        await page.setViewportSize({ width, height: 650 });
        await expect
          .poll(() =>
            surface.evaluate(
              (element) => element.scrollHeight > element.clientHeight,
            ),
          )
          .toBe(true);
        await end(page);
        await expect(row).toBeInViewport({ ratio: 1 });
      }
    }
  });
}

test("an installed producer shares policy and OS click navigation, including after producer disable", async ({
  page,
  app,
}) => {
  await ready(page, app);
  const input = {
    sourceKey: "plugin-event",
    target: { version: 1, kind: "settings", section: "appearance" },
  };
  expect(
    await page.evaluate((input) => window.fixtureNotify(input), input),
  ).toBe(true);
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.evaluate(() =>
    window.fixtureNavigation.open({
      version: 1,
      kind: "settings",
      section: "plugins",
    }),
  );
  await page
    .getByRole("switch", { name: "Enable Notification fixture", exact: true })
    .click();
  expect(
    await page.evaluate((input) => window.fixtureNotify(input), {
      ...input,
      sourceKey: "stale",
    }),
  ).toBe(false);
  await page.evaluate(() => window.notificationEvents[0].onclick());
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
});

test("asynchronous browser display failure reaches Settings once without redelivery", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await ready(page, app);
  liveMessage(app, "Browser display error");
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.evaluate(() => window.notificationEvents[0].onerror?.());
  await expect(
    page.getByRole("dialog", {
      name: "Buzz couldn’t send the notification",
      exact: true,
    }),
  ).toContainText("The browser could not display a notification.");
  expect(
    await page.evaluate(() => {
      const item = window.notificationEvents[0];
      return {
        closed: item.closed,
        click: item.onclick,
        error: item.onerror,
        close: item.onclose,
      };
    }),
  ).toEqual({ closed: true, click: null, error: null, close: null });
  await page
    .getByRole("button", { name: "Check permission", exact: true })
    .click();
  await page.clock.runFor(100);
  expect(await systemCount(page)).toBe(1);
});
