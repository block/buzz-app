import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  pluginFixtures: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Response room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  screenshot: "off",
});

// Exercises the bundled Inbox, real reply composer, relay echo and persisted
// history together. Semantic reply permutations belong in InboxPage.test.tsx.
test("Unresponded remains after reading, clears on a real reply, and returns for a fresh mention", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const filter = inbox.getByRole("combobox", { name: "Filters" });
  const choose = async (name) => {
    await filter.click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await choose("Unresponded only");
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  await expect(
    detail.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (channelId) =>
          window.fixtureRelay
            .snapshot()
            .session.unread.snapshot({ kind: "channel", channelId })
            .observedCount,
        channel,
      ),
    )
    .toBe(0);
  await expect(rows).toHaveCount(1); // Reading does not count as responding.
  await detail
    .getByRole("textbox", { name: "Reply to thread" })
    .fill("Handled, thanks");
  await detail.getByRole("button", { name: "Send message" }).click();
  await expect(
    detail.getByText("Handled, thanks", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(
    inbox.getByText("No unresponded activity in this view"),
  ).toBeVisible();
  await detail.getByRole("button", { name: "Close thread" }).click();
  await choose("All");
  await expect(rows).toHaveCount(1);
  await choose("Unread only");
  await expect(rows).toHaveCount(0);
  await choose("Unresponded only");
  await expect(rows).toHaveCount(0);
  app.append(
    "primary",
    channel,
    "Another decision needed",
    true,
    false,
    app.inboxWindow.root.id,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows).toHaveCount(1);
  await page.reload();
  await openPage(page, "Inbox");
  await choose("Unresponded only");
  await expect(rows).toHaveCount(1);
});

// The production broker/session must fetch a response beyond its cold unread
// sample without relying on opening detail. This is a real finite-read boundary.
test("cold Unresponded checks later replies before showing older mentions", async ({
  page,
  app,
}) => {
  const root = app.inboxWindow.root.id;
  const response = app.append(
    "primary",
    channel,
    "Already answered before this visit",
    false,
    true,
    app.inboxWindow.replies[0].id,
  );
  for (let index = 0; index < 500; index++)
    app.append(
      "primary",
      channel,
      `Newer unrelated activity ${index}`,
      false,
      false,
    );
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  const choose = async (control, name) => {
    await inbox.getByRole("combobox", { name: control }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await choose("Activity type", "Mentions");
  // The cold sample omits the root too; exact history checking regroups these.
  await expect(rows).toHaveCount(app.inboxWindow.replies.length);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = window.fixtureRelay.snapshot().session;
        return (
          session.inboxFeed.snapshot().status === "ready" &&
          session.unread.inbox().status === "ready"
        );
      }),
    )
    .toBe(true);
  app.relay.holdUnread();
  const beforeQueries = app.report.queries.length;
  let releasedAt;
  try {
    await choose("Filters", "Unresponded only");
    await expect
      .poll(() => app.report.unreadHolds.some((hold) => hold.pending))
      .toBe(true);
    await expect(inbox.getByText("Checking recent activity…")).toBeVisible();
    await expect(rows).toHaveCount(0);
  } finally {
    releasedAt = performance.now();
    app.relay.releaseUnread();
  }
  await expect(
    inbox.getByText("No unresponded mentions in this view"),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(inbox.getByRole("region", { name: "Inbox detail" })).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay
            .snapshot()
            .session.inboxFeed.snapshot()
            .checkedResponses.includes(id),
        response.id,
      ),
    )
    .toBe(true);
  const checks = app.report.queries
    .slice(beforeQueries)
    .filter(({ filter }) => filter.thread_window === true);
  expect(checks).toHaveLength(1); // Signed bounds prove this canonical window is complete.
  app.report.unrespondedPerformance = {
    checkedRoots: 1,
    responseReads: checks.length,
    settleMs: performance.now() - releasedAt,
  };
  const progress = app.append(
    "primary",
    channel,
    "Ordinary progress after your answer",
    true,
    false,
    root,
  );
  await choose("Activity type", "Threads");
  await expect(rows).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay
            .snapshot()
            .session.unread.inbox()
            .items.some(
              (item) => item.messageIds.includes(id) && item.unresponded,
            ),
        progress.id,
      ),
    )
    .toBe(true);
  await choose("Activity type", "Mentions");
  await expect(rows).toHaveCount(0);
});

