import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { open, end, wheel, settle } from "./timeline.mjs";
import { generateSecretKey, finalizeEvent, getPublicKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  developmentReact: true,
});

// Native focus and virtual-list scroll anchoring need the real conversation.
test("removing a reaction from a tall message preserves the reading position", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "Reaction scroll target");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Add reaction", exact: true }).click();
  await page.locator('em-emoji-picker input[type="search"]').fill("thumbsup");
  await page
    .locator("em-emoji-picker")
    .getByRole("button", { name: "👍", exact: true })
    .click();
  const reaction = row.locator('button[data-reaction="👍"]');
  await expect(reaction).toHaveAttribute("aria-pressed", "true");
  app.edit(
    "primary",
    "alpha",
    event,
    "This long message keeps its reaction below the visible start.\n\n".repeat(
      60,
    ),
  );
  for (let i = 0; i < 6; i++)
    app.append("primary", "alpha", `Message after the reaction ${i}`);
  await end(page);
  await wheel(page, -120);
  await reaction.scrollIntoViewIfNeeded();
  await settle(page);
  const history = page.getByRole("region", { name: "Channel message history" });
  const before = await history.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(500);
  await reaction.click();
  await expect(reaction).toHaveCount(0);
  await settle(page);
  expect(await history.evaluate((el) => el.scrollTop)).toBe(before);
});

// Browser-only boundary: real popup focus/geometry and existing tab navigation
// must retain the live thread. Identity/lifecycle matrices live in Vitest.
// Live work has one place: the end of its conversation. The request message
// shows none of it; the channel's thread summary says who works in the thread.
const endTrigger = (scope) =>
  scope.locator("[data-conversation-activity] [data-agent-activity-trigger]");

test("hosted work on a thread shows once, at the thread's end, and in its channel summary", async ({
  page,
  app,
}, testInfo) => {
  const keys = [generateSecretKey(), generateSecretKey()];
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: keys.map((key, index) => ({
          pubkey: getPublicKey(key),
          name: `Agent ${index + 1}`,
        })),
      },
    }),
  );
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
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
  const reply = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeVisible();
  keys.forEach((key, index) => {
    app.serveProfile(key, { name: `Agent ${index + 1}`, is_agent: true });
  });
  const human = generateSecretKey();
  const publish = (
    key,
    kind,
    content,
    tags,
    createdAt = Math.floor(Date.now() / 1000),
  ) =>
    app.relay.publish(
      "primary",
      finalizeEvent({ kind, content, tags, created_at: createdAt }, key),
    );
  let seq = 1;
  const send = (index, kind, payload = {}) =>
    app.observer(
      {
        kind,
        seq: ++seq,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "S",
        turnId: `working-${index}`,
        // Older harnesses name only the triggering message, not its thread.
        payload:
          kind === "turn_started" ? { triggeringEventIds: [root.id] } : payload,
      },
      keys[index],
    );
  keys.forEach((_, index) => {
    send(index, "turn_started");
    send(index, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read",
          title: "buzz-dev-mcp__read_file",
          status: "in_progress",
          rawInput: { path: "/project/README.md" },
        },
      },
    });
  });
  const requestRow = thread.locator(`[data-message-id="${root.id}"]`);
  const working = endTrigger(thread);
  await expect(working).toBeVisible();
  await expect(thread.locator("[data-agent-activity-trigger]")).toHaveCount(1);
  await expect(
    working
      .locator("xpath=ancestor::*[@data-agent-response-preview]")
      .locator(".buzz-avatar"),
  ).toHaveCount(2);
  // Neither the request in the thread nor its copy in the channel shows it.
  for (const target of [requestRow, row])
    await expect(
      target.getByRole("region", { name: "Agent activity on this message" }),
    ).toHaveCount(0);
  await expect(endTrigger(page.locator("[data-channel-timeline]"))).toHaveCount(
    0,
  );
  const summary = row.getByRole("button", { name: /^View thread:/ });
  await expect(
    row.locator("[data-thread-summary] [data-thread-working]"),
  ).toHaveCount(1);
  const typingTags = [
    ["h", "alpha"],
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ];
  publish(keys[0], 20002, "", typingTags);
  publish(human, 20002, "", typingTags);
  const typing = thread.getByRole("status", { name: "Conversation activity" });
  await expect(typing).toContainText(getPublicKey(human).slice(0, 10));
  // Agents are announced as working, never as typing.
  await expect(typing).toContainText(/Agent \d, Agent \d are working/);
  await expect(typing).not.toContainText(/Agent \d is typing/);
  await reply.fill("Keep this draft while inspecting activity");
  const form = thread.getByRole("form", {
    name: "Reply to thread",
    exact: true,
  });
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(working).toBeVisible();
      const [box, formBox] = await Promise.all([
        working.boundingBox(),
        form.boundingBox(),
      ]);
      expect(box.y + box.height).toBeLessThanOrEqual(formBox.y);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${colorScheme}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  // Each agent's row opens its profile from the thread's end.
  await working.click();
  const popup = page.getByRole("dialog", { name: "Working now", exact: true });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "View Agent 1 activity" }).click();
  const profile = page.getByRole("region", {
    name: "Profile details",
    exact: true,
  });
  // Browser builds register no agent type, so there is no Activity tab to land on.
  await expect(
    profile.getByRole("tab", { name: "Info", selected: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  await expect(reply).toHaveText("Keep this draft while inspecting activity");
  // Public replies do not complete work: the end keeps showing it.
  publish(keys[0], 9, "Agent reply with plain avatar", typingTags);
  await expect(
    thread.getByText("Agent reply with plain avatar", { exact: true }),
  ).toBeVisible();
  await expect(working).toBeVisible();
  send(0, "turn_completed");
  await expect(working).toHaveAccessibleName(/Agent 2|Read/);
  send(1, "turn_completed");
  await expect(working).toHaveCount(0);
  await expect(
    row.locator("[data-thread-summary] [data-thread-working]"),
  ).toHaveCount(0);
  await expect(summary).toBeVisible();
  await expect(reply).toHaveText("Keep this draft while inspecting activity");
});

// Real layout: adding agents widens one fixed-height row, with bounded artwork.
test("the end's avatar stack stays one height with overflow at every supported width", async ({
  page,
  app,
}, testInfo) => {
  const keys = Array.from({ length: 5 }, () => generateSecretKey());
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: keys.map((key, i) => ({
          pubkey: getPublicKey(key),
          name: `Stack agent ${i + 1}`,
        })),
      },
    }),
  );
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
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
  const working = endTrigger(thread);
  const artwork = working
    .locator("xpath=ancestor::*[@data-agent-response-preview]")
    .locator(".buzz-avatar");
  let firstHeight;
  for (const [i, key] of keys.entries()) {
    app.serveProfile(key, { name: `Stack agent ${i + 1}`, is_agent: true });
    app.observer(
      {
        kind: "turn_started",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "stack",
        turnId: `stack-${i}`,
        payload: { triggeringEventIds: [root.id] },
      },
      key,
    );
    await expect(working).toHaveAccessibleName(
      i === 0 ? /Stack agent 1 working/ : `Activity: ${i + 1} agents working`,
    );
    await expect(artwork).toHaveCount(Math.min(3, i + 1));
    const box = await working.boundingBox();
    firstHeight ??= box.height;
    expect(box.height).toBe(firstHeight);
  }
  await working.click();
  await expect(
    page
      .getByRole("dialog", { name: "Working now" })
      .getByRole("button", { name: /^View Stack agent \d activity$/ }),
  ).toHaveCount(5);
  await page.keyboard.press("Escape");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const box = await working.boundingBox();
      expect(box.height).toBe(firstHeight);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      for (const avatar of await artwork.all()) {
        const bounds = await avatar.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: testInfo.outputPath(`stack-${colorScheme}-${width}.png`),
      });
    }
  }
});

