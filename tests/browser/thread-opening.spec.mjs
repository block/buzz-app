import { test, expect, ids } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Real scroll geometry and the first painted frame cannot be proven in jsdom.
test.use({
  pluginFixtures: true,
  exactMessages: true,
  historyCounts: { alpha: 103, beta: 0 },
});
test("seeded thread stays usable and its first loaded-history frame is at the bottom", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await open(page, app);
  await page.locator(`button[data-channel-id="${ids.beta}"]`).click();
  let release, intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  const depth = (filter) =>
    filter.depth_limit && filter["#e"]?.[0] === app.exact.root.id;
  const responses = [];
  const responseTasks = [];
  page.on("response", (response) => {
    if (!response.url().endsWith("/query")) return;
    const filter = response.request().postDataJSON()?.find(depth);
    if (filter)
      responseTasks.push(
        response.json().then((events) => {
          responses.push({
            filter,
            bounds: events
              .filter((event) => event.kind === 39007)
              .map((event) => JSON.parse(event.content)),
          });
        }),
      );
  });
  const released = new Set();
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some(
          (filter) =>
            depth(filter) && filter.thread_window && filter.until === undefined,
        )
    )
      return route.continue();
    intercepted();
    await held;
    await route.continue().catch(() => {});
  });
  const history = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  try {
    await page.evaluate(
      (value) => {
        void window.fixtureNavigation.open(value);
      },
      {
        version: 1,
        kind: "conversation",
        channelId: ids.alpha,
        messageId: app.exact.root.id,
        threadRootId: app.exact.root.id,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      },
    );
    await seen;
    await expect(
      page.getByRole("tab", { name: "Thread", exact: true }),
    ).toBeFocused();
    // The verified root arrives before the held depth read. It is usable while
    // automatic reading separately waits for the initial traversal to settle.
    await expect(history).not.toHaveAttribute("data-positioning");
    await expect(
      history.locator(`[data-message-id="${app.exact.root.id}"]`),
    ).toBeVisible();
    await expect(history.locator("[data-message-id]")).toHaveCount(1);
    await expect(history.locator("[data-thread-rows]")).not.toHaveAttribute(
      "inert",
    );
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const sample = () => {
        const el = document.querySelector('[aria-label="Thread messages"]');
        // Record the first frame containing replies, not the earlier seed frame.
        if (el && el.querySelectorAll("[data-message-id]").length > 1) {
          window.firstThreadFrame = {
            ids: [...el.querySelectorAll("[data-message-id]")].map(
              (row) => row.dataset.messageId,
            ),
            height: el.scrollHeight,
            clientHeight: el.clientHeight,
            top: el.scrollTop,
            gap: el.scrollHeight - el.clientHeight - el.scrollTop,
          };
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  } finally {
    release();
  }
  await expect(history).not.toHaveAttribute("data-positioning");
  await expect(history.locator("[data-thread-rows]")).not.toHaveAttribute(
    "inert",
  );
  await expect(history.locator("[data-message-id]")).toHaveCount(11);
  await expect
    .poll(() => page.evaluate(() => window.firstThreadFrame))
    .toBeTruthy();
  const first = await page.evaluate(() => window.firstThreadFrame);
  expect(new Set(first.ids)).toEqual(
    new Set([
      app.exact.root.id,
      ...app.exact.replies.slice(70).map((row) => row.id),
    ]),
  );
  expect(first.ids).toHaveLength(11);
  expect(first.height).toBeGreaterThan(first.clientHeight);
  expect(first.top).toBeGreaterThan(0);
  expect(Math.abs(first.gap)).toBeLessThanOrEqual(1);
  const requests = () =>
    app.report.queries
      .filter(({ filter }) => depth(filter))
      .map(({ filter }) => filter);
  await expect.poll(() => responses.length).toBe(1);
  expect(requests()).toHaveLength(1);
  expect(requests()[0]).toMatchObject({ thread_window: true, limit: 10 });
  expect(requests()[0].until).toBeUndefined();
  expect(requests()[0].thread_cursor).toBeUndefined();
  const cursor = (reply) => ({ created_at: reply.created_at, id: reply.id });
  expect(responses[0].bounds).toMatchObject([
    { has_more: true, next_cursor: cursor(app.exact.replies[70]) },
  ]);
  try {
    for (const [index, count] of [
      [70, 61],
      [20, 81],
    ]) {
      const reply = app.exact.replies[index];
      await history.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await history.hover();
      await page.mouse.wheel(0, -300);
      const pending = () =>
        app.pending.find(
          (request) =>
            depth(request.filter) &&
            request.filter.until === reply.created_at &&
            request.filter.before_id === reply.id,
        );
      await expect.poll(() => !!pending()).toBe(true);
      const request = pending();
      expect(request.filter).toMatchObject({
        thread_window: true,
        limit: 50,
        until: reply.created_at,
        before_id: reply.id,
      });
      expect(request.filter.thread_cursor).toBeUndefined();
      request.release();
      released.add(request);
      await expect(history.locator("[data-message-id]")).toHaveCount(count);
      await expect.poll(() => responses.length).toBe(index === 70 ? 2 : 3);
      expect(responses.at(-1).bounds).toMatchObject([
        {
          has_more: index === 70,
          next_cursor: index === 70 ? cursor(app.exact.replies[20]) : null,
        },
      ]);
    }
    const finalIds = await history
      .locator("[data-message-id]")
      .evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
    expect(finalIds).toHaveLength(81);
    expect(new Set(finalIds)).toEqual(
      new Set([app.exact.root.id, ...app.exact.replies.map((row) => row.id)]),
    );
    expect(requests()).toHaveLength(3);
    await testInfo.attach("strict-thread-pages", {
      body: JSON.stringify({ first, responses, finalIds }, null, 2),
      contentType: "application/json",
    });
  } finally {
    for (const request of app.pending)
      if (depth(request.filter) && !released.has(request)) request.release();
    await Promise.all(responseTasks);
  }
});