// A second composition boundary checks verified agent classification while the
// complete activity/sender matrix stays in the mounted Inbox test.
test.describe("agent mentions", () => {
  test.use({ inboxSessionAgent: true, inboxDm: true });
  test("Unresponded combines sender and activity filters across a real reply", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const rows = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem");
    const choose = async (control, name) => {
      await inbox.getByRole("combobox", { name: control }).click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    await expect(rows).toHaveCount(2);
    app.append(
      "primary",
      "dm-peer",
      "DM recipient without a mention request",
      true,
      false,
      undefined,
      undefined,
      [["p", app.viewer]],
    );
    await choose("Filters", "Unresponded only");
    await expect(rows).toHaveCount(2);
    await choose("Sender", "Humans");
    await expect(rows).toHaveCount(0);
    await choose("Sender", "Agents");
    await expect(rows).toHaveCount(2);
    await choose("Activity type", "DMs");
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: /^Open / }).click();
    const dmDetail = inbox.getByRole("region", { name: "Inbox detail" });
    const dmEditor = dmDetail.getByRole("textbox", { name: /^Message / });
    await expect(dmEditor).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.fixtureRelay.snapshot().session.unread.snapshot({
              kind: "channel",
              channelId: "dm-peer",
            }).observedCount,
        ),
      )
      .toBe(0);
    await expect(rows).toHaveCount(1);
    await dmEditor.fill("Direct message handled");
    await dmDetail.getByRole("button", { name: "Send message" }).click();
    await expect(
      dmDetail.getByText("Direct message handled", { exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(0);
    await dmDetail.getByRole("button", { name: "Close detail" }).click();
    app.append(
      "primary",
      "dm-peer",
      "Fresh direct message",
      true,
      false,
      undefined,
      undefined,
      [["p", app.viewer]],
    );
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Fresh direct message");
    await choose("Activity type", "Mentions");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Inbox strict reply");
    await expect(rows).not.toContainText("Fresh direct message");
    await choose("Activity type", "All activity");
    await expect(rows).toHaveCount(2);
    await choose("Sender", "Humans");
    await expect(rows).toHaveCount(0);
    await choose("Sender", "Agents");
    await expect(rows).toHaveCount(2);
    await choose("Activity type", "Mentions");
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          (channelId) =>
            window.fixtureRelay
              .snapshot()
              .session.unread.snapshot({ kind: "channel", channelId })
              .observedCount,
          channel,
        ),
      )
      .toBe(0);
    await expect(rows).toHaveCount(1);
    await detail
      .getByRole("textbox", { name: "Reply to thread" })
      .fill("Agent request handled");
    await detail.getByRole("button", { name: "Send message" }).click();
    await expect(
      detail.getByText("Agent request handled", { exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(0);
    await detail.getByRole("button", { name: "Close thread" }).click();
    await choose("Activity type", "Threads");
    await expect(rows).toHaveCount(0);
    app.append(
      "primary",
      channel,
      "Ordinary agent progress",
      true,
      false,
      app.inboxWindow.root.id,
    );
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Ordinary agent progress");
    await choose("Activity type", "Mentions");
    await expect(rows).toHaveCount(0);
    app.append(
      "primary",
      channel,
      "Fresh agent request",
      true,
      false,
      app.inboxWindow.root.id,
      undefined,
      [["p", app.viewer]],
    );
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Fresh agent request");
    await choose("Sender", "Everyone");
    await expect(rows).toHaveCount(1);
    await choose("Sender", "Humans");
    await expect(rows).toHaveCount(0);
    await choose("Sender", "Agents");
    await choose("Activity type", "DMs");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Fresh direct message");
    await choose("Activity type", "All activity");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Fresh direct message" })).toHaveCount(
      1,
    );
    // All activity keeps the first unread preview; Mentions projected the later mention.
    await expect(
      rows.filter({ hasText: "Ordinary agent progress" }),
    ).toHaveCount(1);
  });
});
