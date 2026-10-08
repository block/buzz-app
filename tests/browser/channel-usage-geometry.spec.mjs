import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";

test.use({
  productionBroker: true,
  archiveOnDisk: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  viewport: { width: 1200, height: 800 },
});

test("expanded channel usage leaves thread history usable in the default window", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  // Three agents force a wrapped third row at 800px and horizontal overflow at 400px.
  for (let agentIndex = 0; agentIndex < 3; agentIndex++) {
    const key = generateSecretKey();
    const agent = getPublicKey(key);
    for (
      let sessionIndex = 0;
      sessionIndex < (agentIndex === 0 ? 3 : 2);
      sessionIndex++
    ) {
      const payload = {
        harness: "goose",
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: `geometry-${agentIndex}-${sessionIndex}`,
        turnId: `turn-${agentIndex}-${sessionIndex}`,
        turnSeq: 1,
        turn: { inputTokens: 10 },
        cumulative: { totalTokens: 100 },
      };
      const event = finalizeEvent(
        {
          kind: 44200,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["p", app.viewer],
            ["agent", agent],
          ],
          content: nip44.v2.encrypt(
            JSON.stringify(payload),
            nip44.v2.utils.getConversationKey(key, app.viewer),
          ),
        },
        key,
      );
      app.relay.observer("primary", event);
    }
  }
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
  const usage = thread.getByRole("group", { name: "Channel session usage" });
  const agentPills = usage.getByRole("button", { name: /sessions/ });
  await expect(agentPills).toHaveCount(3);
  const strip = usage;
  // The 5rem cap must retain access to controls on wrapped rows.
  await strip.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await strip.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await expect(agentPills.last()).toBeInViewport();
  await agentPills.last().click();
  await expect(usage.getByRole("button", { name: "Refresh" })).toBeInViewport();
  await usage.getByRole("button", { name: "Refresh" }).click();
  await agentPills.first().click();
  const sessions = thread.getByRole("group", { name: "Select session" });
  await sessions.getByRole("button", { name: "Session 2" }).click();
  await expect(
    sessions.getByRole("button", { name: "Session 2" }),
  ).toHaveAttribute("aria-pressed", "true");
  const details = thread.getByRole("region", { name: "Session usage details" });
  const history = thread.getByRole("region", { name: "Thread messages" });
  await expect(details).toBeVisible();
  await expect(history).toBeVisible();
  const dimensions = await history.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(dimensions.height).toBeGreaterThanOrEqual(120);
  expect(dimensions.clientHeight).toBeGreaterThanOrEqual(120);
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 400 });
  const owner = strip.locator("..");
  const detailsX = await details.evaluate(
    (element) => element.getBoundingClientRect().x,
  );
  for (const index of [1, 2, 0]) {
    await agentPills.nth(index).click();
    await expect(agentPills.nth(index)).toBeInViewport();
    expect(await owner.evaluate((element) => element.scrollLeft)).toBe(0);
    expect(
      await details.evaluate((element) => element.getBoundingClientRect().x),
    ).toBe(detailsX);
  }
  const overflow = await strip.evaluate((element) => ({
    width: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(overflow.content).toBeGreaterThan(overflow.width);
  await strip.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect(await strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(
    0,
  );
  await expect(usage.getByRole("button", { name: "Refresh" })).toBeInViewport();
  await usage.getByRole("button", { name: "Refresh" }).click();
  expect(await owner.evaluate((element) => element.scrollLeft)).toBe(0);
  // The first pill is active after the loop; preserve its details for the Close check.
  await expect(details.getByRole("button", { name: "Close" })).toBeInViewport();
  const shortHistory = await history.evaluate(
    (element) => element.clientHeight,
  );
  expect(shortHistory).toBeGreaterThanOrEqual(60);
  await details.getByRole("button", { name: "Close" }).click();
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeInViewport();
});
