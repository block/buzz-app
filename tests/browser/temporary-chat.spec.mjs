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
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // Nothing lists it: only its message's marker reopens it.
  await expect(sidebar.getByText(/^About:/)).toHaveCount(0);
  const marker = row.getByRole("button", { name: "Your temporary chat" });
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Three items are still open")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // The post back is a reply in the source thread, quoting the agent.
  await row.getByRole("button", { name: /1 reply/ }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Thread" })
      .getByText("Three items are still open"),
  ).toBeVisible();
});
