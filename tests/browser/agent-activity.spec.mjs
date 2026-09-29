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
