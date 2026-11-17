import { finalizeEvent, generateSecretKey } from "nostr-tools";
import {
  activityRow,
  conversationList,
  openSettings,
  selectSettingsSection,
  chooseColorMode,
  closeSettings,
  showConversationList,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only contract: the Activity list lays out reaction and thread rows
// in both themes and at narrow widths with enlarged text, and its rows open
// their conversations. The rows' states stay in RTL tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("the Activity list shows reaction and thread rows and opens them directly", async ({
  page,
  app,
}, testInfo) => {
  const history = app.histories.get("primary/alpha");
  const target = history.find(
    (event) => event.kind === 9 && event.pubkey === app.viewer,
  );
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
  const solo = finalizeEvent(
    {
      kind: 7,
      content: "👍",
      created_at: reaction.created_at + 1,
      tags: reaction.tags,
    },
    reactor,
  );
  const shared = finalizeEvent(
    {
      kind: 7,
      content: "❤️",
      created_at: reaction.created_at + 2,
      tags: reaction.tags,
    },
    generateSecretKey(),
  );
  history.push(solo, shared);
  app.relay.publish("primary", solo, { requireSubscriber: false });
  app.relay.publish("primary", shared, { requireSubscriber: false });
  await open(page, app);
  await activityRow(page).click();
  const list = conversationList(page);
  const reactionRows = list.getByRole("button", { name: /reacted with/ });
  // In both themes, at an intermediate width and with enlarged text.
  for (const [mode, width, fontSize] of [
    ["light", 1280, "16px"],
    ["dark", 1280, "16px"],
    ["dark", 760, "20px"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await openSettings(page);
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode === "dark" ? "Dark" : "Light");
    await closeSettings(page);
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-palette-changing",
    );
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = fontSize;
    }, fontSize);
    await showConversationList(page);
    await expect(
      list.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    const reactionRow = list.getByRole("button", {
      name: /reacted with heart/,
    });
    await expect(reactionRow).toBeVisible();
    await expect(reactionRow).toContainText(" and ");
    await expect(reactionRows).toHaveCount(2);
    await expect(
      reactionRow.getByText("in #Alpha", { exact: true }),
    ).toBeVisible();
    const geometry = await reactionRow.evaluate((element) => {
      const preview = element
        .querySelector('[class*="_preview_"]')
        .getBoundingClientRect();
      const context = element
        .querySelector('[class*="_source_"]')
        .getBoundingClientRect();
      const tail = element
        .querySelector('[class*="_tail_"]')
        .getBoundingClientRect();
      return {
        previewY: preview.y,
        contextY: context.y,
        tailBottom: tail.bottom,
        tailRight: tail.right,
        rowRight: element.getBoundingClientRect().right,
      };
    });
    expect(geometry.previewY).toBeGreaterThanOrEqual(geometry.tailBottom);
    expect(geometry.contextY).toBeGreaterThan(geometry.previewY);
    expect(geometry.tailRight).toBeLessThanOrEqual(geometry.rowRight);
    expect(
      await list.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        `activity-list-${mode}-${width}-${fontSize}.png`,
      ),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
    document.documentElement.classList.remove("dark");
    document.documentElement.style.fontSize = "";
  });

  // Unread only leaves out reactions, which are never unread.
  const filters = page.getByRole("button", {
    name: "Filter and sort conversations",
    exact: true,
  });
  const show = async (choice) => {
    await filters.click();
    await page
      .getByRole("menuitemradio", { name: choice, exact: true })
      .click();
  };
  await show("Unread only");
  await expect(reactionRows).toHaveCount(0);
  await show("All conversations");
  await expect(reactionRows).toHaveCount(2);
  await reactionRows.first().click();
  await expect(
    page
      .getByRole("region", { name: "Thread messages", exact: true })
      .locator(`[data-message-id="${target.id}"]`),
  ).toBeVisible();

  // A thread row opens its thread directly.
  await show("Unread only");
  await list
    .locator("[data-activity-event] [data-conversation-row]")
    .filter({ hasText: "Unread reply 1" })
    .click();
  await expect(
    page.getByRole("region", { name: "Thread messages", exact: true }),
  ).toBeVisible();
});
