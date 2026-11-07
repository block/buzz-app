import { finalizeEvent } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const localAgentKey =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

// One real app-composition/geometry journey. Matrices stay in the host and
// adapter tests; only native identity custody and the agent's external work are fake.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  localAgentActivity: true,
});
// Live agent work has one place: its conversation's end. A message shows only
// what happened to it (failed, stopped), never the work in progress.
const endOf = (scope) => scope.locator("[data-conversation-activity]");
const liveTrigger = (scope) =>
  endOf(scope).locator("[data-agent-activity-trigger]");

test("local agent receipt, work and failure agree across sidebar, thread and exact message", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const agent = localAgentKey;
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const rootRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await rootRow.hover();
  await rootRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  // Generated viewer identity, signed through the same live relay fixture as chat.
  const send = (text) => {
    const event = app.sign({
      kind: 9,
      content: text,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
        ["p", agent],
      ],
    });
    app.relay.publish("primary", event);
    return event;
  };
  const first = send("First local request");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  const second = send("Second local request");
  const secondRow = thread.locator(`[data-message-id="${second.id}"]`);
  const working = liveTrigger(thread);
  await expect(working).toHaveAccessibleName("Activity: Local tester working");
  await expect(
    working.locator('[data-state="waiting"] > span').first(),
  ).toHaveCSS("animation-duration", "2.4s");
  // Neither request shows the work itself.
  await expect(
    thread.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(0);
  const sidebar = page.locator(
    '[data-channel-id="alpha"] [data-channel-working]',
  );
  // Neither request has reported a first step yet, so the sidebar breathes.
  await expect(sidebar).toHaveAccessibleName(/Local tester waiting in Alpha/);
  const summary = rootRow.getByRole("button", { name: /^View thread:/ });
  await expect(summary).toContainText("replies");
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    first.id,
  );
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await page.evaluate((id) => window.localAgentFixture.handover(id), second.id);
  await expect(working).toHaveAccessibleName("Reading notes.txt");
  // One working indicator for the thread; its dots stay visible without
  // motion. jsdom cannot prove CSS visibility.
  await expect(thread.locator("[data-agent-activity-trigger]")).toHaveCount(1);
  const dots = working.locator('[data-state="working"] > span');
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dots).toHaveCount(3);
  await expect(dots.first()).toBeVisible();
  await expect(dots.first()).toHaveCSS("animation-name", "none");
  await page.screenshot({
    path: testInfo.outputPath("local-working-reduced-motion.png"),
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Work remains after run() returns; only actual completion settles it.
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, false),
    second.id,
  );
  // The failure is what happened to that message: it stays on it.
  const outcome = secondRow.getByRole("button", {
    name: /^View agent activity:/,
  });
  await expect(
    secondRow.getByText("Couldn’t finish", { exact: true }),
  ).toBeVisible();
  await expect(outcome).toHaveText("Details");
  await expect(outcome).toHaveAccessibleName(
    /Local tester, Fixture provider unavailable/,
  );
  await expect(working).toHaveCount(0);
  await expect(sidebar).toHaveCount(0);
  await expect(summary.locator("[data-thread-working]")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await outcome.focus();
      await page.keyboard.press("Enter");
      const popup = page.getByRole("dialog", {
        name: "Agent activity",
        exact: true,
      });
      await expect(popup).toContainText("Fixture provider unavailable");
      await expect(popup).not.toHaveAttribute("data-starting-style", "");
      const box = await popup.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // Errors stay on one line; the full reason remains in the accessible name.
      await expect(popup.getByText("Fixture provider unavailable")).toHaveCSS(
        "white-space",
        "nowrap",
      );
      const dismiss = await popup
        .getByRole("button", { name: /^Dismiss error from / })
        .boundingBox();
      expect(dismiss.x + dismiss.width).toBeLessThanOrEqual(box.x + box.width);
      const retry = await popup
        .getByRole("button", { name: /^Retry / })
        .boundingBox();
      expect(retry.x).toBeGreaterThanOrEqual(box.x);
      expect(retry.x + retry.width).toBeLessThanOrEqual(dismiss.x);
      await page.screenshot({
        path: testInfo.outputPath(`local-activity-${colorScheme}-${width}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await expect(outcome).toBeFocused();
    }
  }
  // Retry asks the agent again with the same message: its outcome retires,
  // the work shows at the thread's end, and focus stays in the message.
  await outcome.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Retry Local tester" }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.localAgentFixture.pending().filter((row) => row === id).length,
        second.id,
      ),
    )
    .toBe(2);
  await expect(outcome).toHaveCount(0);
  await expect(working).toHaveAccessibleName("Activity: Local tester working");
  await expect(
    secondRow.getByRole("button", { name: "More message actions" }),
  ).toBeFocused();
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, false),
    second.id,
  );
  await expect(
    secondRow.getByText("Couldn’t finish", { exact: true }),
  ).toBeVisible();
  // Dismiss hides only this device's view of the error; focus stays in the row.
  await outcome.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Dismiss error from / }).click();
  await expect(outcome).toHaveCount(0);
  await expect(page.locator("body")).not.toBeFocused();
});

test("Stop at a thread's end ends its local work quietly and notes it on the request", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const rootRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await rootRow.hover();
  await rootRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const event = app.sign({
    kind: 9,
    content: "Request to stop",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
      ["p", localAgentKey],
    ],
  });
  app.relay.publish("primary", event);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  await page.evaluate((id) => window.localAgentFixture.handover(id), event.id);
  const row = thread.locator(`[data-message-id="${event.id}"]`);
  const working = liveTrigger(thread);
  await expect(working).toBeVisible();
  await expect(
    row.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(0);
  await page.evaluate(
    (id) =>
      window.localAgentFixture.step(
        id,
        "Read",
        "src/features/agents/a-very-long-path/with-many-segments/notes-for-the-stop-button.txt",
      ),
    event.id,
  );
  await working.click();
  const popup = page.getByRole("dialog", { name: "Working now", exact: true });
  const stop = popup.getByRole("button", {
    name: "Stop Local tester",
    exact: true,
  });
  await expect(stop).toBeVisible();
  await expect(stop).toHaveText("Stop");
  await expect(popup).not.toHaveAttribute("data-starting-style", "");
  const [box, frame] = await Promise.all([
    stop.boundingBox(),
    popup.boundingBox(),
  ]);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
  await page.screenshot({
    path: testInfo.outputPath("local-activity-stop.png"),
  });
  await stop.focus();
  await stop.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.stopped()))
    .toEqual([event.id]);
  // Stopped work is neither finished nor failed: its live activity goes, a
  // toast confirms the stop, and the message keeps a note that it stopped.
  await expect(working).toHaveCount(0);
  await expect(
    page.getByText("Stopped Local tester", { exact: true }),
  ).toBeVisible();
  const note = row.getByText("Local tester · Stopped", { exact: true });
  await expect(note).toBeVisible();
  await row.screenshot({
    path: testInfo.outputPath("local-activity-stopped.png"),
  });
  await expect(
    page.locator('[data-channel-id="alpha"] [data-channel-working]'),
  ).toHaveCount(0);
});

// A top-level request is its own conversation until it has replies: its work
// is the channel's, shown at the channel's end beside recorded history.
test("Stop at a channel's end stops its work while recorded history stays history", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const request = app.sign({
    kind: 9,
    content: "Stop this from the channel",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["p", localAgentKey],
    ],
  });
  app.relay.publish("primary", request);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  await page.evaluate(
    (id) => window.localAgentFixture.handover(id),
    request.id,
  );
  const timeline = page.locator("[data-channel-timeline]");
  const row = timeline.locator(`[data-message-id="${request.id}"]`);
  const working = liveTrigger(timeline);
  await expect(working).toBeVisible();
  await expect(
    row.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(0);
  const key = new Uint8Array(32);
  key[31] = 1;
  for (const [index, content] of [
    "Checking the request",
    "Checking the final detail",
  ].entries()) {
    app.relay.publish(
      "primary",
      finalizeEvent(
        {
          kind: 40002,
          content,
          created_at: request.created_at + index + 1,
          tags: [
            ["h", "alpha"],
            ["audience", "agents"],
          ],
        },
        key,
      ),
    );
  }
  const history = page.getByRole("button", {
    name: /Show activity history:.*Checking the final detail/,
  });
  await expect(history).toBeVisible();
  await history.click();
  await expect(
    page.getByText("Checking the request", { exact: true }),
  ).toBeVisible();
  // History keeps its transcript link; Stop is only at the conversation's end.
  await expect(
    page.getByRole("button", { name: "View transcript", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop Local tester", exact: true }),
  ).toHaveCount(0);
  await expect(working).toBeVisible();
  app.relay.publish(
    "primary",
    app.sign({
      kind: 9,
      content: "Keep going while I check the result",
      created_at: request.created_at + 3,
      tags: [["h", "alpha"]],
    }),
  );
  await expect(
    page.getByText("Keep going while I check the result", { exact: true }),
  ).toBeVisible();
  await expect(working).toBeVisible();
  await working.click();
  const popup = page.getByRole("dialog", { name: "Working now", exact: true });
  // The request has no replies, so its work is the channel's, not a thread's.
  await expect(popup).not.toContainText("Thread");
  await popup
    .getByRole("button", { name: "Stop Local tester", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.stopped()))
    .toEqual([request.id]);
  await expect(working).toHaveCount(0);
  await expect(
    page.getByText("Stopped Local tester", { exact: true }),
  ).toBeVisible();
  const note = row.locator("[data-activity-stopped]");
  await expect(note).toContainText("Local tester · Stopped");
  const [bounds, noted] = await Promise.all([
    row.boundingBox(),
    note.boundingBox(),
  ]);
  expect(noted.x).toBeGreaterThanOrEqual(bounds.x);
  expect(noted.x + noted.width).toBeLessThanOrEqual(bounds.x + bounds.width);
});

// Real host composition: once a request has a thread, its work moves from the
// channel's end into that thread's summary, and the thread's end shows it.
test("a request's work moves from the channel's end into its thread once the thread exists", async ({
  page,
  app,
}) => {
  await open(page, app);
  const agent = localAgentKey;
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const request = app.sign({
    kind: 9,
    content: "Top-level activity request",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["p", agent],
    ],
  });
  app.histories.get("primary/alpha").push(request);
  app.relay.publish("primary", request);
  const timeline = page.locator("[data-channel-timeline]");
  const row = timeline.locator(`[data-message-id="${request.id}"]`);
  const summary = row.getByRole("button", { name: /^View thread:/ });
  await expect(liveTrigger(timeline)).toBeVisible();
  await expect(
    row.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(0);
  app.threadSummary(request.id, [agent], 1);
  await expect(summary).toContainText("1 reply");
  await expect(row.locator("[data-thread-summary]")).toHaveCount(1);
  await page.evaluate(
    (id) => window.localAgentFixture.handover(id),
    request.id,
  );
  const reply = app.sign({
    kind: 9,
    content: "Follow-up activity request",
    created_at: request.created_at + 1,
    tags: [
      ["h", "alpha"],
      ["e", request.id, "", "root"],
      ["e", request.id, "", "reply"],
      ["p", agent],
    ],
  });
  app.histories.get("primary/alpha").push(reply);
  app.relay.publish("primary", reply);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await expect(summary).toHaveAccessibleName(/Local tester (working|waiting)/);
  await expect(liveTrigger(timeline)).toHaveCount(0);
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    request.id,
  );
  await expect(summary).toContainText("1 reply");
  await summary.click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    liveTrigger(thread).locator('[data-state="waiting"]'),
  ).toBeVisible();
  await expect(
    thread.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(0);
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    reply.id,
  );
  await expect(liveTrigger(thread)).toHaveCount(0);
  await expect(summary).toContainText("1 reply");
});

for (const focusOn of ["indicator", "composer"]) {
  test(`finishing work at a thread's end retires its controls without stealing focus: ${focusOn}`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(() => page.evaluate(() => !!window.localAgentFixture))
      .toBe(true);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    await row.hover();
    await row.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const composer = thread.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(composer).toBeVisible();
    const request = app.sign({
      kind: 9,
      content: "Finish while focused",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "reply"],
        ["p", localAgentKey],
      ],
    });
    app.relay.publish("primary", request);
    const working = liveTrigger(thread);
    await expect(working).toBeVisible();
    if (focusOn === "indicator") await working.focus();
    else await composer.focus();
    await page.evaluate(
      (id) => window.localAgentFixture.finish(id, true),
      request.id,
    );
    await expect(working).toHaveCount(0);
    if (focusOn === "composer") await expect(composer).toBeFocused();
    else
      await expect
        .poll(() =>
          page.evaluate(() => {
            const active = document.activeElement;
            return !!active?.closest("[data-message-id]");
          }),
        )
        .toBe(true);
  });
}

