import { test, expect, ids } from "./fixture.mjs";
import { open, settle, virtuaIdle } from "./timeline.mjs";
import {
  holdReadingFocus,
  releaseReadingFocus,
  readJournal,
} from "./reading.mjs";

// Browser-only contract: the actual Inbox DM preview joins its native composer
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
  // A DM sent before launch is not an Inbox candidate yet; this one is live.
  const selected = app.append(
    "primary",
    ids["dm-peer"],
    "Live Inbox DM",
    true,
    false,
  );
  const frontier = () =>
    app.relay.sidebarApi.frontier("primary", ids["dm-peer"]).channel;
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const dm = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: selected.content });
  await expect(dm.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);

  const base = Date.now();
  await page.clock.setFixedTime(base);
  await releaseReadingFocus(page);
  await dm.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  const history = detail.getByRole("region", {
    name: "Channel message history",
  });
  const selectedRow = history.locator(`[data-message-id="${selected.id}"]`);
  await expect(selectedRow).toBeInViewport({ ratio: 1 });
  await expect(selectedRow).toBeFocused();
  // Exact reveal acknowledges focus on its next frame. Finish that entry
  // lifecycle before moving focus to the composer or installing the dwell clock.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await virtuaIdle(page, history);
  // The click reads the channel through the selected message on the relay,
  // and the relay verdict removes the row.
  await expect.poll(frontier).toBe(selected.created_at);
  await expect(dm).toHaveCount(0);

  const filter = inbox.getByRole("combobox", { name: "Activity type" });
  await filter.focus();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 20_000);
  const composer = detail.getByRole("textbox", { name: /^Message / });
  const draft = "Unsent Inbox DM draft";
  await composer.fill(draft);
  await expect(composer).toBeFocused();

  const incoming = app.append(
    "primary",
    ids["dm-peer"],
    "Visible incoming Inbox DM",
    true,
    false,
  );
  expect(incoming.created_at).toBeGreaterThan(selected.created_at);
  const arrival = history.locator(`[data-message-id="${incoming.id}"]`);
  await expect(arrival).toBeInViewport({ ratio: 1 });
  // Let the timeline's positioning frame run, not its 300ms reading deadline.
  await page.clock.runFor(16);
  await settle(page, history);
  await expect(composer).toBeFocused();
  const dmRow = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: incoming.content });
  await expect(dmRow.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        ({ channelId, id }) =>
          window.fixtureRelay.snapshot().session.unread.attention(channelId, id)
            .viewing,
        { channelId: ids["dm-peer"], id: incoming.id },
      ),
    )
    .toBe(true);

  // Restart dwell through native focus after positioning is observed. This
  // makes 299/300ms exact rather than depending on which frame placed the row.
  await filter.focus();
  await composer.focus();
  await page.clock.runFor(299);
  expect(frontier()).toBe(selected.created_at);
  await expect(dmRow.getByRole("img", { name: "Unread" })).toBeVisible();
  await page.clock.runFor(1);
  await expect.poll(frontier).toBe(incoming.created_at);
  await expect(dmRow).toHaveCount(0);
  // Dwell reading must not close the visit or recreate its composer/draft as
  // the arrival's Inbox row comes and goes.
  await expect(selectedRow).toBeAttached();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText(draft);
  await page.clock.resume();
});

// Opening a standalone mention is not a read: the relay has no single-message
// read. The thread reader's dwell reads the channel through it instead, and the
// captured visit, with its composer and draft, outlives every row it reads.
test("a top-level mention opened from Inbox is read by dwell and keeps its visit", async ({
  page,
  app,
}) => {
  const mention = app.append(
    "primary",
    ids.beta,
    "Top-level Inbox mention",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  const writes = () => app.report.readWrites.flatMap(({ intents }) => intents);
  await open(page, app);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  const row = rows.filter({ hasText: mention.content });
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);

  // Virtual time from before the click, so opening cannot earn the dwell.
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 1_000);
  await row.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  const target = detail.locator(`[data-message-id="${mention.id}"]`);
  // Exact reveal focuses its target, then acknowledges that on the next frame.
  await expect
    .poll(async () => {
      await page.clock.runFor(16);
      return target.evaluate((element) => element === document.activeElement);
    })
    .toBe(true);
  await page.clock.runFor(16);
  await expect(target).toBeInViewport({ ratio: 1 });
  const filter = inbox.getByRole("combobox", { name: "Activity type" });
  await filter.focus();
  expect(writes()).toEqual([]);
  expect(await readJournal(page)).toEqual({ pending: [], manual: [] });
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();

  const composer = detail.getByRole("textbox", { name: "Reply to thread" });
  const draft = "Unsent Inbox thread draft";
  await composer.fill(draft);
  await expect(composer).toBeFocused();
  await page.clock.runFor(299);
  expect(writes()).toEqual([]);
  await page.clock.runFor(1);
  await expect.poll(writes).toEqual([
    {
      type: "mark_through",
      target: { channel_id: ids.beta },
      message_id: mention.id,
    },
  ]);
  await expect(row).toHaveCount(0);

  // A reply arriving in the same visit lists a fresh row; reading it by dwell
  // keeps the visit too.
  const reply = app.append(
    "primary",
    ids.beta,
    "Fresh reply in the open thread",
    true,
    false,
    mention.id,
    undefined,
    [["p", app.viewer]],
  );
  const arrival = detail.locator(`[data-message-id="${reply.id}"]`);
  await expect(arrival).toBeInViewport({ ratio: 1 });
  await page.clock.runFor(16);
  const fresh = rows.filter({ hasText: reply.content });
  await expect(fresh.getByRole("img", { name: "Unread" })).toBeVisible();
  await filter.focus();
  await composer.focus();
  await page.clock.runFor(299);
  expect(writes()).toHaveLength(1);
  await page.clock.runFor(1);
  await expect
    .poll(() =>
      app.relay.sidebarApi
        .frontier("primary", ids.beta)
        .threads.get(mention.id),
    )
    .toBe(reply.created_at);
  expect(writes()).toContainEqual({
    type: "mark_through",
    target: { channel_id: ids.beta, root_id: mention.id },
    message_id: reply.id,
  });
  await expect(fresh).toHaveCount(0);
  await expect(target).toBeAttached();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText(draft);
  await page.clock.resume();
});
