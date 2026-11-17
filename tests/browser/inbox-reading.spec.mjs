import { activityRow, conversationList } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle, virtuaIdle } from "./timeline.mjs";
import {
  holdReadingFocus,
  releaseReadingFocus,
  readJournal,
} from "./reading.mjs";

// Browser-only contract: the actual Inbox DM tab joins its native composer
// focus to fully visible timeline rows. RTL cannot establish viewport/focus dwell.
test.use({
  productionBroker: true,
  readState: true,
  inboxDm: true,
  pluginFixtures: true, // Read-only shared-owner readiness/observation barriers.
  historyCounts: { alpha: 1, beta: 1 },
});

test("Inbox DM composer focus reads a visible peer arrival after dwell without reselecting", async ({
  page,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sync = window.fixtureRelay.snapshot().session.unread.sync();
        return { status: sync.status, completeness: sync.completeness };
      }),
    )
    .toEqual({ status: "reconciled", completeness: "snapshot" });
  await activityRow(page).click();
  const dm = conversationList(page).locator('[data-activity-row="dm-peer"]');
  await expect(dm).toContainText("Inbox DM fixture reply");
  await expect(dm.getByRole("img", { name: "Unread" })).toBeVisible();

  // Give the next fixture arrival a timestamp beyond the captured selection
  // cutoff without moving the browser outside the broker's signing clock.
  const base = Date.now();
  const cutoff = Math.floor(base / 1000);
  const selected = app.histories.get("primary/dm-peer").at(-1);
  const seed = app.sign({
    kind: 9,
    created_at: cutoff,
    tags: [["h", "dm-peer"]],
    content: "Our current DM context",
  });
  app.histories.get("primary/dm-peer").push(seed);
  app.relay.publish("primary", seed);
  await page.clock.setFixedTime(base);
  await releaseReadingFocus(page);
  await dm.locator("[data-conversation-row]").click();
  const detail = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const history = detail.getByRole("region", {
    name: "Channel message history",
  });
  // A DM opens whole, at its latest messages.
  const selectedRow = history.locator(`[data-message-id="${selected.id}"]`);
  await expect(selectedRow).toBeInViewport({ ratio: 1 });
  // Finish the opening frames before moving focus to the composer or
  // installing the dwell clock.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await virtuaIdle(page, history);
  await expect
    .poll(async () => (await readJournal(page)).state.frontiers["dm-peer"])
    .toBe(cutoff);
  await expect(dm.getByRole("img", { name: "Unread" })).toHaveCount(0);

  const filter = page.getByRole("button", {
    name: "Filter and sort conversations",
    exact: true,
  });
  await filter.focus();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 20_000);
  const composer = detail.getByRole("textbox", { name: /^Message / });
  const draft = "Unsent Inbox DM draft";
  await composer.fill(draft);
  await expect(composer).toBeFocused();

  const incoming = app.append(
    "primary",
    "dm-peer",
    "Visible incoming Inbox DM",
    true,
    false,
  );
  expect(incoming.created_at).toBeGreaterThan(cutoff);
  const arrival = history.locator(`[data-message-id="${incoming.id}"]`);
  await expect(arrival).toBeInViewport({ ratio: 1 });
  // Let the timeline's positioning frame run, not its 300ms reading deadline.
  await page.clock.runFor(16);
  await settle(page, history);
  await expect(composer).toBeFocused();
  // The open conversation's row stays quiet; its unread count is the evidence.
  const unreadCount = () =>
    page.evaluate(
      () =>
        window.fixtureRelay.snapshot().session.unread.snapshot({
          kind: "channel",
          channelId: "dm-peer",
        }).observedCount,
    );
  await expect.poll(unreadCount).toBe(1);
  await expect(dm.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("dm-peer", id)
            .viewing,
        incoming.id,
      ),
    )
    .toBe(true);

  // Restart dwell through native focus after positioning is observed. This
  // makes 299/300ms exact rather than depending on which frame placed the row.
  await filter.focus();
  await composer.focus();
  await page.clock.runFor(299);
  expect((await readJournal(page)).state.frontiers["dm-peer"]).toBe(cutoff);
  expect(await unreadCount()).toBe(1);
  await page.clock.runFor(1);
  // Reading a DM reads all of it, through the newest message, with one
  // channel mark rather than a mark per message.
  await expect
    .poll(async () => (await readJournal(page)).state.frontiers["dm-peer"])
    .toBe(incoming.created_at);
  await expect.poll(unreadCount).toBe(0);
  expect(
    (await readJournal(page)).state.frontiers[`msg:${incoming.id}`],
  ).toBeUndefined();
  // Reading must not recreate the composer/draft as the Inbox row's
  // representative changes.
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText(draft);
  await page.clock.resume();
});