test("the published-activity tab shows turns its agent published", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  // Activity is best effort; publish only once the owner's observer route is live.
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  // The fixture agent's key is the curve generator, so secret key 1 signs as it.
  const key = new Uint8Array(32);
  key[31] = 1;
  const frame = (kind, payload) => ({
    kind,
    seq: 1,
    timestamp: new Date().toISOString(),
    channelId: "alpha",
    sessionId: "S",
    turnId: "published",
    payload,
  });
  app.observer(frame("turn_started", {}), key);
  app.observer(
    frame("acp_read", {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "S",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "Published reply" },
        },
      },
    }),
    key,
  );
  await page
    .getByRole("form", { name: "Send a message to Alpha", exact: true })
    .locator("..")
    .getByRole("button", { name: /^Activity: .+ working$/ })
    .hover();
  const popup = page.getByRole("dialog", { name: "Working now", exact: true });
  // The channel is already shown, so the agent's row opens its activity.
  await popup
    .getByRole("button", { name: /^View .*Local tester.* activity$/ })
    .click();
  await expect(
    page.getByRole("tab", { name: "Activity", selected: true }),
  ).toBeVisible();
  await expect(
    page.locator("summary").getByText("Published reply", { exact: true }),
  ).toBeVisible();
  // Real browser layout is required: jsdom cannot catch flex min-content collapse.
  const path = "src/features/agents/ActivityTranscript.tsx";
  app.observer(
    frame("acp_read", {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "S",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "layout-tool",
          kind: "read",
          title: path,
          status: "completed",
          rawInput: { path },
        },
      },
    }),
    key,
  );
  const toolSummary = page.locator("summary").filter({ hasText: path });
  await toolSummary.click();
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    for (const size of ["150%", "200%"]) {
      await page.evaluate((value) => {
        document.documentElement.style.fontSize = value;
      }, size);
      await expect
        .poll(async () => {
          const label = await toolSummary
            .getByText(path, { exact: true })
            .boundingBox();
          return label?.width ?? 0;
        })
        .toBeGreaterThan(100);
      await expect
        .poll(async () => (await toolSummary.boundingBox())?.height ?? Infinity)
        .toBeLessThan(300);
      // The host inset, hero, and footer must agree after the dock narrows it.
      await expect
        .poll(() =>
          toolSummary.evaluate((summary) => {
            let host = summary.parentElement;
            while (host && getComputedStyle(host).overflowY !== "auto")
              host = host.parentElement;
            if (!host) throw new Error("Missing activity scrollport");
            return host.scrollWidth - host.clientWidth;
          }),
        )
        .toBe(0);
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("font-size");
  });
  await page.setViewportSize({ width: 1280, height: 950 });
  // A turn's thread label opens that thread.
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  app.observer(
    {
      ...frame("turn_started", { threadRootEventId: root.id }),
      sessionId: "T",
      turnId: "threaded",
    },
    key,
  );
  await page
    .getByRole("button", { name: `Thread ${root.id.slice(0, 8)}`, exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "Thread", exact: true })
      .getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
});
