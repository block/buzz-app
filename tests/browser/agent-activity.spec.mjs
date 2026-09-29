import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
test.use({
  productionBroker: true,
  // Navigation can publish read positions through the real broker.
  readState: true,
  developmentReact: true,
  historyCounts: { alpha: 1, beta: 1 },
});

const channelActivity = (page) =>
  page.getByRole("region", {
    name: "Agent activity in this channel",
    exact: true,
  });
const channelScope = "Channel activity, including other threads";
const activityPopup = (page) =>
  page.getByRole("dialog").filter({
    has: page.getByRole("button", { name: "Close activity", exact: true }),
  });

async function openSidePanel(page, entry, keyboard = false) {
  if (keyboard) {
    await entry.focus();
    await entry.press("Shift+F10");
  } else {
    await entry.click({ button: "right" });
  }
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", {
      name: "Open activity in side panel",
      exact: true,
    })
    .click();
  // Base UI may retain a closing portal; wait before resizing or measuring.
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  await expect(activityPanel(page)).toBeVisible();
  await expect(entry).toHaveAttribute("aria-expanded", "false");
}

async function expectHistoryPlacement(region, history, form) {
  await expect(region).toBeVisible();
  await expect
    .poll(() =>
      region.evaluate(
        (element) =>
          element.closest(
            '[data-channel-timeline], [aria-label="Thread messages"]',
          ) !== null,
      ),
    )
    .toBe(true);
  await expect(region.locator("[data-message-id]")).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const entry = await region.boundingBox();
        const feed = await history.boundingBox();
        const composer = await form.boundingBox();
        const lastMessage = await history
          .locator("[data-message-id]")
          .last()
          .boundingBox();
        return (
          entry.y >= lastMessage.y + lastMessage.height &&
          entry.y >= feed.y &&
          entry.y + entry.height <= feed.y + feed.height &&
          feed.y + feed.height <= composer.y
        );
      },
      {
        message:
          "activity is the visible history tail, not a composer accessory",
      },
    )
    .toBe(true);
  const avatar = region.locator(".buzz-avatar").first();
  await expect
    .poll(
      async () => {
        const actual = await avatar.boundingBox();
        // Message avatars sit inside a bordered profile button; compare the
        // outer avatar slot, not its one-pixel-inset image.
        const messageX = await history
          .locator("[data-message-id]")
          .last()
          .locator(".buzz-avatar")
          .first()
          .evaluate(
            (element) =>
              (element.closest("button") ?? element).getBoundingClientRect().x,
          );
        return Math.abs(actual.x - messageX);
      },
      { message: "activity avatar aligns with message avatars" },
    )
    .toBeLessThan(1);
}
const activityPanel = (page) =>
  page
    .getByRole("region", { name: "Agent activity", exact: true })
    .or(page.getByRole("tabpanel", { name: "Activity", exact: true }));
async function showActivityDetails(panel) {
  // Thought entries now have their own Details control; this opens panel metadata.
  const details = panel
    .getByRole("button", { name: "Details", exact: true })
    .and(panel.locator('button:not([aria-label="Readable activity"] button)'));
  await expect(details).toBeVisible();
  if ((await details.getAttribute("aria-expanded")) === "false")
    await details.click();
}
const activity = (kind, channelId, turnId, payload) => ({
  kind,
  seq: 1,
  timestamp: new Date().toISOString(),
  channelId,
  sessionId: "S",
  turnId,
  ...(payload === undefined ? {} : { payload }),
});

// Channel diagnostics remain reachable from profiles without a channel activity tail.
async function profileEntry(
  page,
  app,
  key,
  content,
  createdAt = Math.floor(Date.now() / 1000),
) {
  const message = finalizeEvent(
    {
      kind: 9,
      tags: [["h", "alpha"]],
      content,
      created_at: createdAt,
    },
    key,
  );
  app.relay.publish("primary", message);
  return page
    .getByRole("region", { name: "Channel message history", exact: true })
    .locator(`[data-message-id="${message.id}"]`)
    .getByRole("button", { name: /profile/ });
}
async function expectProfileActivitySelected(page) {
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  const tab = profile.getByRole("tab", { name: "Activity", exact: true });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(activityPanel(page)).toBeVisible();
  // The shared underline animates independently of the newly mounted content.
  // Establish its settled geometry before visual review, rather than freezing Info.
  await expect
    .poll(async () => {
      const actual = await profile
        .locator(".buzz-tabs-indicator")
        .boundingBox();
      const selected = await tab.boundingBox();
      return actual && selected
        ? Math.max(
            Math.abs(actual.x - selected.x),
            Math.abs(actual.width - selected.width),
          )
        : Infinity;
    })
    .toBeLessThan(1);
}
async function openProfileActivity(page, avatar) {
  await avatar.click();
  await page
    .getByRole("complementary", { name: "Profile", exact: true })
    .getByRole("tab", { name: "Activity", exact: true })
    .click();
  await expectProfileActivitySelected(page);
}

