import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";

const source = "11111111-1111-4111-8111-111111111111";
const solo = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  threadPlacement: "inline",
  channelIds: [source, solo],
  channelNames: { [source]: "launch", [solo]: "Planning" },
  soloChannels: [solo],
  ownSoloChannels: [solo],
  soloAgentNames: ["Honey"],
  soloStarts: true,
  historyCounts: { [source]: 0, [solo]: 1 },
});

test("a temporary chat opens over its message, stays out of the sidebar and posts back", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await sidebar.getByRole("button", { name: "launch", exact: true }).click();
  app.append(
    "primary",
    source,
    "Morning! Release branch is cut, QA starts on it today.",
    true,
    true,
  );
  const question = app.append(
    "primary",
    source,
    "Where did we land on the launch checklist? I need the open items before Thursday.",
    true,
    false,
  );
  const row = page.locator(`[data-message-id="${question.id}"]`);
  await expect(row).toBeVisible();
  await hoverMessage(row);
  await row
    .getByRole("button", { name: "More message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Temporary chat", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Temporary chat" });
  await expect(sheet).toBeVisible();
  await expect.poll(() => app.report.soloStarts?.length ?? 0).toBe(1);
  const [start] = app.report.soloStarts;
  const chat = start.tags.find(([key]) => key === "h")[1];
  expect(start.tags).toContainEqual(["t", "buzz.unlisted"]);
  // The forwarded source is the chat's first message.
  await expect(
    sheet.getByText("Where did we land on the launch"),
  ).toBeVisible();
  const composer = sheet.getByRole("textbox").last();
  await composer.click();
  await page.keyboard.type("Pull the open items from the checklist for me?", {
    delay: 25,
  });
  await page.keyboard.press("Enter");
  const answer = app.soloAgentMessage(
    chat,
    "Three items are still open: the status page copy, the rollback drill, and sign-off from support. Everything else is done.",
  );
  const reply = sheet.locator(`[data-message-id="${answer.id}"]`);
  await expect(reply).toBeVisible();
  await hoverMessage(reply);
  await reply
    .getByRole("button", { name: "More message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Post to thread", exact: true })
    .click();
  // Post to thread closes the temporary chat and drops the answer into the
  // source thread's reply box so the viewer can edit and send it themselves.
  await expect(sheet).toBeHidden();
  const thread = page.getByRole("dialog", { name: "Thread" });
  await expect(thread).toBeVisible();
  const threadComposer = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(threadComposer).toContainText("Three items are still open");
  // Nothing was published yet until the viewer sends.
  expect(
    app.report.publications.some(
      ({ event }) =>
        event.kind === 9 &&
        event.tags.some(([key, value]) => key === "h" && value === source) &&
        event.tags.some(([key, value]) => key === "e" && value === question.id),
    ),
  ).toBe(false);
  await threadComposer.click();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 9 &&
          event.tags.some(([key, value]) => key === "h" && value === source) &&
          event.tags.some(
            ([key, value]) => key === "e" && value === question.id,
          ),
      ),
    )
    .toBe(true);
  await expect(thread.getByText("Three items are still open")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(thread).toBeHidden();
  // Nothing lists the temporary chat: only its message's marker reopens it.
  await expect(sidebar.getByText(/^About:/)).toHaveCount(0);
  // A follow-up from the agent while closed marks the source message as unread.
  const followUp = app.soloAgentMessage(
    chat,
    "Support just signed off — down to two open items.",
  );
  const unreadMarker = row.getByRole("button", {
    name: /Your temporary chat · 1 new/,
  });
  await expect(unreadMarker).toBeVisible();
  await unreadMarker.click();
  await expect(sheet).toBeVisible();
  await expect(
    sheet.locator(`[data-message-id="${followUp.id}"]`),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(
    row.getByRole("button", { name: "Your temporary chat", exact: true }),
  ).toBeVisible();
});

test("a temporary chat stacks on the inline thread it opens from, and its details expand in place", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await sidebar.getByRole("button", { name: "launch", exact: true }).click();
  const root = app.append(
    "primary",
    source,
    "Release branch is cut, QA starts on it today.",
    true,
    false,
  );
  const answer = app.append(
    "primary",
    source,
    "The rollback drill is still open; I can run it Wednesday.",
    true,
    false,
    root.id,
  );
  const rootRow = page.locator(`[data-message-id="${root.id}"]`);
  await expect(rootRow).toBeVisible();
  await hoverMessage(rootRow);
  await rootRow.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("dialog", { name: "Thread" });
  const replyRow = thread.locator(`[data-message-id="${answer.id}"]`);
  await expect(replyRow).toBeVisible();
  await hoverMessage(replyRow);
  await replyRow
    .getByRole("button", { name: "More message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Temporary chat", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Temporary chat" });
  await expect(sheet).toBeVisible();
  // It stacks on the thread, which stays open under it.
  await expect(thread).toBeVisible();
  await expect.poll(() => app.report.soloStarts?.length ?? 0).toBe(1);
  const chat = app.report.soloStarts[0].tags.find(([key]) => key === "h")[1];
  await expect(
    sheet.getByText("The rollback drill is still open"),
  ).toBeVisible();
  // Its composer is on top and takes typing.
  const composer = sheet.getByRole("textbox").last();
  await composer.click();
  await page.keyboard.type("What does the drill need?");
  await expect(composer).toContainText("What does the drill need?");
  // A details message in it expands in place rather than opening nowhere.
  const filler = "More of it follows here. ".repeat(30);
  const details = app.soloAgentMessage(chat, `Drill checklist\n\n${filler}`, [
    ["audience", "details"],
  ]);
  const detailsRow = sheet.locator(`[data-message-id="${details.id}"]`);
  await expect(detailsRow).toBeVisible();
  await page.mouse.move(0, 0);
  await detailsRow
    .getByRole("button", { name: "Show more", exact: true })
    .click();
  await expect(
    detailsRow.getByRole("button", { name: "Show less", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog")).toHaveCount(2);
  // Posting back from a temporary chat over an already-open inline thread
  // closes only the chat and puts the text right into the thread's reply box.
  const summary = app.soloAgentMessage(
    chat,
    "Drill needs a staging snapshot and 15 minutes with on-call.",
  );
  const summaryRow = sheet.locator(`[data-message-id="${summary.id}"]`);
  await expect(summaryRow).toBeVisible();
  await hoverMessage(summaryRow);
  await summaryRow
    .getByRole("button", { name: "More message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Post to thread", exact: true })
    .click();
  await expect(sheet).toBeHidden();
  await expect(thread).toBeVisible();
  const threadComposer = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(threadComposer).toBeVisible();
  await expect(threadComposer).toContainText(
    "Drill needs a staging snapshot and 15 minutes with on-call.",
  );
});
