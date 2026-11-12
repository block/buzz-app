// Browser geometry and real scrolling cannot be established in jsdom.
import { test, expect } from "./fixture.mjs";
import { open, settle, anchor, expectAnchor, wheel } from "./timeline.mjs";
import {
  openSettings,
  closeSettings,
  selectSettingsSection,
} from "./navigation.mjs";

test("Bottom alignment: setting, upward growth, reload and overflow", async ({
  page,
  app,
}) => {
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  const rows = history.locator("[data-message-id]");
  const geometry = () =>
    history.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll("[data-message-id]")];
      return {
        height: box.height,
        first: rows[0].getBoundingClientRect().top - box.top,
        gap: box.bottom - rows.at(-1).getBoundingClientRect().bottom,
        scroll: el.scrollTop,
        overflow: el.scrollHeight - el.clientHeight,
      };
    });
  await open(page, app);
  const before = await geometry();
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
  await expect.poll(async () => (await geometry()).gap).toBeLessThan(75);
  expect((await geometry()).first).toBeGreaterThan(before.first + 150);
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
  await expect.poll(async () => (await geometry()).gap).toBeLessThan(75);
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
  expect((await geometry()).overflow).toBeGreaterThan(100);
  const bottom = (await geometry()).scroll;
  await history.hover();
  await wheel(page, -500);
  expect((await geometry()).scroll).toBeLessThan(bottom - 100);
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
    const gap = (el) => {
      const rows = [...el.querySelectorAll("[data-message-id]")];
      return (
        el.getBoundingClientRect().bottom -
        rows.at(-1).getBoundingClientRect().bottom
      );
    };
    await expect.poll(() => history.evaluate(gap)).toBeLessThan(75);
    app.reply(root.id);
    await expect(
      history.getByText("New peer reply", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => history.evaluate(gap)).toBeLessThan(75);
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
    await expect.poll(() => mainHistory.evaluate(gap)).toBeLessThan(75);
    await page.getByRole("tab", { name: "Solo", exact: true }).click();
    await page.locator('[data-solo-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeVisible();
    await expect(
      mainHistory.locator("[data-message-id]").first(),
    ).toBeVisible();
    await settle(page);
    await expect.poll(() => mainHistory.evaluate(gap)).toBeLessThan(75);
  });
});
