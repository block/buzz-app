import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { hoverMessage } from "./message-actions.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

// Browser boundary: the real composer, thread panel and signed publication
// agree that one broadcast event is the thread reply and the channel row.
test("a thread reply sent with Also send to channel is one event in the thread and the channel", async ({
  page,
  app,
}) => {
  await open(page, app);
  const channelInput = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await channelInput.fill("Also send seed");
  await channelInput.press("Enter");
  const timeline = page.locator("[data-channel-timeline]");
  const seed = timeline.locator("[data-message-id]").filter({
    hasText: "Also send seed",
  });
  await expect(seed).toBeVisible();
  await hoverMessage(seed);
  await expect(
    seed.getByRole("button", { name: "Reply", exact: true }),
  ).toBeEnabled();
  await seed.getByRole("button", { name: "Reply", exact: true }).click();

  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const alsoSend = panel.getByRole("button", { name: "Also send to #Alpha" });
  await expect(alsoSend).toHaveAttribute("aria-pressed", "false");
  await alsoSend.click();
  await expect(alsoSend).toHaveAttribute("aria-pressed", "true");

  const threadInput = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await threadInput.fill("Also send reply");
  await threadInput.press("Enter");
  const published = (content) =>
    app.report.publications.find(
      ({ event }) => event.kind === 9 && event.content === content,
    )?.event;
  await expect.poll(() => published("Also send reply")).toBeTruthy();
  const broadcast = published("Also send reply");
  expect(broadcast.tags).toContainEqual(["broadcast", "1"]);
  expect(
    app.report.publications.filter(
      ({ event }) => event.content === "Also send reply",
    ),
  ).toHaveLength(1);
  await expect(alsoSend).toHaveAttribute("aria-pressed", "false");

  const threadRow = panel.locator(`[data-message-id="${broadcast.id}"]`);
  await expect(threadRow).toContainText("Also send reply");
  await expect(
    timeline.locator(`[data-message-id="${broadcast.id}"]`),
  ).toContainText("Also send reply");

  await hoverMessage(threadRow);
  await threadRow.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(alsoSend).toHaveCount(0);
  await panel.getByRole("button", { name: "Cancel reply target" }).click();
  await expect(alsoSend).toHaveAttribute("aria-pressed", "false");

  await threadInput.fill("Thread-only reply");
  await threadInput.press("Enter");
  await expect.poll(() => published("Thread-only reply")).toBeTruthy();
  expect(
    published("Thread-only reply").tags.map(([name]) => name),
  ).not.toContain("broadcast");
  await expect(panel).toContainText("Thread-only reply");
  await expect(
    timeline.locator("[data-message-id]").filter({
      hasText: "Thread-only reply",
    }),
  ).toHaveCount(0);
});