test("profile activity consumes telemetry, isolates mixed batches, selects agents, and resets on disable", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("button", { name: "Agent Activity", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const firstKey = generateSecretKey(),
    secondKey = generateSecretKey();
  const first = getPublicKey(firstKey),
    second = getPublicKey(secondKey);
  const firstAvatar = await profileEntry(
    page,
    app,
    firstKey,
    "First diagnostic agent",
  );
  const secondAvatar = await profileEntry(
    page,
    app,
    secondKey,
    "Second diagnostic agent",
  );
  const unsafe = app.observer(
    activity("turn_liveness", "alpha", "one", {
      text: '<img src=x onerror="window.telemetryExecuted=true">',
    }),
    firstKey,
  );
  app.observer(activity("turn_liveness", "alpha", "two"), secondKey);
  app.observer(
    {
      kind: "batch",
      timestamp: new Date().toISOString(),
      channelId: "alpha",
      payload: {
        events: [
          activity("acp_read", "alpha", "one", "wanted child"),
          activity("acp_write", "beta", "other-channel", "other channel"),
        ],
      },
    },
    firstKey,
  );
  await openProfileActivity(page, firstAvatar);
  const panel = activityPanel(page);
  await showActivityDetails(panel);
  await expect(panel.locator("code").filter({ hasText: first })).toHaveText(
    first,
  );
  await expect(
    panel.getByLabel("Activity channel", { exact: true }),
  ).toHaveText("#Alpha");
  await expect(panel.getByText("Working now", { exact: true })).toBeVisible();
  await expect(channelActivity(page)).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Channel message history", exact: true })
      .getByRole("region", { name: "Message agent activity", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Raw events", exact: true }).click();
  const unsafeDisclosure = panel.getByRole("button", { name: /turn_liveness/ });
  await unsafeDisclosure.focus();
  await unsafeDisclosure.press("Enter");
  await expect(panel.locator("pre code")).toHaveText(unsafe.plaintext);
  expect(await page.evaluate(() => window.telemetryExecuted)).toBeUndefined();
  await unsafeDisclosure.press("Space");
  await expect(panel.locator("pre code")).not.toBeVisible();
  const matchingChild = panel.getByRole("button", { name: /acp_read/ });
  await expect(matchingChild).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toHaveCount(0);
  await matchingChild.click();
  await expect(panel.locator("pre code")).toContainText('"channelId": "alpha"');
  await expect(panel.locator("pre code")).not.toContainText("other channel");
  await page.getByRole("button", { name: "Close channel panel" }).click();
  await expect(firstAvatar).toBeFocused();
  await openProfileActivity(page, secondAvatar);
  await showActivityDetails(panel);
  await expect(panel.locator("code").filter({ hasText: second })).toHaveText(
    second,
  );
  await panel.getByRole("button", { name: "Raw events", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close channel panel" }).click();
  await expect(secondAvatar).toBeFocused();

  const sockets = app.relay.sockets.length;
  const toggle = async () => {
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page
      .getByRole("switch", { name: "Enable Agent Activity", exact: true })
      .click();
  };
  const messages = async () => {
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await page.locator('[data-channel-id="alpha"]').click();
  };
  await toggle();
  await expect
    .poll(() => app.relay.hasRoute("primary", "observer"))
    .toBe(false);
  expect(app.relay.sockets).toHaveLength(sockets);
  await messages();
  await expect(channelActivity(page)).toHaveCount(0);
  await toggle();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  await messages();
  await openProfileActivity(page, firstAvatar);
  await expect(panel.getByText("No activity captured yet")).toBeVisible();
  app.observer(activity("turn_liveness", "alpha", "after-reset"), firstKey);
  await showActivityDetails(panel);
  await panel.getByRole("button", { name: "Raw events", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  app.observer(activity("turn_completed", "alpha", "after-reset"), firstKey);
  await expect(
    panel.getByRole("button", { name: /turn_completed/ }),
  ).toBeVisible();
  await expect(panel.getByText("Working now", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close channel panel" }).click();
  await openProfileActivity(page, secondAvatar);
  await expect(panel.getByText("No activity captured yet")).toBeVisible();
});

for (const mode of ["light", "dark"]) {
  test(`profile activity and raw disclosure fit wide and narrow layouts in ${mode}`, async ({
    page,
    app,
  }, testInfo) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
    }, mode);
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const agentKey = generateSecretKey();
    const agent = getPublicKey(agentKey);
    const sampleProfile = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({
          display_name: "Sample agent",
          is_agent: true,
          about: "Synthetic preview, not live account activity.",
        }),
      },
      agentKey,
    );
    // Only this isolated fixture knows this ephemeral profile. No production data.
    await page.route("**/api/relay/**/query", async (route) => {
      const response = await route.fetch();
      const events = await response.json();
      const filters = route.request().postDataJSON();
      if (
        Array.isArray(events) &&
        filters.some(
          (filter) =>
            filter.kinds?.includes(0) && filter.authors?.includes(agent),
        )
      )
        return route.fulfill({
          response,
          json: [
            ...events.filter(
              (event) => event.pubkey !== agent || event.kind !== 0,
            ),
            sampleProfile,
          ],
        });
      return route.fulfill({ response });
    });
    const avatar = await profileEntry(
      page,
      app,
      agentKey,
      "Sample: translate the lion report into Spanish.",
    );
    const secondKey = generateSecretKey();
    app.observer(
      activity("turn_liveness", "alpha", "second-layout"),
      secondKey,
    );
    app.observer(
      activity("acp_read", "alpha", "layout", {
        method: "session/update",
        params: {
          sessionId: "S",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "I’m translating the report into Spanish, then checking the result.",
            },
          },
        },
        diagnostic: "A long literal raw record. ".repeat(40),
      }),
      agentKey,
    );
    app.observer(
      activity("acp_read", "alpha", "layout", {
        method: "session/update",
        params: {
          sessionId: "S",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "read",
            title: "buzz-dev-mcp__read_file",
            status: "completed",
            rawInput: { path: "OUTBOX/LIONS.md" },
            content: [
              {
                type: "content",
                content: { type: "text", text: "Readable output ".repeat(200) },
              },
            ],
          },
        },
      }),
      agentKey,
    );
    for (const update of [
      {
        sessionUpdate: "tool_call",
        toolCallId: "edit",
        title: "buzz-dev-mcp__str_replace",
        status: "completed",
        rawInput: {
          path: "OUTBOX/LIONS_ES.md",
          old_str: "El leon",
          new_str: "El león",
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "check",
        title: "buzz-dev-mcp__shell",
        status: "in_progress",
        rawInput: { command: "wc -w OUTBOX/LIONS_ES.md" },
      },
    ])
      app.observer(
        activity("acp_read", "alpha", "layout", {
          method: "session/update",
          params: { sessionId: "S", update },
        }),
        agentKey,
      );
    app.observer(
      activity("session_config_captured", "alpha", "layout", {
        configOptions: [],
      }),
      agentKey,
    );
    await openProfileActivity(page, avatar);
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);

    const panel = activityPanel(page);
    const readable = panel.getByRole("region", {
      name: "Readable activity",
      exact: true,
    });
    const tool = readable.getByRole("button", {
      name: "Read file · LIONS.md",
      exact: true,
    });
    await expect(
      readable.getByRole("heading", { name: "Turn", exact: true }),
    ).toHaveCount(0);
    await expect(readable.getByText("Working", { exact: true })).toHaveCount(0);
    const profile = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    await expect(
      profile.getByRole("heading", { name: "Sample agent", exact: true }),
    ).toBeVisible();
    await expect(
      readable.getByRole("button", {
        name: "Edit file · LIONS_ES.md",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      readable.getByRole("button", {
        name: "Run command · wc -w OUTBOX/LIONS_ES.md Running",
        exact: true,
      }),
    ).toBeVisible();
    const communication = readable.getByRole("button", {
      name: /^Communication/,
    });
    const diagnostics = readable.getByRole("button", { name: /^Diagnostics/ });
    if ((await communication.getAttribute("aria-expanded")) === "true")
      await communication.click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // Real-browser geometry: secondary controls align to the tool's leading
      // icon edge and form a compact stack, without cumulative indentation.
      await expect
        .poll(
          async () => {
            const icon = await tool
              .locator("[data-activity-action]")
              .boundingBox();
            const c = await communication
              .locator(":scope > span")
              .boundingBox();
            const d = await diagnostics.locator(":scope > span").boundingBox();
            const cb = await communication.boundingBox();
            const db = await diagnostics.boundingBox();
            return (
              Math.abs(c.x - icon.x) < 1 &&
              Math.abs(d.x - icon.x) < 1 &&
              Math.abs(db.y - (cb.y + cb.height)) < 1
            );
          },
          {
            message:
              "secondary sections align with tool rows and have no extra inter-row gap",
          },
        )
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      await expectProfileActivitySelected(page);
      await profile.screenshot({
        path: testInfo.outputPath(`sample-populated-${mode}-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await tool.focus();
    await tool.press("Enter");
    await expect(readable.getByText("Output", { exact: true })).toBeVisible();
    await expect(readable.locator("pre").last()).toContainText(
      "Readable output",
    );
    // Long output uses the panel's scroll owner, not an inaccessible inner viewport.
    await expect(readable.locator("pre").last()).toHaveCSS(
      "max-height",
      "none",
    );
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(readable.locator("pre code").last()).toBeVisible();
      // ResizeObserver/Base UI remeasure open disclosures after the CSS breakpoint.
      // Existing visibility alone does not establish that the resize has settled.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      await tool.scrollIntoViewIfNeeded();
      await readable.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            // Active labels shimmer indefinitely; only disclosure motion settles.
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      await page.screenshot({
        path: testInfo.outputPath(`activity-${mode}-${width}.png`),
      });
    }
    await tool.press("Space");
    await expect(readable.locator("pre code")).toHaveCount(0);
    await showActivityDetails(panel);
    await expect(
      panel.getByRole("button", { name: "About this feed", exact: true }),
    ).toHaveCount(0);
    await panel
      .getByRole("button", { name: "Raw events", exact: true })
      .click();
    await panel
      .getByRole("button", { name: /acp_read/ })
      .first()
      .click();
    await expect(panel.locator("pre code")).toContainText(
      "A long literal raw record.",
    );
  });
}

const it = test.extend({ readState: true });
it("profile activity opens the exact agent and originating channel before its first frame", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  // The production broker advertises read-state writes even without the
  // readState fixture option. Exercise that publication before profile activity.
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect.poll(() => app.report.readPublications.length).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const agentKey = generateSecretKey();
  const agent = getPublicKey(agentKey);
  const message = finalizeEvent(
    {
      kind: 9,
      tags: [["h", "alpha"]],
      content: "Contextual agent entry",
      created_at: Math.floor(Date.now() / 1000),
    },
    agentKey,
  );
  app.relay.publish("primary", message);
  const avatar = page
    .locator(`[data-message-id="${message.id}"]`)
    .getByRole("button", { name: /profile/ });
  await avatar.waitFor();
  // Reading the live message can outlast the normal publication debounce while
  // the profile is open. Exercise that boundary instead of racing teardown.
  await page
    .getByRole("region", { name: "Channel message history", exact: true })
    .focus();
  await expect
    .poll(() =>
      app.report.readPublications.some(
        ({ community, blob }) =>
          community === "primary" &&
          blob.contexts[`msg:${message.id}`] === message.created_at,
      ),
    )
    .toBe(true);
  await avatar.click();
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await profile.getByRole("tab", { name: "Activity", exact: true }).click();
  await expectProfileActivitySelected(page);
  await expect(profile).toBeVisible();
  const panel = page.getByRole("tabpanel", { name: "Activity", exact: true });
  await expect(
    profile.getByRole("tab", { name: "Activity", exact: true }),
  ).toBeFocused();
  await expect(
    panel.getByRole("combobox", { name: "Agent", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText("No activity captured yet")).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("profile-activity-empty.png"),
  });
  await showActivityDetails(panel);
  await expect(panel.locator("code").filter({ hasText: agent })).toHaveText(
    agent,
  );
  await expect(
    panel.getByLabel("Activity channel", { exact: true }),
  ).toHaveText("#Alpha");
  await expect(panel.getByText("No activity captured yet")).toBeVisible();
  const item = (kind, channelId, turnId) => ({
    kind,
    channelId,
    turnId,
    sessionId: null,
    timestamp: new Date().toISOString(),
  });
  app.observer(item("acp_read", "alpha", "other-agent"), generateSecretKey());
  const expected = app.observer(
    item("turn_liveness", "alpha", "wanted"),
    agentKey,
  );
  await expect(panel.getByText("Working now", { exact: true })).toBeVisible();
  app.observer(item("acp_write", "beta", "other-channel"), agentKey);
  app.observer(item("session_resolved", null, "unscoped"), agentKey);
  await panel.getByRole("button", { name: "Raw events", exact: true }).click();
  const row = panel.getByRole("button", { name: /turn_liveness/ });
  await expect(row).toBeVisible();
  await expect(panel.getByText("Working now", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", {
      name: /acp_read|acp_write|session_resolved/,
    }),
  ).toHaveCount(0);
  await row.click();
  await expect(panel.locator("pre code")).toHaveText(expected.plaintext);
  await panel
    .getByRole("button", { name: "Show #Beta activity", exact: true })
    .click();
  await expect(
    panel.getByLabel("Activity channel", { exact: true }),
  ).toHaveText("#Beta");
  await expect(panel.getByRole("button", { name: /acp_write/ })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /session_resolved|acp_read/ }),
  ).toHaveCount(0);
  await expect(
    panel.getByText("No tool activity captured.", { exact: true }),
  ).toBeVisible();
  const details = panel.getByRole("button", {
    name: "Diagnostics (1)",
    exact: true,
  });
  await details.click();
  await expect(
    panel.getByRole("button", { name: "ACP event", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "Turn wanted", exact: true }),
  ).toHaveCount(0);
  // Old two-slide behavior: selecting the active dot advances to the other channel.
  await panel
    .getByRole("button", { name: "Show #Beta activity", exact: true })
    .click();
  await expect(
    panel.getByLabel("Activity channel", { exact: true }),
  ).toHaveText("#Alpha");
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveCount(0);
  await panel.press("Escape");
  await expect(avatar).toBeFocused();
  await avatar.click();
  await profile.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.locator('[data-channel-id="beta"]').click();
  await expect(panel).toHaveCount(0);
  // Disable removes both registration and profile affordance, not the profile itself.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Agent Activity", exact: true })
    .click();
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await page.locator('[data-channel-id="alpha"]').click();
  await avatar.click();
  await expect(profile).toBeVisible();
  await expect(
    profile.getByRole("tab", { name: "Activity", exact: true }),
  ).toHaveCount(0);
  // Finish the reopened profile's focus handoff and timeline layout before
  // starting read dwell; visible profile content alone proves neither.
  await expect(
    profile.getByRole("region", { name: "Profile details" }),
  ).toBeFocused();
  await settle(page);
  const history = page.getByRole("region", {
    name: "Channel message history",
  });
  await history.focus();
  await expect(history).toBeFocused();
  // Complete ordinary read dwell and publication before fixture teardown.
  await expect
    .poll(() => app.report.readPublications.length)
    .toBeGreaterThan(1);
});

test.describe("thread activity", () => {
  test.use({
    threadUnread: true,
    readState: true,
    historyCounts: { alpha: 2, beta: 1 }, // Thread fixtures replace the last two Alpha rows with roots.
  });

  test("thread typing stays isolated and activity opens beside the preserved thread", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey(),
      agent = getPublicKey(key);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    await row.hover();
    await row.getByRole("button", { name: /^View thread/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
    await expect(
      thread.getByText("Loading thread…", { exact: true }),
    ).toHaveCount(0);
    // Hold signed typing freshness during interaction/layout checks, then advance
    // across the actual eight-second expiry boundary below.
    let clock = new Date();
    await page.clock.setFixedTime(clock);
    const region = thread.getByRole("region", {
      name: "Agent activity in this thread",
      exact: true,
    });
    const marker = page
      .locator('[data-channel-id="alpha"]')
      .getByRole("img", { name: "Agent working", exact: true });
    const sendTyping = (threadId, signingKey = key, secondsAgo = 0) => {
      const event = finalizeEvent(
        {
          kind: 20002,
          created_at: Math.floor(clock.getTime() / 1000) - secondsAgo,
          content: "",
          tags: [
            ["h", "alpha"],
            ...(threadId
              ? [
                  ["e", threadId, "", "root"],
                  ["e", threadId, "", "reply"],
                ]
              : []),
          ],
        },
        signingKey,
      );
      app.relay.publish("primary", event);
      return event;
    };
    // Owner telemetry recognizes the agent without claiming a working channel turn.
    app.observer(activity("turn_liveness", "alpha", "previous"), key);
    const avatar = await profileEntry(
      page,
      app,
      key,
      "Thread agent identity",
      Math.floor(clock.getTime() / 1000),
    );
    await openProfileActivity(page, avatar);
    await expect(
      activityPanel(page).getByText("Working now", { exact: true }),
    ).toBeVisible();
    app.observer(activity("turn_completed", "alpha", "previous"), key);
    await expect(
      activityPanel(page).getByText("Working now", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Close channel panel" }).click();
    // General profile navigation replaces the thread panel; restore the exact
    // root after the observer barrier, before exercising thread-only typing.
    await row.hover();
    await row.getByRole("button", { name: /^View thread/ }).click();
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
    const humanTypingKey = generateSecretKey();
    sendTyping(root.id, humanTypingKey);
    sendTyping("b".repeat(64));
    await expect(region).toHaveCount(0);
    const typing = sendTyping(root.id);
    await expect(region).toBeVisible();
    const threadTyping = thread.getByRole("status", {
      name: "Typing activity",
      exact: true,
    });
    // Telemetry-only agents with no profile/choice hints are represented by their
    // visible Activity row too; their human namesake/peer remains in typing.
    await expect(threadTyping).toContainText(
      getPublicKey(humanTypingKey).slice(0, 10),
    );
    await expect(threadTyping).not.toContainText(agent.slice(0, 10));
    await expect(marker).toHaveCount(0); // Thread-only fallback must not light channel scope.
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(page.locator(`[data-message-id="${typing.id}"]`)).toHaveCount(
      0,
    );
    const entry = region.getByRole("button", { name: "Working…", exact: true });
    const form = thread.getByRole("form", {
      name: "Reply to thread",
      exact: true,
    });
    const history = thread.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    // Browser-only: hover must not steal draft focus or resize thread content.
    const draft = form.getByRole("textbox");
    await draft.fill("Hover preserves this draft");
    await draft.focus();
    await entry.scrollIntoViewIfNeeded();
    const beforePopup = await entry.boundingBox();
    await entry.hover();
    await expect(activityPopup(page)).toBeVisible();
    await expect(draft).toBeFocused();
    await expect
      .poll(async () => (await entry.boundingBox()).y)
      .toBe(beforePopup.y);
    await page.mouse.move(0, 0);
    await expect(activityPopup(page)).toHaveCount(0);
    await expect(draft).toBeFocused();
    await expect(draft).toHaveText("Hover preserves this draft");
    await draft.fill("");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      await expectHistoryPlacement(region, history, form);
      await entry.click();
      await expect(entry).toHaveAttribute("aria-expanded", "true");
      await expect(
        activityPopup(page).getByText(
          "No retained activity is linked to this thread yet.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(activityPanel(page)).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`thread-activity-history-${width}.png`),
      });
      await entry.click();
      await expect(
        activityPopup(page).getByRole("region", { name: "Readable activity" }),
      ).toHaveCount(0);
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    const composer = thread.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await composer.fill("Keep this thread draft");
    await entry.click();
    await expect(entry).toHaveAttribute("aria-expanded", "true");
    // Real browser pointer capture/click suppression cannot be proven in jsdom.
    await entry.scrollIntoViewIfNeeded();
    const box = await entry.boundingBox();
    const x = box.x + 12,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x + 80, y, { steps: 8 });
      await expect(
        region.getByRole("status").filter({
          hasText: "Release to open activity beside the conversation",
        }),
      ).toBeVisible();
    } finally {
      await page.mouse.up();
    }
    await expect(activityPanel(page)).toBeVisible();
    await expect(entry).toHaveAttribute("aria-expanded", "false");
    await expect(
      region.getByRole("status").filter({
        hasText: "Release to open activity beside the conversation",
      }),
    ).toHaveCount(0);
    await expect(composer).toHaveText("Keep this thread draft");
    await activityPanel(page)
      .getByRole("button", { name: "Exact identity", exact: true })
      .click();
    await expect(activityPanel(page).locator("code").first()).toHaveText(agent);
    await expect(
      activityPanel(page).getByText(/Thread activity/),
    ).toBeVisible();
    await expect(activityPanel(page).getByRole("combobox")).toHaveCount(0);
    const board = page.locator('[class*="withActivity"]');
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      await expect(board).toHaveCSS("overflow-x", "auto");
      await expect
        .poll(
          async () => {
            return board.evaluate((element) => {
              const conversation = element.querySelector(
                  ':scope > [aria-label="Conversation"]',
                ),
                thread = element.querySelector('[class*="panelStack"]'),
                activity = element.querySelector('[class*="activityPane"]');
              if (!conversation || !thread || !activity) return false;
              const c = conversation.getBoundingClientRect(),
                t = thread.getBoundingClientRect(),
                a = activity.getBoundingClientRect(),
                b = element.getBoundingClientRect();
              const gap = Number.parseFloat(
                getComputedStyle(element).columnGap,
              );
              const minimum = window.innerWidth <= 650 ? 260 : 320;
              return (
                c.width >= minimum &&
                t.width >= 300 &&
                a.width >= 300 &&
                Math.abs(t.left - c.right - gap) < 1 &&
                Math.abs(a.left - t.right - gap) < 1 &&
                (window.innerWidth < 1000 ||
                  (Math.abs(c.left - b.left) < 1 &&
                    Math.abs(a.right - b.right) < 1))
              );
            });
          },
          {
            message:
              "conversation/thread/activity fill adjacent tracks without phantom sidebar columns",
          },
        )
        .toBe(true);
      if (width < 1000) {
        await expect
          .poll(() =>
            board.evaluate(
              (element) => element.scrollWidth > element.clientWidth,
            ),
          )
          .toBe(true);
        await activityPanel(page).scrollIntoViewIfNeeded();
        await expect(activityPanel(page)).toBeInViewport();
        await composer.scrollIntoViewIfNeeded();
        await expect(composer).toBeInViewport();
      }
      await expect(composer).toHaveText("Keep this thread draft");
      await page.screenshot({
        path: testInfo.outputPath(`thread-activity-side-by-side-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    // Main's settings pane hides rather than remounts the thread and Activity.
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    const settings = page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    await expect(thread).toBeHidden();
    await expect(activityPanel(page)).toBeHidden();
    await settings
      .getByRole("button", { name: "Close channel settings", exact: true })
      .click();
    await expect(thread).toBeVisible();
    await expect(activityPanel(page)).toBeVisible();
    await expect(composer).toHaveText("Keep this thread draft");
    await expect(activityPanel(page).locator("code").first()).toHaveText(agent);
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    await expect(activityPanel(page)).toHaveCount(0);
    await expect(entry).toBeFocused();
    await expect(composer).toHaveText("Keep this thread draft");

    // A real reply clears thread typing. Missing send evidence cannot widen the
    // completed response disclosure back into unrelated channel-wide activity.
    const reply = finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        content: "Completed agent reply",
        tags: [
          ["h", "alpha"],
          ["e", root.id, "", "reply"],
        ],
      },
      key,
    );
    app.relay.publish("primary", reply);
    const replyRow = history.locator(`[data-message-id="${reply.id}"]`);
    const replyEntry = replyRow.getByRole("button", {
      name: "View activity",
      exact: true,
    });
    await expect(replyEntry).toBeVisible();
    await expect(region).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const disclosure = await replyEntry.boundingBox();
          const body = await replyRow
            .getByText("Completed agent reply", { exact: true })
            .boundingBox();
          return disclosure.y + disclosure.height <= body.y;
        },
        { message: "View activity precedes the real reply body" },
      )
      .toBe(true);
    await replyEntry.click();
    await expect(replyEntry).toHaveAttribute("aria-expanded", "true");
    const unavailable = "No retained activity is linked to this thread yet.";
    await expect(
      activityPopup(page).getByText(unavailable, { exact: true }),
    ).toHaveText(unavailable);
    await expect(
      activityPopup(page).getByText(channelScope, { exact: true }),
    ).toHaveCount(0);
    await expect(
      activityPopup(page)
        .getByRole("region", { name: "Readable activity" })
        .getByRole("button"),
    ).toHaveCount(0);
    await expect(activityPanel(page)).toHaveCount(0);
    await openSidePanel(page, replyEntry, true);
    await expect(composer).toHaveText("Keep this thread draft");
    await expect(
      activityPanel(page).getByText(
        "No retained activity linked to this thread yet.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(activityPanel(page).getByRole("combobox")).toHaveCount(0);
    await expect(
      activityPanel(page)
        .getByRole("region", { name: "Readable activity" })
        .getByRole("button"),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    await expect(replyEntry).toBeFocused();
    // The profile-entry channel message suppressed delayed channel typing for
    // two seconds. Move the controlled clock past that real scope boundary.
    clock = new Date(clock.getTime() + 3_000);
    await page.clock.setFixedTime(clock);
    sendTyping();
    await expect(marker).toBeVisible();
    await expect(channelActivity(page)).toHaveCount(0);
    await page.clock.setFixedTime(new Date(clock.getTime() + 7_000));
    await expect(marker).toBeVisible();
    await page.clock.setFixedTime(new Date(clock.getTime() + 9_000));
    await expect(marker).toHaveCount(0, { timeout: 10_000 });
    await expect(channelActivity(page)).toHaveCount(0);
  });
});

test.describe("local agent request", () => {
  test.use({
    actionProfile: true,
    hasTouch: true,
    threadUnread: true,
    readState: true,
    historyCounts: { alpha: 2, beta: 1 },
  });

  // Browser-only boundary: actual member picker/composer, signing-gated outbox,
  // automatic local-root navigation, signed replies replacing the tail, and the
  // same response-specific work surviving inline-to-panel detachment.
  test("send stays in the channel until a thread click; every agent retains thread-wide activity through replies", async ({
    page,
    app,
  }, testInfo) => {
    const key = (seed) =>
      Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? seed : 0));
    const agentKey = key(5),
      agent = getPublicKey(agentKey);
    // Both initial discovery and each finite mention preflight must see the same
    // relay-authorized roster; changing only the live cache is insufficient.
    await page.route("**/api/relay/**/query", async (route) => {
      const response = await route.fetch();
      const events = await response.json();
      if (!Array.isArray(events)) return route.fulfill({ response });
      const updated = events.map((event) => {
        if (
          event.kind === 39002 &&
          event.tags.some(([name, id]) => name === "d" && id === "alpha")
        ) {
          return finalizeEvent(
            {
              kind: event.kind,
              created_at: event.created_at + 1,
              tags: [
                ...event.tags.filter(
                  ([name, value]) => name !== "p" || value !== agent,
                ),
                ["p", agent],
              ],
              content: event.content,
            },
            key(1),
          );
        }
        if (event.kind === 0 && event.pubkey === agent) {
          return finalizeEvent(
            {
              kind: 0,
              created_at: event.created_at + 1,
              tags: [],
              content: JSON.stringify({
                display_name: "Alice Fixture",
                is_agent: true,
              }),
            },
            agentKey,
          );
        }
        return event;
      });
      await route.fulfill({ response, json: updated });
    });
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const form = page.getByRole("form", {
      name: "Send a message to Alpha",
      exact: true,
    });
    await form
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Mention a member or agent",
    });
    await picker
      .getByRole("button", { name: `Alice Fixture ${agent}`, exact: true })
      .click();
    const composer = form.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.press("End");
    // Completing a mention must leave ordinary prose outside the suggestion
    // publication lifecycle. Keep the full native typing path before any send.
    const prose =
      "Please inspect the request with additional ordinary prose. ".repeat(3);
    await composer.pressSequentially(prose);
    await expect(composer).toHaveJSProperty("value", `@Alice Fixture ${prose}`);
    await expect(
      page.getByRole("listbox", { name: "Mention suggestions", exact: true }),
    ).toHaveCount(0);
    expect(app.report.consoleErrors).toEqual([]);
    let release, signing;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      signing = resolve;
    });
    await page.route("**/api/relay/**/sign", async (route) => {
      if (route.request().postDataJSON().kind !== 9) return route.continue();
      signing();
      await held;
      await route.continue();
    });
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const region = thread.getByRole("region", {
      name: "Agent activity in this thread",
      exact: true,
    });
    try {
      await form
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await started;
      await expect(thread).toHaveCount(0);
      const pendingThread = page
        .getByRole("region", { name: "Channel message history", exact: true })
        .getByRole("button", {
          name: "View thread: 1 agent awaiting response",
          exact: true,
        });
      await expect(pendingThread).toBeVisible();
      await pendingThread.click();
      await expect(thread).toBeVisible();
      await expect(
        thread.getByText(/Please inspect the request/),
      ).toBeVisible();
      const sending = region.getByRole("button", {
        name: "Sending request…",
        exact: true,
      });
      await expect(sending).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Private activity", exact: true }),
      ).toHaveCount(0);
      await page.mouse.move(0, 0);
      await sending.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(sending).toBeFocused();
      await expect(
        page.getByText(/Private to your account|Only visible to you/),
      ).toHaveCount(0);
      await expect(sending).not.toHaveAttribute("aria-description");
      await expect(sending).toHaveAttribute("aria-expanded", "false");
      await page.mouse.move(0, 0);
      await form.getByRole("textbox").focus();
      await expect(
        thread.getByText("0 replies · 1 pending", { exact: true }),
      ).toBeVisible();
      const channelRequest = page.getByRole("region", {
        name: "Channel message history",
        exact: true,
      });
      await expect(
        channelRequest.getByRole("button", {
          name: "View thread: 1 agent awaiting response",
          exact: true,
        }),
      ).toContainText("1 agent awaiting response");
      await expect(
        page.getByText("View agent thread", { exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("immediate-agent-thread.png"),
      });
      await expect(channelActivity(page)).toHaveCount(0);
      expect(
        app.report.publications.filter(({ event }) => event.kind === 9),
      ).toHaveLength(0);
      await sending.click();
      await expect(
        activityPopup(page).getByText(
          "No retained activity is linked to this thread yet.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        activityPopup(page).getByText(channelScope, { exact: true }),
      ).toHaveCount(0);
      await sending.click();
    } finally {
      release();
    }
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(1);
    const request = app.report.publications.find(
      ({ event }) => event.kind === 9,
    ).event;
    expect(request.tags).toContainEqual(["p", agent]);
    expect(request.tags.some(([name]) => name === "e")).toBe(false);
    await expect(
      thread.locator(`[data-message-id="${request.id}"]`),
    ).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: "Waiting for response…",
        exact: true,
      }),
    ).toBeVisible();
    // Unassociated channel evidence must not claim this exact request is working.
    const sequences = new Map();
    const emitTurn = (turnId, kind, payload) => {
      const seq = (sequences.get(turnId) ?? 0) + 1;
      sequences.set(turnId, seq);
      app.observer(
        { ...activity(kind, "alpha", turnId, payload), seq },
        agentKey,
      );
    };
    const typingText = form.getByRole("status", {
      name: "Typing activity",
      exact: true,
    });
    const humanKey = key(6),
      human = getPublicKey(humanKey);
    const typingAt = Math.floor(Date.now() / 1000);
    const publicTyping = (signer, root) =>
      app.relay.publish(
        "primary",
        finalizeEvent(
          {
            kind: 20002,
            created_at: typingAt,
            content: "",
            tags: [["h", "alpha"], ...(root ? [["e", root, "", "reply"]] : [])],
          },
          signer,
        ),
      );
    publicTyping(agentKey);
    publicTyping(humanKey);
    await expect(typingText).not.toContainText("Alice Fixture");
    await expect(typingText).toContainText(human.slice(0, 10));
    emitTurn("unrelated-work", "turn_liveness");
    await expect(
      region.getByRole("button", {
        name: "Waiting for response…",
        exact: true,
      }),
    ).toBeVisible();
    emitTurn("request-work", "turn_started", {
      triggeringEventIds: [request.id],
    });
    await expect(typingText).not.toContainText("Alice Fixture");
    await expect(typingText).toContainText(human.slice(0, 10));
    publicTyping(agentKey, request.id);
    publicTyping(humanKey, request.id);
    const threadTyping = thread.getByRole("status", {
      name: "Typing activity",
      exact: true,
    });
    await expect(threadTyping).toContainText(human.slice(0, 10));
    await expect(threadTyping).not.toContainText("Alice Fixture");
    // Known agents remain absent even when Activity is hidden; human typing remains.
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await expect(typingText).not.toContainText("Alice Fixture");
    await page
      .getByRole("button", { name: "Close channel settings", exact: true })
      .click();
    await expect(typingText).not.toContainText("Alice Fixture");
    await openSidePanel(
      page,
      region.getByRole("button", { name: "Working…", exact: true }),
    );
    await expect(
      activityPanel(page).getByText(/Thread activity/),
    ).toBeVisible();
    await expect(activityPanel(page).getByRole("combobox")).toHaveCount(0);
    for (let step = 0; step < 7; step++)
      emitTurn("request-work", "acp_read", {
        method: "session/update",
        params: {
          sessionId: "S",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `step-${step}`,
            title: `Reading file ${step}`,
            status: "completed",
          },
        },
      });
    const stream = activityPanel(page).getByRole("region", {
      name: "Readable activity",
      exact: true,
    });
    await expect(
      stream.getByRole("button", { name: /tool calls/ }),
    ).toHaveCount(0);
    await expect(
      stream.getByRole("button", { name: /Reading file/ }),
    ).toHaveCount(7);
    await expect(
      stream.getByRole("button", { name: /Show all activity/ }),
    ).toHaveCount(0);
    await expect(
      activityPanel(page).getByText(/Only visible to you/),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    emitTurn("request-work", "turn_completed");
    // Request-linked telemetry, not public typing, drives live work. Observe
    // real pending and completed tool updates before publishing any chat reply.
    const pendingTurn = "exact-request-work";
    emitTurn(pendingTurn, "turn_started", {
      triggeringEventIds: [request.id],
    });
    const working = region.getByRole("button", {
      name: "Working…",
      exact: true,
    });
    await expect(working).toBeVisible();
    await working.click();
    const pendingWork = activityPopup(page).getByRole("region", {
      name: "Readable activity",
      exact: true,
    });
    const pendingUpdate = (update) =>
      emitTurn(pendingTurn, "acp_read", {
        method: "session/update",
        params: { sessionId: "S", update },
      });
    const commands = [
      `printf '%s' '${"literal request inspection ".repeat(5)}'\npwd`,
      "wc -w < OUTBOX/REPORT.md",
      "git diff --stat",
      "git status --short",
      "cat OUTBOX/REPORT.md",
      "wc -l OUTBOX/REPORT.md",
    ];
    const commandPreview = (command) => {
      const line = command.split("\n")[0];
      return line.length > 90 ? `${line.slice(0, 90)}…` : line;
    };
    const toolRow = (step, status) =>
      pendingWork.getByRole("button", {
        name: `Run command · ${commandPreview(commands[step])}${status === "Completed" ? "" : ` ${status}`}`,
        exact: true,
      });
    const startTool = (step) =>
      pendingUpdate({
        sessionUpdate: "tool_call",
        toolCallId: `inspect-${step}`,
        title: "buzz-dev-mcp__shell",
        status: "pending",
        rawInput: { command: commands[step], cwd: "/same/workspace" },
      });
    const finishTool = (step) =>
      pendingUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: `inspect-${step}`,
        status: "completed",
      });
    pendingUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspecting the requested work" },
    });
    await expect(
      region.getByRole("button", { name: "Thinking…", exact: true }),
    ).toBeVisible();
    startTool(0);
    await expect(
      region.getByRole("button", {
        name: `Running ${commandPreview(commands[0])}`,
        exact: true,
      }),
    ).toBeVisible();
    startTool(1);
    await expect(working).toBeVisible();
    const firstTool = toolRow(0, "Pending");
    await expect(firstTool).toBeVisible();
    await firstTool.click();
    await expect(firstTool).toHaveAttribute("aria-expanded", "true");
    await expect(toolRow(1, "Pending")).toBeVisible();
    await expect(pendingWork).not.toContainText("/same/workspace");
    finishTool(0);
    finishTool(1);
    await expect(toolRow(0, "Completed")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(toolRow(1, "Completed")).toBeVisible();
    await expect(
      region.getByRole("button", {
        name: /^Last action: Run command · /,
      }),
    ).toBeVisible();
    await expect(
      pendingWork.getByRole("heading", { name: "Turn", exact: true }),
    ).toHaveCount(0);
    await expect(pendingWork.locator("time")).toHaveCount(0);
    await expect(
      activityPopup(page).getByText(channelScope, { exact: true }),
    ).toHaveCount(0);
    await toolRow(0, "Completed").click();
    await expect(toolRow(0, "Completed")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    startTool(2);
    finishTool(2);
    await expect(toolRow(2, "Completed")).toBeVisible();
    await expect(toolRow(0, "Completed")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(
      region.getByRole("button", {
        name: /^Last action: Run command · /,
      }),
    ).toBeVisible();
    // Live thread inspection keeps all retained tools, without a sliding five-entry cap.
    for (let step = 3; step < commands.length; step++) {
      startTool(step);
      finishTool(step);
    }
    for (let step = 0; step < commands.length; step++)
      await expect(toolRow(step, "Completed")).toBeVisible();
    await expect(
      pendingWork.getByRole("button", { name: /Show all activity/ }),
    ).toHaveCount(0);
    // The header is the only collapse affordance; no end-of-content caret.
    await expect(
      region.getByRole("button", { name: "Collapse activity", exact: true }),
    ).toHaveCount(0);
    await expect(
      thread.getByRole("region", {
        name: "Message agent activity",
        exact: true,
      }),
    ).toHaveCount(0);
    await openSidePanel(
      page,
      region.getByRole("button", {
        name: /^Last action: Run command · /,
      }),
      true,
    );
    await expect(activityPanel(page)).toContainText("git diff --stat");
    await expect(activityPanel(page).getByRole("combobox")).toHaveCount(0);
    await expect(activityPanel(page)).not.toContainText("unrelated-work");
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    // A signed coordination reply is communication, not the requested answer.
    const coordination = finalizeEvent(
      {
        kind: 9,
        created_at: request.created_at + 1,
        content: "@Peer please review the findings while I continue.",
        tags: [
          ["h", "alpha"],
          ["e", request.id, "", "reply"],
          ["audience", "agents"],
        ],
      },
      agentKey,
    );
    app.relay.publish("primary", coordination);
    await expect(
      thread.locator(`[data-message-id="${coordination.id}"]`),
    ).toHaveCount(0);
    await expect(
      thread.getByRole("button", { name: /Coordination/ }),
    ).toHaveCount(0);
    await expect(region).toBeVisible();
    await expect(
      thread.getByText("0 replies · 1 pending", { exact: true }),
    ).toBeVisible();
    const reply = finalizeEvent(
      {
        kind: 9,
        created_at: request.created_at + 2,
        content: "Actual threaded agent response",
        tags: [
          ["h", "alpha"],
          ["audience", "everyone"],
          ["e", request.id, "", "reply"],
        ],
      },
      agentKey,
    );
    // One new turn contains two nonoverlapping send intervals. Earlier diagnostic
    // records deliberately remain in the feed but cannot supply response work.
    const turn = "response-specific-work";
    let seq = 0;
    const emit = (kind, payload) =>
      app.observer(
        { ...activity(kind, "alpha", turn, payload), seq: ++seq },
        agentKey,
      );
    const update = (value) =>
      emit("acp_read", {
        method: "session/update",
        params: { sessionId: "S", update: value },
      });
    const responseWork = (message, thought, toolCallId, preparation = "") => {
      update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: thought },
      });
      update({
        sessionUpdate: "tool_call",
        toolCallId,
        title: "buzz-dev-mcp__shell",
        status: "in_progress",
        rawInput: {
          command: `${preparation}printf '%s' 'Sample' | buzz messages send --channel alpha --reply-to ${request.id} --content -`,
        },
      });
      emit("prompt_context_delivery", { promptBytes: 123, eventDeltaCount: 1 });
      emit("acp_read", {
        id: toolCallId,
        method: "session/request_permission",
        params: {
          options: [{ optionId: "allow-captured", kind: "allow_once" }],
        },
      });
      emit("acp_write", {
        id: toolCallId,
        result: {
          outcome: { outcome: "selected", optionId: "allow-captured" },
        },
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { isError: false },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: JSON.stringify({
                exit_code: 0,
                timed_out: false,
                stdout_truncated: false,
                stderr_truncated: false,
                stderr: "",
                stdout: `${toolCallId === "send-first" ? "499\n" : ""}${JSON.stringify(
                  {
                    accepted: true,
                    event_id: message.id,
                    message: "",
                    mention_pubkeys: [],
                    ...(toolCallId === "send-first"
                      ? { audience: "everyone" }
                      : toolCallId === "send-coordination"
                        ? { audience: "agents" }
                        : {}),
                  },
                )}\n`,
              }),
            },
          },
        ],
      });
    };
    const firstThought =
      "Inspecting the initial request before the first response";
    const correctionThought =
      "Checking the revised result before the correction";
    emit("turn_started", { triggeringEventIds: [request.id] });
    responseWork(
      coordination,
      "Asking a peer while continuing work",
      "send-coordination",
    );
    // Coordination evidence stays accessible in Activity, not as a conversation row.
    await openSidePanel(page, region.getByRole("button").first());
    const sendOperation = activityPanel(page).getByRole("button", {
      name: /^Run command · printf.*buzz messages send/,
    });
    await sendOperation.click();
    await expect(
      activityPanel(page).getByText(
        "Send message · Reported sent · Reported coordination",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    await expect(
      thread.locator(`[data-message-id="${coordination.id}"]`),
    ).toHaveCount(0);
    responseWork(reply, firstThought, "send-first");
    app.relay.publish("primary", reply);
    const replyRow = thread.locator(`[data-message-id="${reply.id}"]`);
    await expect(
      replyRow.getByText(reply.content, { exact: true }),
    ).toBeVisible();
    await expect(
      replyRow.getByRole("button", { name: "View activity", exact: true }),
    ).toBeVisible();
    await expect(region).toBeVisible();
    const replyEntry = replyRow.getByRole("button", {
      name: "View activity",
      exact: true,
    });
    await replyEntry.click();
    const firstWork = activityPopup(page).getByRole("region", {
      name: "Readable activity",
      exact: true,
    });
    await expect(
      firstWork.getByRole("button", { name: /Reading file/ }),
    ).toHaveCount(7);
    await expect(
      firstWork.getByText(firstThought, { exact: true }),
    ).toHaveCount(0);
    await firstWork.getByRole("button", { name: /^Communication/ }).click();
    await expect(
      firstWork.getByText(firstThought, { exact: true }),
    ).toBeVisible();
    await firstWork.getByRole("button", { name: /^Communication/ }).click();
    await expect(
      replyRow.getByText(
        "Retained activity through this response’s reported send. The feed may have gaps.",
        {
          exact: true,
        },
      ),
    ).toHaveCount(0);
    await expect(
      activityPopup(page).getByText(channelScope, { exact: true }),
    ).toHaveCount(0);

    // The previous response now owns a floating popup, not inline details.
    await activityPopup(page)
      .getByRole("button", { name: "Close activity", exact: true })
      .click();
    await expect(activityPopup(page)).toHaveCount(0);
    const correction = finalizeEvent(
      {
        kind: 9,
        created_at: request.created_at + 3,
        content: "Corrected threaded agent response",
        tags: [
          ["h", "alpha"],
          ["e", request.id, "", "reply"],
        ],
      },
      agentKey,
    );
    responseWork(
      correction,
      correctionThought,
      "send-correction",
      "python3 - <<'PY'\nfrom pathlib import Path\np=Path('OUTBOX/REPORT.md')\np.write_text('Synthetic corrected document')\nPY\ncount=$(wc -w < OUTBOX/REPORT.md | tr -d ' ')\nif [ \"$count\" != 3 ]; then echo bad-count >&2; exit 1; fi\n",
    );
    app.relay.publish("primary", correction);
    const correctionRow = thread.locator(
      `[data-message-id="${correction.id}"]`,
    );
    await expect(
      correctionRow.getByText(correction.content, { exact: true }),
    ).toBeVisible();
    const correctionEntry = correctionRow.getByRole("button", {
      name: "View activity",
      exact: true,
    });
    await correctionEntry.hover();
    await expect(
      page.getByText(/Private to your account|Only visible to you/),
    ).toHaveCount(0);
    await expect(correctionEntry).not.toHaveAttribute("aria-description");
    await expect(correctionEntry).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("button", { name: "Private activity", exact: true }),
    ).toHaveCount(0);
    const previousViewport = page.viewportSize();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.mouse.move(0, 0);
      await thread
        .getByRole("textbox", { name: "Reply to thread", exact: true })
        .focus();
      await correctionEntry.hover();
      await expect(
        page.getByText(
          /Private to your account|Only visible to you|Retained activity through/,
        ),
      ).toHaveCount(0);
      await expect(correctionEntry).toHaveAttribute("aria-expanded", "true");
      await page.screenshot({
        path: testInfo.outputPath(`response-activity-${width}.png`),
      });
      await page.mouse.move(0, 0);
      await thread
        .getByRole("textbox", { name: "Reply to thread", exact: true })
        .focus();
      await expect(correctionEntry).not.toHaveAttribute("aria-description");
    }
    await page.setViewportSize(previousViewport);
    // End hover before choosing a persistent click-open popup; resizing may move the anchor.
    await page.mouse.move(0, 0);
    await thread
      .getByRole("textbox", { name: "Reply to thread", exact: true })
      .focus();
    await expect(activityPopup(page)).toHaveCount(0);
    await correctionEntry.focus();
    await correctionEntry.press("Enter");
    await expect(correctionEntry).toHaveAttribute("aria-expanded", "true");
    const correctionWork = activityPopup(page).getByRole("region", {
      name: "Readable activity",
      exact: true,
    });
    await expect(
      correctionWork.getByRole("button", { name: /Reading file/ }),
    ).toHaveCount(7);
    await expect(
      correctionWork.getByRole("button", { name: /^Run command/ }),
    ).toHaveCount(9);
    await expect(
      correctionWork.getByText(correctionThought, { exact: true }),
    ).toHaveCount(0);
    await correctionWork
      .getByRole("button", { name: /^Communication/ })
      .click();
    await expect(
      correctionWork.getByText(firstThought, { exact: true }),
    ).toBeVisible();
    await expect(
      correctionWork.getByText(correctionThought, { exact: true }),
    ).toBeVisible();
    await correctionWork
      .getByRole("button", { name: /^Communication/ })
      .click();
    // Tool details remain primary, including the exact send's command/result/raw halves.
    const correctionTool = correctionWork.getByRole("button", {
      name: /^Run command · python3/,
    });
    await correctionTool.focus();
    await correctionTool.press("Enter");
    await expect(correctionTool).toHaveAttribute("aria-expanded", "true");
    await expect(
      correctionWork.getByText("Command", { exact: true }),
    ).toBeVisible();
    const inlineOutput = correctionWork.locator("pre").last();
    await expect(inlineOutput).toContainText(correction.id);
    await expect(inlineOutput).not.toContainText(reply.id);
    const outputContents = await inlineOutput.textContent();
    const raw = correctionWork.getByRole("button", {
      name: "Raw source",
      exact: true,
    });
    await raw.focus();
    await raw.press("Enter");
    await expect(correctionWork.locator("pre").last()).toContainText(
      '"sessionUpdate"',
    );
    await expect(correctionWork.locator("pre").last()).toContainText(
      correction.id,
    );
    await raw.press("Space");
    await expect(correctionWork.locator("pre").last()).toHaveText(
      outputContents,
    );
    await correctionTool.click();
    await expect(correctionWork.locator("pre")).toHaveCount(0);
    const primaryLabels = await correctionWork
      .getByRole("button", { name: /^Run command|Reading file/ })
      .allTextContents();
    await openSidePanel(page, correctionEntry, true);
    const panel = activityPanel(page);
    const detachedWork = panel.getByRole("region", {
      name: "Readable activity",
      exact: true,
    });
    await expect(
      detachedWork.getByRole("button", { name: /^Run command|Reading file/ }),
    ).toHaveText(primaryLabels);
    const diagnostics = detachedWork.getByRole("button", {
      name: /^Diagnostics/,
    });
    await diagnostics.focus();
    await diagnostics.press("Enter");
    await expect(
      detachedWork
        .getByRole("button", { name: "Permission allowed", exact: true })
        .last(),
    ).toBeVisible();
    await diagnostics.press("Space");
    await expect(
      detachedWork.getByRole("button", {
        name: "Permission allowed",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      detachedWork.getByText(firstThought, { exact: true }),
    ).toHaveCount(0);
    await detachedWork.getByRole("button", { name: /^Communication/ }).click();
    await expect(
      detachedWork.getByText(firstThought, { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Raw events", exact: true }),
    ).toHaveCount(0);
    await detachedWork
      .getByRole("button", { name: /^Run command · python3/ })
      .click();
    await expect(detachedWork.locator("pre").last()).toHaveText(outputContents);
    await expect(detachedWork.locator("pre").last()).not.toContainText(
      reply.id,
    );
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    await expect(correctionEntry).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("agent-thread-response.png"),
    });
    await expect(
      thread.locator(`[data-message-id="${request.id}"]`),
    ).toHaveCount(1);
    await expect(thread.locator(`[data-message-id="${reply.id}"]`)).toHaveCount(
      1,
    );
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Channel message history", exact: true })
        .getByRole("region", { name: "Message agent activity", exact: true }),
    ).toHaveCount(0);
  });
});
