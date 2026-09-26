import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { npubEncode } from "nostr-tools/nip19";

test.use({
  productionBroker: true,
  dmLabels: true,
  readState: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Real shared-row/portal integration, keyboard focus and responsive geometry;
// failure, retry, identity and permission matrices stay in lower-layer tests.
test("manage a channel message, peer unread state, and its thread", async ({
  page,
  app,
}) => {
  await open(page, app);
  const mention = `[@Morgarita](nostr:${npubEncode("b".repeat(64))})`;
  const event = app.append("primary", "alpha", `${mention} whats your name`);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  const trigger = row.getByRole("button", { name: "More message actions" });
  await row.hover();
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Edit message" })).toHaveCount(
    0,
  );
  await expect(editor.locator('.inline-chip[data-kind="person"]')).toHaveText(
    "@Morgarita",
  );
  await expect(editor).not.toContainText("nostr:");
  await expect(page.getByRole("listbox", { name: /suggestions/i })).toHaveCount(
    0,
  );
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const bounds = await editor.boundingBox();
    const chip = await editor.locator(".inline-chip").boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(chip.x).toBeGreaterThanOrEqual(bounds.x);
    expect(chip.x + chip.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await editor.press("End");
  await editor.pressSequentially("? Management corrected");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Management corrected");
  await expect
    .poll(() =>
      app.report.publications.some(({ event: item }) => item.kind === 40003),
    )
    .toBe(true);
  const saved = app.report.publications.find(
    ({ event: item }) => item.kind === 40003,
  ).event;
  expect(saved.content).toBe(
    `${mention} whats your name? Management corrected`,
  );
  expect(saved.tags.filter(([name]) => name === "p")).toEqual([]);
  await expect(page.getByText("Editing message", { exact: true })).toHaveCount(
    0,
  );
  // Own messages are excluded from notification unread; use a peer row for the toggle.
  const peer = app.append(
    "primary",
    "alpha",
    "Peer unread target",
    true,
    false,
  );
  const peerRow = page.locator(
    `[data-channel-timeline] [data-message-id="${peer.id}"]`,
  );
  await expect(peerRow).toBeVisible();
  await peerRow.hover();
  const peerTrigger = peerRow.getByRole("button", {
    name: "More message actions",
  });
  await peerTrigger.click();
  const toggle = page.getByRole("menuitem", { name: /^Mark (read|unread)$/ });
  const initial = await toggle.textContent();
  await toggle.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await peerRow.hover();
  await peerTrigger.click();
  await expect(toggle).toHaveText(
    initial === "Mark read" ? "Mark unread" : "Mark read",
  );
  await toggle.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const root = thread.locator(`[data-message-id="${event.id}"]`);
  await root.hover();
  await root.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const threadEditor = thread.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(threadEditor).toBeFocused();
  await threadEditor.fill("Edited from thread");
  await thread.getByRole("button", { name: "Save changes" }).click();
  await expect(root).toContainText("Edited from thread");
  await expect(row).toContainText("Edited from thread");
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await trigger.click();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Delete message?",
    });
    await expect(confirmation).toBeVisible();
    const bounds = await confirmation.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toBeVisible();
  }
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  const deletion = app.report.publications.find(
    ({ event: item }) => item.kind === 5,
  ).event;
  expect(deletion.tags).toContainEqual(["e", event.id]);
  expect(deletion.pubkey).toBe(event.pubkey);
});

test("deleting a thread reply returns focus to the surviving thread composer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.append("primary", "alpha", "Thread deletion root");
  const channelRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await expect(channelRow).toBeVisible();
  await channelRow.hover();
  await channelRow.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const reply = app.append(
    "primary",
    "alpha",
    "My thread reply",
    true,
    true,
    root.id,
  );
  const replyRow = thread.locator(`[data-message-id="${reply.id}"]`);
  await expect(replyRow).toBeVisible();
  await replyRow.hover();
  await replyRow.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Delete message?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(replyRow).toHaveCount(0);
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeFocused();
});

test("DM menus edit own messages but never expose destructive actions for peers", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  const timeline = page.locator("[data-channel-timeline]");
  const channel = await timeline.getAttribute("data-channel-timeline");
  const own = app.append("primary", channel, "Own DM message");
  const row = timeline.locator(`[data-message-id="${own.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const dmEditor = page.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(dmEditor).toBeFocused();
  await dmEditor.fill("Corrected DM");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Corrected DM");
  const peer = app.append("primary", channel, "Peer DM message", true, false);
  const peerRow = timeline.locator(`[data-message-id="${peer.id}"]`);
  await peerRow.hover();
  await peerRow.getByRole("button", { name: "More message actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: /^Mark (read|unread)$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Delete message", exact: true }),
  ).toHaveCount(0);
});
