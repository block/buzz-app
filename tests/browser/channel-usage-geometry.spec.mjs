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

test("channel usage opens a separate tab and leaves thread history usable", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  // Three agents exercise the full-height usage tab with multiple sessions.
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
        sessionId: `geometry-${agentIndex}-${sessionIndex}-very-long-identifier-without-spaces`,
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
  const actions = page.getByRole("button", { name: "Channel actions" });
  await actions.click();
  await page.getByRole("menuitem", { name: "View channel usage" }).click();
  const pane = page.getByRole("tabpanel", { name: "Usage" });
  const usage = pane.getByRole("group", { name: "Channel session usage" });
  const picker = usage.getByRole("combobox", { name: "Agent usage" });
  await picker.click();
  await expect(page.getByRole("option", { name: /sessions/ })).toHaveCount(3);
  const choices = await page
    .getByRole("option", { name: /sessions/ })
    .allTextContents();
  await page.getByRole("option", { name: choices[0] }).click();
  const sessions = pane.getByRole("group", { name: "Select session" });
  await sessions.getByRole("button", { name: "Session 2" }).click();
  await expect(
    sessions.getByRole("button", { name: "Session 2" }),
  ).toHaveAttribute("aria-pressed", "true");
  const details = pane.getByRole("region", { name: "Session usage details" });
  await expect(details).toBeVisible();
  // A long identifier must wrap in its value column, not squeeze labels to letters.
  await details
    .getByRole("button", { name: /Show turn/ })
    .first()
    .click();
  await details.getByText("Identifiers and provenance").click();
  const identifierRows = details.locator("details dl");
  for (const width of [1200, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await identifierRows.evaluate((list) => {
      const label = list.querySelector("dt");
      const value = list.querySelector("dd");
      return {
        labelWidth: label.getBoundingClientRect().width,
        valueWidth: value.getBoundingClientRect().width,
        labelFontSize: parseFloat(getComputedStyle(label).fontSize),
        valueOverflows: value.scrollWidth > value.clientWidth + 1,
        listOverflows: list.scrollWidth > list.clientWidth + 1,
      };
    });
    expect(geometry.labelWidth).toBeGreaterThanOrEqual(90);
    expect(geometry.valueWidth).toBeGreaterThanOrEqual(90);
    expect(geometry.labelFontSize).toBeGreaterThanOrEqual(14);
    expect(geometry.valueOverflows).toBe(false);
    expect(geometry.listOverflows).toBe(false);
  }
  await page.setViewportSize({ width: 1200, height: 400 });
  const owner = usage.locator("..");
  for (const index of [1, 2, 0]) {
    await picker.click();
    await page.getByRole("option", { name: choices[index] }).click();
    await expect(picker).toBeInViewport();
    expect(
      await owner.evaluate((element) => element.scrollWidth),
    ).toBeLessThanOrEqual(
      (await owner.evaluate((element) => element.clientWidth)) + 1,
    );
  }
  await expect(usage.getByRole("button", { name: "Refresh" })).toBeInViewport();
  await usage.getByRole("button", { name: "Refresh" }).click();
  await page.setViewportSize({ width: 1200, height: 800 });
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: /^View thread:/ }).click();
  await expect(page.getByRole("tabpanel", { name: "Usage" })).not.toBeVisible();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("region", { name: "Thread messages" }),
  ).toBeVisible();
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeInViewport();
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(details).toBeVisible();
  await expect(
    pane.getByRole("textbox", { name: "Reply to thread" }),
  ).toHaveCount(0);
  // A hidden display removes the tab and prevents reopening it from the menu.
  await page.evaluate(() => {
    localStorage.setItem("buzz-show-channel-session-usage.v1", "off");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-show-channel-session-usage.v1",
      }),
    );
  });
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveCount(0);
  await actions.click();
  await expect(
    page.getByRole("menuitem", { name: "View channel usage" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
});