// Real layout boundary: work never attaches to its triggering message, whichever
// side that message sits on; the agent's side of the conversation's end has it.
for (const own of [true, false]) {
  test.describe(`Activity placement for ${own ? "outgoing" : "incoming"} requests`, () => {
    test.use({ threadUnreadOwnedRoot: own });
    test("work shows at the conversation's end, not on the request, in channels and threads", async ({
      page,
      app,
    }) => {
      const key = generateSecretKey();
      await open(page, app);
      await expect
        .poll(() => app.relay.hasRoute("primary", "observer"))
        .toBe(true);
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
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
      app.serveProfile(key, { name: "Working agent", is_agent: true });
      app.observer(
        {
          kind: "turn_started",
          seq: 1,
          timestamp: new Date().toISOString(),
          channelId: "alpha",
          sessionId: "alignment",
          turnId: "working",
          payload: { triggeringEventIds: [root.id] },
        },
        key,
      );
      const working = endTrigger(thread);
      await expect(working).toBeVisible();
      for (const target of [
        row,
        thread.locator(`[data-message-id="${root.id}"]`),
      ])
        await expect(
          target.getByRole("region", {
            name: "Agent activity on this message",
          }),
        ).toHaveCount(0);
      // The agent's side: its avatar leads the indicator, inside the pane.
      const preview = working.locator(
        "xpath=ancestor::*[@data-agent-response-preview]",
      );
      const [triggerBox, avatarBox, paneBox] = await Promise.all([
        working.boundingBox(),
        preview.locator(".buzz-avatar").first().boundingBox(),
        thread.boundingBox(),
      ]);
      expect(avatarBox.x + avatarBox.width).toBeLessThanOrEqual(triggerBox.x);
      expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(
        paneBox.x + paneBox.width,
      );
      app.threadSummary(root.id, [getPublicKey(key)], 6);
      const summary = row.locator("[data-thread-summary]");
      await expect(summary).toContainText("6 replies");
      app.observer(
        {
          kind: "turn_completed",
          seq: 2,
          timestamp: new Date().toISOString(),
          channelId: "alpha",
          sessionId: "alignment",
          turnId: "working",
          payload: {},
        },
        key,
      );
      await expect(working).toHaveCount(0);
      await expect(summary).toContainText("6 replies");
    });
  });
}
