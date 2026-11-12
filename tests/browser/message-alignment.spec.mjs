// Browser geometry and real scrolling cannot be established in jsdom.
import { test, expect } from "./fixture.mjs";
import {
  open,
  settle,
  anchor,
  expectAnchor,
  wheel,
  edge,
  end,
} from "./timeline.mjs";
import {
  openSettings,
  closeSettings,
  selectSettingsSection,
} from "./navigation.mjs";

const geometry = (history) =>
  history.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const first = el.querySelector("[data-message-id]");
    return {
      first: first.getBoundingClientRect().top - box.top,
      scroll: el.scrollTop,
      overflow: el.scrollHeight - el.clientHeight,
      bottom: el.scrollHeight - el.scrollTop - el.clientHeight,
      // The in-flow tail includes the existing message clearance spacer.
      // It should meet the scrollport's computed bottom inset in Bottom.
      endGap:
        box.top +
        el.clientTop +
        el.clientHeight -
        el.lastElementChild.getBoundingClientRect().bottom -
        Number.parseFloat(getComputedStyle(el).paddingBottom),
    };
  });
// Match the scroll rounding tolerance used by the shared edge helpers.
const expectEndAligned = (history) =>
  expect
    .poll(async () => Math.abs((await geometry(history)).endGap))
    .toBeLessThan(4);
const expectAtBottom = (history) =>
  expect.poll(async () => (await geometry(history)).bottom).toBeLessThan(4);

test("Bottom alignment: setting, upward growth, reload and overflow", async ({
  page,
  app,
}) => {
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  const rows = history.locator("[data-message-id]");
  await open(page, app);
  const before = await geometry(history);
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  const alignment = page.getByRole("combobox", {
    name: "Message alignment",
    exact: true,
  });
  await alignment.scrollIntoViewIfNeeded();
  await expect(alignment).toHaveText("Top");
  await alignment.click();
  await page.getByRole("option", { name: "Bottom", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-message-alignment",
    "bottom",
  );
  await closeSettings(page);
  await settle(page);
  await expectEndAligned(history);
  expect((await geometry(history)).first).toBeGreaterThan(before.first + 150);
  const firstBefore = await rows.first().boundingBox();
  app.append(
    "primary",
    "alpha",
    "New messages arrive here, just above the composer.",
    true,
    false,
  );
  await expect(
    history.getByText("New messages arrive here, just above the composer.", {
      exact: true,
    }),
  ).toBeVisible();
  await settle(page);
  expect((await rows.first().boundingBox()).y).toBeLessThan(firstBefore.y);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-message-alignment",
    "bottom",
  );
  await expect(rows.first()).toBeVisible();
  await settle(page);
  await expectEndAligned(history);
  for (let i = 0; i < 18; i++)
    app.append(
      "primary",
      "alpha",
      `Sample message ${i + 1}: the conversation keeps its chronological order as it fills the window.`,
      true,
      false,
    );
  await expect(history.getByText(/^Sample message 18:/)).toBeVisible();
  await settle(page);
  expect((await geometry(history)).overflow).toBeGreaterThan(100);
  await expectAtBottom(history);
  await expectEndAligned(history);
  await edge(page, -1);
  await expect(history.locator(":scope > div").first()).toBeInViewport();
  await expect(
    history.locator(
      `[data-message-id="${app.histories.get("primary/alpha")[0].id}"]`,
    ),
  ).toBeInViewport();
  await end(page);
  await expect(history.getByText(/^Sample message 18:/)).toBeInViewport();
  const bottom = (await geometry(history)).scroll;
  await history.hover();
  await wheel(page, -500);
  expect((await geometry(history)).scroll).toBeLessThan(bottom - 100);
  const reading = await anchor(page);
  app.append(
    "primary",
    "alpha",
    "New message while reading older history.",
    true,
    false,
  );
  const jump = history.getByRole("button", {
    name: "1 new message",
    exact: true,
  });
  await expect(jump).toBeVisible();
  await settle(page);
  await expectAnchor(page, reading);
  await jump.click();
  await expect(
    history.getByText("New message while reading older history.", {
      exact: true,
    }),
  ).toBeInViewport();
  await settle(page);
  await expectAtBottom(history);
  await expectEndAligned(history);
});

test.describe("Conversation surfaces", () => {
  test.use({
    productionBroker: true,
    readState: true,
    threadUnread: true,
    dmLabels: true,
    soloChannels: ["beta"],
    ownSoloChannels: ["beta"],
    historyCounts: { alpha: 2, beta: 1 },
  });

  test("Bottom alignment in thread, DM and Solo", async ({ page, app }) => {
    await page.addInitScript(() => {
      localStorage.setItem("buzz-message-alignment.v1", "bottom");
    });
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((e) => e.content === "Thread root 0");
    const rootRow = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    await rootRow.hover();
    await rootRow.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = thread.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await expect(history.locator("[data-message-id]").last()).toBeVisible();
    await settle(page, history);
    await expectEndAligned(history);
    const rootBefore = await history
      .locator(`[data-message-id="${root.id}"]`)
      .boundingBox();
    app.reply(root.id);
    await expect(
      history.getByText("New peer reply", { exact: true }),
    ).toBeVisible();
    await settle(page, history);
    await expectEndAligned(history);
    expect(
      (await history.locator(`[data-message-id="${root.id}"]`).boundingBox()).y,
    ).toBeLessThan(rootBefore.y);
    // Enough short replies to cross from underfilled to scrolling history.
    let lastReply;
    for (let i = 0; i < 30; i++) lastReply = app.reply(root.id);
    const lastReplyRow = history.locator(`[data-message-id="${lastReply.id}"]`);
    await expect(lastReplyRow).toBeInViewport();
    await settle(page, history);
    expect((await geometry(history)).overflow).toBeGreaterThan(100);
    await expectAtBottom(history);
    await expectEndAligned(history);
    await edge(page, -1, history);
    await expect(
      history.locator(`[data-message-id="${root.id}"]`),
    ).toBeInViewport();
    await edge(page, 1, history);
    await expect(lastReplyRow).toBeInViewport();
    await page
      .getByRole("button", { name: "Close Thread root 0 tab", exact: true })
      .click();
    app.append(
      "primary",
      "dm-peer",
      "A short direct message starts at the bottom.",
      true,
      false,
    );
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    await sidebar.locator('button[data-channel-id="dm-peer"]').click();
    const mainHistory = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    await expect(
      mainHistory.getByText("A short direct message starts at the bottom.", {
        exact: true,
      }),
    ).toBeVisible();
    await settle(page);
    await expectEndAligned(mainHistory);
    await page.getByRole("tab", { name: "Solo", exact: true }).click();
    await page.locator('[data-solo-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeVisible();
    await expect(
      mainHistory.locator("[data-message-id]").first(),
    ).toBeVisible();
    await settle(page);
    await expectEndAligned(mainHistory);
  });
});
