import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { conversationList, openPage, rail } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only: the list opens its rows in the reader beside it. Each thread
// opened from it gets its own side tab; a DM opens as its whole conversation.
test("Inbox rows open their conversation beside the list, a tab per thread", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, app);
  await openPage(page, "Activity");
  const list = conversationList(page);
  const side = page.getByRole("tablist", { name: "Panel tabs" });
  const events = list.locator("[data-activity-event]");
  const dmRow = list.locator('[data-activity-row="dm-peer"]');
  const expectList = async () => {
    await expect(list).toBeVisible();
    await expect(events).toHaveCount(2);
    await expect(dmRow).toHaveCount(1);
  };
  await expectList();
  await expect(side).toHaveCount(0);
  const alpha = page.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  const thread = alpha.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  const reply = alpha.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const roots = app.histories.get("primary/alpha");
  const root = (content) => roots.find((event) => event.content === content);

  await events
    .filter({ hasText: "Unread reply 1" })
    .locator("[data-conversation-row]")
    .click();
  await expect(side.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(
    side.getByRole("tab", { name: "Thread root 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 1").id}"]`).last(),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: "Unread reply 1" }),
  ).toBeInViewport();
  await expect(reply).toBeVisible();
  await expectList();

  await reply.fill("Thread root 1 draft");
  // Thread root 0's row shows whichever of its replies loaded as newest.
  const other = events
    .filter({ hasText: "#Alpha" })
    .filter({ hasNotText: "Unread reply 1" });
  const shown = (await other.textContent()).includes("Broadcast reply")
    ? "Broadcast reply"
    : "Unread reply 0";
  await other.locator("[data-conversation-row]").click();
  // Each thread opens its own tab; the new one is selected.
  await expect(side.getByRole("tab")).toHaveText([
    "Thread root 1",
    "Thread root 0",
  ]);
  await expect(
    side.getByRole("tab", { name: "Thread root 0", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 0").id}"]`).last(),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: shown }),
  ).toBeInViewport();
  await expect(thread.getByText("Unread reply 1", { exact: true })).toHaveCount(
    0,
  );
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveText("Thread root 1 draft");
  await expectList();

  await dmRow.locator("[data-conversation-row]").click();
  // A DM opens its whole conversation in place of the channel, not a thread.
  const dm = page.getByRole("article", { name: "Conversation", exact: true });
  await expect(
    dm.getByRole("heading", { name: "Alice Fixture", exact: true }),
  ).toBeVisible();
  await expect(alpha).toHaveCount(0);
  await expect(side).toHaveCount(0);
  await expect(
    dm
      .getByRole("region", { name: "Channel message history" })
      .getByText("Inbox DM fixture reply", { exact: true }),
  ).toBeVisible();
  await expect(dm.getByRole("complementary", { name: "Thread" })).toHaveCount(
    0,
  );
  await expect(dm.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await expectList();

  // Reopening the first thread selects its tab, with its draft kept.
  await events
    .filter({ hasText: "Unread reply 1" })
    .locator("[data-conversation-row]")
    .click();
  await expect(
    side.getByRole("tab", { name: "Thread root 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(reply).toHaveText("Thread root 1 draft");
});

// Browser-only: the thread's header takes its conversation to its channel.
// Real layout decides that the channel's root row is in view and painted beside
// the focused thread.
test.describe("with the thread's root beyond the channel's newest page", () => {
  test.use({ threadUnreadNewerRows: 30 });
  test("a thread's header opens its channel beside its root", async ({
    page,
    app,
  }) => {
    // Wide enough that the thread docks beside the channel rather than
    // covering it, which would leave the channel inert and unmarked.
    await page.setViewportSize({ width: 1680, height: 900 });
    await open(page, app);
    await openPage(page, "Activity");
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    await conversationList(page)
      .locator("[data-activity-event]")
      .filter({ hasText: "Unread reply 1" })
      .locator("[data-conversation-row]")
      .click();
    // The arrival cue is transient: observe it before the channel opens.
    await page.evaluate((id) => {
      window.rootMarked = false;
      new MutationObserver(() => {
        const row = document.querySelector(
          `[data-channel-timeline="alpha"] [data-message-id="${id}"]`,
        );
        if (
          row &&
          [row, ...row.querySelectorAll("[data-highlight-surface]")].some(
            (surface) => /messageHighlight/.test(surface.className),
          )
        )
          window.rootMarked = true;
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    }, root.id);
    // The thread's header shows its channel beside it.
    await page
      .getByRole("button", { name: "Show #Alpha", exact: true })
      .click();
    const target = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target,
    );
    expect(target.threadRootId).toBe(root.id);
    // The channel lands on the thread's root.
    expect(target.messageId).toBe(root.id);
    // The thread stays open beside it.
    const reply = page
      .getByRole("region", { name: "Thread messages", exact: true })
      .locator(`[data-message-id="${root.id}"]`)
      .last();
    await expect(reply).toContainText("Thread root 1");
    // Beside it, the channel shows its newest messages while it reads the
    // older page the fixture holds, then moves to the thread's root.
    await expect.poll(() => app.pending.length).toBe(1);
    expect(app.pending[0].channel).toBe("alpha");
    await expect(page.locator('[data-channel-timeline="alpha"]')).toBeVisible();
    app.pending.shift().release();
    const head = app.report.queries.find(
      ({ community, filter }) =>
        community === "primary" &&
        filter.top_level &&
        filter.until === undefined &&
        filter["#h"].includes("alpha"),
    );
    expect(
      app.histories.get("primary/alpha").at(-head.filter.limit).created_at,
      "the root predates the channel's newest page",
    ).toBeGreaterThan(root.created_at);
    await expect(
      page
        .locator('[data-channel-timeline="alpha"]')
        .locator(`[data-message-id="${root.id}"]`),
    ).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.rootMarked)).toBe(true);
    await expect(reply).toBeVisible();
  });
});

// Browser-only: grouped reaction rows render real emoji glyphs, including a
// fetched custom emoji, and open the exact message in the real reader.
test("Reaction activity ignores Unread and opens the exact message", async ({
  page,
  app,
}, testInfo) => {
  const history = app.histories.get("primary/alpha");
  const target = history.find(
    (event) => event.kind === 9 && event.pubkey === app.viewer,
  );
  expect(target).toBeTruthy();
  const reactor = generateSecretKey();
  const reaction = finalizeEvent(
    {
      kind: 7,
      content: "❤️",
      created_at: target.created_at + 100,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
      ],
    },
    reactor,
  );
  history.push(reaction);
  app.relay.publish("primary", reaction, { requireSubscriber: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, app);
  await openPage(page, "Activity");
  const team = page.getByRole("region", { name: "Team list", exact: true });
  // Unread only hides read conversations; reactions are never unread, so
  // their view still lists them.
  await team
    .getByRole("button", { name: "Filter and sort conversations", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Unread only", exact: true })
    .click();
  await team.getByRole("tab", { name: "Reactions", exact: true }).click();
  const row = team
    .getByRole("list", { name: "Reactions", exact: true })
    .getByRole("listitem");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // A live reaction from the same person joins its row.
  const liveReaction = finalizeEvent(
    {
      kind: 7,
      content: "✅",
      created_at: reaction.created_at + 1,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
      ],
    },
    reactor,
  );
  history.push(liveReaction);
  app.relay.publish("primary", liveReaction);
  const tail = row.getByText(/reacted/);
  await expect(tail).toHaveText(/reacted ❤️ ✅/);
  await page.route("**/reaction-custom.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#b557dd"/><path d="M8 16l5 5 11-12" stroke="white" stroke-width="4" fill="none"/></svg>',
    }),
  );
  const custom = finalizeEvent(
    {
      kind: 7,
      content: ":done:",
      created_at: reaction.created_at + 2,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
        ["emoji", "done", "https://primary.example/reaction-custom.svg"],
      ],
    },
    reactor,
  );
  history.push(custom);
  app.relay.publish("primary", custom);
  await expect(tail.locator("img")).toBeVisible();
  expect(
    await tail.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const item = element.closest("li").getBoundingClientRect();
      return box.left >= item.left && box.right <= item.right;
    }),
  ).toBe(true);
  // Another person's matching heart groups under both names.
  const sharedHeart = finalizeEvent(
    {
      kind: 7,
      content: "❤️",
      created_at: reaction.created_at + 3,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
      ],
    },
    generateSecretKey(),
  );
  history.push(sharedHeart);
  app.relay.publish("primary", sharedHeart);
  await expect(row).toHaveCount(2);
  await expect(row.filter({ hasText: "reacted ❤️" })).toContainText(" and ");
  await page.screenshot({
    path: testInfo.outputPath("reaction-shared-and-solo.png"),
  });
  await row.getByRole("button", { name: /reacted with heart/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Conversation detail", exact: true })
      .locator(
        `[data-channel-timeline="alpha"] [data-message-id="${target.id}"]`,
      ),
  ).toBeInViewport();
});

// Browser-only: the real virtualized timeline must reveal the exact reaction
// target inside the Solo chat or DM itself, rather than opening isolated threads.
test.describe("reaction conversation targets", () => {
  test.use({ soloChannels: ["beta"] });
  test("Solo and DM reactions reveal their message in the existing conversation", async ({
    page,
    app,
  }) => {
    const targets = ["beta", "dm-peer"].map((channelId, index) => {
      const message = app.sign({
        kind: 9,
        content: `Acknowledged ${channelId}`,
        created_at: 1700000950 + index,
        tags: [["h", channelId]],
      });
      const reaction = finalizeEvent(
        {
          kind: 7,
          content: "❤️",
          created_at: 1700001000 + index,
          tags: [
            ["h", channelId],
            ["e", message.id],
            ["p", app.viewer],
          ],
        },
        generateSecretKey(),
      );
      app.histories.get(`primary/${channelId}`).push(message, reaction);
      for (const event of [message, reaction])
        app.relay.publish("primary", event, { requireSubscriber: false });
      return { channelId, message };
    });
    await open(page, app);
    await openPage(page, "Activity");
    const detail = page.getByRole("region", {
      name: "Conversation detail",
      exact: true,
    });
    // Solo's list holds the Solo chat's reactions; Team's holds the DM's.
    for (const { channelId, message } of targets) {
      const section = channelId === "beta" ? "Solo" : "Team";
      await rail(page)
        .getByRole("heading", { name: section, exact: true })
        .getByRole("button")
        .click();
      const list = page.getByRole("region", {
        name: `${section} list`,
        exact: true,
      });
      await list.getByRole("tab", { name: "Reactions", exact: true }).click();
      await list
        .getByRole("button", {
          name: new RegExp(
            `reacted with heart to your message: Acknowledged ${channelId}$`,
          ),
        })
        .click();
      const history = detail.getByRole("region", {
        name: "Channel message history",
      });
      await expect(history).toHaveAttribute("data-channel-timeline", channelId);
      await expect(
        history.locator(`[data-message-id="${message.id}"]`),
      ).toBeInViewport();
      await expect(
        detail.getByRole("region", { name: "Thread messages" }),
      ).toHaveCount(0);
    }
  });
});
