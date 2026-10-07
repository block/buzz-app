import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { npubEncode } from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
test.use({
  productionBroker: true,
  // Navigation can publish read positions through the real broker.
  readState: true,
  developmentReact: true,
});

const channelActivity = (page) =>
  page.getByRole("region", {
    name: "Agent activity in this channel",
    exact: true,
  });
const expandChannelActivity = async (page) => {
  const disclosure = channelActivity(page).locator("details");
  await expect(disclosure).toBeVisible();
  if (!(await disclosure.evaluate((element) => element.open)))
    await disclosure.locator("summary").click();
};
const agentEntry = (page, agent) =>
  channelActivity(page).getByRole("button", {
    name: new RegExp(
      `^View activity for .+ ${agent.slice(0, 12)}(?:, Presence: (?:online|away|offline))?$`,
    ),
  });
const activityPanel = (page) =>
  page.getByRole("region", { name: "Agent activity", exact: true });
const activity = (kind, channelId, turnId, payload) => ({
  kind,
  seq: 1,
  timestamp: new Date().toISOString(),
  channelId,
  sessionId: "S",
  turnId,
  ...(payload === undefined ? {} : { payload }),
});

test("sidebar activity opens the working agent panel", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  const agent = getPublicKey(key);
  app.observer(activity("turn_liveness", "alpha", "sidebar"), key);
  const row = page.locator('[data-channel-id="alpha"]');
  await expect(
    row.getByRole("img", { name: /working in Alpha$/ }),
  ).toBeVisible();
  await row.hover();
  const popup = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: /Open conversation for/ }).hover();
  const action = popup.getByRole("button", { name: /View .+ activity/ });
  await expect(action).toBeVisible();
  await action.click();
  await expect(activityPanel(page).locator("code").first()).toHaveText(agent);
});

test("mention picker demands the relay's protected archive snapshot", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Mention a member or agent" }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        app.report.queries.filter(({ filter }) => filter.kinds?.includes(13535))
          .length,
    )
    .toBeGreaterThan(0);
  expect(
    app.report.queries
      .filter(({ filter }) => filter.kinds?.includes(13535))
      .every(
        ({ filter }) =>
          filter.authors?.length === 1 &&
          filter.limit === 1 &&
          Object.keys(filter).length === 3,
      ),
  ).toBe(true);
});

// The composer disclosure retains every channel launcher. Profile activity
// remains the durable fallback after fresh evidence disappears (covered below).
test("channel activity consumes telemetry, isolates mixed batches, selects agents, and retains history on disable", async ({
  page,
  app,
}) => {
  // Hold the first explicit profile read before broker admission so telemetry
  // demand cannot coalesce into it; hold all upstream presence responses too,
  // including a replacement if that first request is cancelled.
  app.relay.holdPresence();
  const firstSnapshot = Promise.withResolvers();
  let firstAuthors;
  await page.route("**/presence-snapshot", async (route) => {
    if (!firstAuthors) {
      firstAuthors = route.request().postDataJSON()[0].authors;
      await firstSnapshot.promise;
    }
    await route.fallback();
  });
  const firstKey = generateSecretKey();
  const secondKey = generateSecretKey();
  const first = getPublicKey(firstKey);
  const second = getPublicKey(secondKey);
  const region = channelActivity(page);
  const firstEntry = agentEntry(page, first);
  const secondEntry = agentEntry(page, second);
  let unsafe;
  try {
    await open(page, app);
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    await expect.poll(() => firstAuthors).toBeDefined();
    await expect(
      page.getByRole("button", { name: "Agent Activity", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    unsafe = app.observer(
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

    await expect(region).toBeVisible();
    await expect(firstEntry).toBeHidden();
    await expandChannelActivity(page);
    await expect(firstEntry).toBeVisible();
    expect(firstAuthors).not.toContain(first);
    expect(firstAuthors).not.toContain(second);
    // Neither agent publishes live presence in this fixture. Even if demand
    // cancels and retries the held snapshot, neither response can label it yet.
    await expect(firstEntry).not.toHaveAccessibleName(/, Presence:/);
  } finally {
    firstSnapshot.resolve();
    app.relay.releasePresence();
  }
  await expect
    .poll(() =>
      app.report.presenceSnapshots.some(
        ({ filter, pending, aborted }) =>
          filter.authors.includes(first) && !pending && !aborted,
      ),
    )
    .toBe(true);
  await expect(firstEntry).toHaveAccessibleName(/, Presence: online$/);
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  // A busy skip followed by a successful retry must not masquerade as recovery.
  expect(
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/presence-snapshot"),
    ),
  ).toHaveLength(app.report.presenceSnapshots.length);
  await expect(firstEntry).toContainText("working");
  await expect(secondEntry).toBeVisible();
  await expect(region).toHaveCSS("border-top-width", "0px");
  await expect(region).toHaveCSS("border-right-width", "0px");
  await expect(region).toHaveCSS("border-bottom-width", "0px");
  await expect(region).toHaveCSS("border-left-width", "0px");
  const workingIndicator = firstEntry.locator("svg[data-working]");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(workingIndicator).not.toHaveCSS("animation-name", "none");
  await expect(workingIndicator).toHaveCSS("animation-duration", "1.4s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(workingIndicator).toHaveCSS("animation-name", "none");
  await expect(firstEntry).toContainText("working");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await firstEntry.hover();
  const tooltip = page.getByRole("tooltip").filter({ hasText: first });
  await expect(tooltip).toContainText(
    "1 working turn(s) in this channel, including threads.",
  );
  await expect(tooltip).toContainText(
    "Owner-only activity. Select to inspect.",
  );
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  // Establish a starting point, then leave and re-enter using actual keyboard
  // input. focus() alone neither clears Escape dismissal nor proves :focus-visible.
  await firstEntry.focus();
  await page.keyboard.press("Tab");
  await expect(firstEntry).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(firstEntry).toBeFocused();
  await expect(tooltip).toContainText(first);
  await expect(firstEntry).toHaveAccessibleDescription(/Owner-only activity/);
  await firstEntry.press("Enter");

  const panel = activityPanel(page);
  await expect(panel.locator("code").first()).toHaveText(first);
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(/Alpha.*alpha/);
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  // Telemetry supplies keys before any profile or directory facts exist.
  const agentSelect = panel.getByRole("combobox", {
    name: "Agent",
    exact: true,
  });
  for (const key of [second, first]) {
    await agentSelect.click();
    const choices = page.getByRole("option");
    await expect(choices).toHaveCount(2);
    const labels = await choices.allTextContents();
    expect(new Set(labels).size).toBe(2);
    const label = labels.find(
      (text) =>
        text.startsWith("Agent · npub…") &&
        npubEncode(key).endsWith(text.slice("Agent · npub…".length)),
    );
    expect(label).toBeDefined();
    const choice = page.getByRole("option", { name: label, exact: true });
    await expect(choice).toBeVisible();
    await choice.click();
    await expect(panel.locator("code").first()).toHaveText(key);
  }
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

  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  await expect(firstEntry).toBeFocused();
  await secondEntry.click();
  await expect(panel.locator("code").first()).toHaveText(second);
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  await expect(secondEntry).toBeFocused();
  await secondEntry.click();
  await expect(panel.locator("code").first()).toHaveText(second);

  const sockets = app.relay.sockets.length;
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "Enable Agent Activity",
    exact: true,
  });
  const disabled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/stream-observer") &&
      response.ok() &&
      response.request().postDataJSON().observer !== null,
  );
  await toggle.click();
  await disabled;
  // Archive capture and owner-review requests both retain independent demand.
  // Disabling the activity UI clears only its display evidence.
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  expect(app.relay.sockets).toHaveLength(sockets);
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(region).toHaveCount(0);

  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  // Capture keeps this wire alive while the display is disabled. Its existence
  // no longer proves that the plugin's new display generation reached the host.
  const enabled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/stream-observer") &&
      response.ok() &&
      response.request().postDataJSON().observer !== null,
  );
  await toggle.click();
  await enabled;
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  app.observer(activity("turn_liveness", "alpha", "after-reset"), firstKey);
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expandChannelActivity(page);
  await expect(agentEntry(page, first)).toBeVisible();
  await expect(agentEntry(page, second)).toHaveCount(0);
  await agentEntry(page, first).click();
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toHaveCount(2);
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(1);

  // Stale evidence is unknown, not completed; one terminal turn must not hide
  // another active turn for the same agent. Capture survives closing the panel.
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  app.observer(activity("turn_completed", "alpha", "after-reset"), firstKey);
  await expect(agentEntry(page, first)).toHaveCount(0);
  app.observer(
    {
      ...activity("turn_liveness", "alpha", "stale"),
      timestamp: new Date(Date.now() - 31_000).toISOString(),
    },
    firstKey,
  );
  await expandChannelActivity(page);
  await expect(agentEntry(page, first)).toContainText("status unknown");
  await expect(
    agentEntry(page, first).locator(".navigation-item-trailing svg"),
  ).toHaveCSS("animation-name", "none");
  app.observer(activity("turn_liveness", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toContainText("working");
  app.observer(activity("turn_completed", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toContainText("status unknown");
  app.observer(activity("turn_completed", "alpha", "stale"), firstKey);
  await expect(region).toHaveCount(0);
});

for (const mode of ["light", "dark"]) {
  test(`channel activity entry and raw disclosure fit wide and narrow layouts in ${mode}`, async ({
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
    const secondKey = generateSecretKey();
    app.observer(
      activity("turn_liveness", "alpha", "second-layout"),
      secondKey,
    );
    app.observer(
      activity("acp_read", "alpha", "layout", {
        text: "A long literal raw record. ".repeat(40),
      }),
      agentKey,
    );
    await expandChannelActivity(page);
    const entry = agentEntry(page, agent);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // The shell applies its media-query change in React. Wait for that commit
      // before measuring; otherwise these reads can straddle sidebar collapse.
      await expect(page.locator("[data-shell-sidebar-toggle]")).toHaveAttribute(
        "aria-label",
        width <= 650 ? "Show navigation" : "Hide Channel sidebar",
      );
      await expect(entry).toBeVisible();
      const entryBox = await entry.boundingBox();
      const formBox = await page
        .getByRole("form", { name: "Send a message to Alpha", exact: true })
        .boundingBox();
      expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(formBox.y);
      const avatar = entry.locator(".buzz-avatar");
      // Production CSS must retain a loadable SVG mask after bundling. A valid
      // mask-image string alone can still point to the HTML fallback route.
      await expect
        .poll(() =>
          avatar.evaluate(async (element) => {
            const mask = getComputedStyle(element).maskImage;
            const image = new Image();
            image.src = mask.slice(4, -1).replace(/^["']|["']$/g, "");
            try {
              await image.decode();
              return image.naturalWidth > 0;
            } catch {
              return false;
            }
          }),
        )
        .toBe(true);
      const avatarBox = await avatar.boundingBox();
      // Shared navigation owns its inset; the row still aligns with the composer.
      const inset = await entry.evaluate((element) =>
        parseFloat(getComputedStyle(element).paddingLeft),
      );
      expect(entryBox.x).toBeCloseTo(formBox.x, 0);
      expect(avatarBox.x).toBeCloseTo(formBox.x + inset, 0);
      const lastRow = await channelActivity(page)
        .getByRole("button")
        .last()
        .boundingBox();
      expect(formBox.y - lastRow.y - lastRow.height).toBeCloseTo(4, 0);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      // Escape suppresses hover until the pointer leaves the trigger. A viewport
      // resize can keep WebKit's pointer over it, so make the next entry explicit.
      await page.mouse.move(0, 0);
      await entry.hover();
      await expect(
        page.getByRole("tooltip").filter({ hasText: agent }),
      ).toContainText("in this channel, including threads.");
      await page.screenshot({
        path: testInfo.outputPath(`activity-entry-${mode}-${width}.png`),
      });
      await page.keyboard.press("Escape");
      // Escape starts Base UI's asynchronous unmount. The closing portal still
      // has its wide-screen position and can overflow the next narrow viewport.
      await expect(
        page.getByRole("tooltip", { includeHidden: true }),
      ).toHaveCount(0);
    }

    await entry.click();
    const panel = activityPanel(page);
    await panel.getByRole("button", { name: /acp_read/ }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.locator("pre code")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${mode}-${width}.png`),
      });
    }
  });
}

const profileChannelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const it = test.extend({
  readState: true,
  channelIds: [profileChannelId, "beta"],
  channelNames: { [profileChannelId]: "Alpha" },
  historyCounts: { [profileChannelId]: 1, beta: 1 },
});
it("profile activity opens the exact agent and originating channel before its first frame", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  // The production broker advertises read-state writes even without the
  // readState fixture option. Exercise that publication before profile activity.
  await openChannelDetails(page);
  await expect(
    page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("button", { name: "Leave channel", exact: true }),
  ).toBeVisible();
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
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  // A person's profile carries no activity card: neither preview nor launcher.
  const personKey = generateSecretKey();
  const personMessage = finalizeEvent(
    {
      kind: 9,
      tags: [["h", profileChannelId]],
      content: "Contextual person entry",
      created_at: Math.floor(Date.now() / 1000),
    },
    personKey,
  );
  app.relay.publish("primary", personMessage);
  await page
    .locator(`[data-message-id="${personMessage.id}"]`)
    .getByRole("button", { name: /profile/ })
    .click();
  // The settled metadata read is the barrier: no agent evidence can follow it.
  await expect(
    profile.getByText("No profile metadata is available in this community."),
  ).toBeVisible();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }),
  ).toHaveCount(0);
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  const agentKey = generateSecretKey();
  const agent = getPublicKey(agentKey);
  app.serveProfile(agentKey, { name: "Fixture agent", is_agent: true });
  const message = finalizeEvent(
    {
      kind: 9,
      tags: [["h", profileChannelId]],
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
          // Catch-up replaces the message's own mark once it covers it.
          Math.max(
            blob.contexts[`msg:${message.id}`] ?? -1,
            blob.contexts[`activity:${profileChannelId}`] ?? -1,
          ) >= message.created_at,
      ),
    )
    .toBe(true);
  await avatar.click();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }),
  ).toContainText("No activity yet");
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await expect(profile).toHaveCount(0);
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel.locator("code").first()).toHaveText(agent);
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(`Alpha · ${profileChannelId}`);
  await expect(
    panel.getByText(/No captured records for this identity in this channel/),
  ).toBeVisible();
  const item = (kind, channelId, turnId) => ({
    kind,
    channelId,
    turnId,
    sessionId: null,
    timestamp: new Date().toISOString(),
  });
  app.observer(
    item("acp_read", profileChannelId, "other-agent"),
    generateSecretKey(),
  );
  app.observer(item("acp_write", "beta", "other-channel"), agentKey);
  app.observer(item("session_resolved", null, "unscoped"), agentKey);
  const expected = app.observer(
    item("turn_liveness", profileChannelId, "wanted"),
    agentKey,
  );
  const row = panel.getByRole("button", { name: /turn_liveness/ });
  await expect(row).toBeVisible();
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  await expect(
    panel.getByRole("button", {
      name: /acp_read|acp_write|session_resolved/,
    }),
  ).toHaveCount(0);
  await row.click();
  await expect(panel.locator("pre code")).toHaveText(expected.plaintext);
  await panel.getByRole("combobox", { name: "Channel", exact: true }).click();
  await page
    .getByRole("option", {
      name: "All channels (including unscoped records)",
      exact: true,
    })
    .click();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /session_resolved/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await panel.press("Escape");
  await expect(profile).toBeVisible();
  const profileTab = page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { selected: true });
  await expect(profileTab).toBeFocused();
  await profileTab.press("Escape");
  await expect(profile).toBeHidden();
  await expect(avatar).toBeFocused();
  await avatar.click();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }).locator("time"),
  ).toHaveAttribute("datetime", JSON.parse(expected.plaintext).timestamp);
  const preview = profile.getByRole("region", { name: "Activity preview" });
  await profile.getByRole("tab", { name: "Channels", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(preview.locator("time")).toHaveAttribute(
    "datetime",
    JSON.parse(expected.plaintext).timestamp,
  );
  const update = (value) => ({
    ...item("acp_read", profileChannelId, "wanted"),
    payload: { method: "session/update", params: { update: value } },
  });
  app.observer(
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: {
        type: "text",
        text: "I found the issue in the channel subscription. ",
      },
    }),
    agentKey,
  );
  app.observer(
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: {
        type: "text",
        text: "Checking the fix against the existing tests.",
      },
    }),
    agentKey,
  );
  app.observer(
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tests",
      title: "Run profile tests",
      status: "in_progress",
    }),
    agentKey,
  );
  await expect(
    preview.getByRole("list", { name: "Recent activity" }),
  ).toContainText(
    "I found the issue in the channel subscription. Checking the fix against the existing tests.",
  );
  await expect(
    preview.getByText("Run profile tests", { exact: true }),
  ).toBeVisible();
  app.observer(
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tests",
      status: "completed",
    }),
    agentKey,
  );
  await expect(
    preview.getByText("Tool completed", { exact: true }),
  ).toBeVisible();
  await profile.getByRole("tab", { name: "Channels", exact: true }).click();
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(
    preview.getByText("Run profile tests", { exact: true }),
  ).toBeVisible();
  // Exercise painted theme/layout, not the separate appearance persistence contract.
  for (const mode of ["light", "dark"]) {
    await page.locator("html").evaluate((element, mode) => {
      element.setAttribute("data-color-mode", mode);
    }, mode);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(preview).toBeVisible();
      await expect(
        preview.getByRole("button", { name: "View activity" }),
      ).toBeVisible();
      const bounds = await preview.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await preview.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`profile-preview-${mode}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await page.locator('[data-channel-id="beta"]').click();
  await expect(panel).toHaveCount(0);
  // Disable removes both registration and profile affordance, not the profile itself.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Agent Activity", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator(`[data-channel-id="${profileChannelId}"]`).click();
  // Channel navigation restores the existing profile tab. Close it explicitly
  // so this exercises a fresh opening and its focus handoff after disable.
  await page
    .getByRole("button", { name: "Close Fixture agent tab", exact: true })
    .click();
  await expect(profile).toBeHidden();
  await avatar.click();
  await expect(profile).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  // Finish the reopened profile's focus handoff and timeline layout before
  // starting read dwell; visible profile content alone proves neither.
  await expect(profileTab).toBeFocused();
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

  test("thread typing uses the existing route, stays isolated, and opens channel details above the composer", async ({
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
    await row.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
    const region = thread.getByRole("region", {
      name: "Agent activity in this thread",
      exact: true,
    });
    const marker = page
      .locator('[data-channel-id="alpha"]')
      .getByRole("img", { name: /working in Alpha$/ });
    const sendTyping = (threadId, signingKey = key, secondsAgo = 0) => {
      const event = finalizeEvent(
        {
          kind: 20002,
          created_at: Math.floor(Date.now() / 1000) - secondsAgo,
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
    await expect(channelActivity(page)).toBeVisible();
    await expect(agentEntry(page, agent)).toBeHidden();
    app.observer(activity("turn_completed", "alpha", "previous"), key);
    await expect(agentEntry(page, agent)).toHaveCount(0);
    const unrecognized = generateSecretKey();
    sendTyping(root.id, unrecognized);
    sendTyping("b".repeat(64));
    await expect(
      thread.getByRole("status", { name: "Typing activity" }),
    ).toBeVisible();
    await expect(region).toHaveCount(0);
    // Public typing from an unrecognized signer is a distinct status, not the
    // agent row's duplicate. Complete it before measuring agent-only layout.
    app.relay.publish(
      "primary",
      finalizeEvent(
        {
          kind: 9,
          created_at: Math.floor(Date.now() / 1000),
          content: "Unrecognized participant finished",
          tags: [
            ["h", "alpha"],
            ["e", root.id, "", "root"],
            ["e", root.id, "", "reply"],
          ],
        },
        unrecognized,
      ),
    );
    await expect(
      thread.getByRole("status", { name: "Typing activity" }),
    ).toHaveCount(0);
    // Finish panel entrance before starting the eight-second working signal.
    await page.locator("[data-panel-dock]").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const typing = sendTyping(root.id);
    await expect(region).toBeVisible();
    await expect(marker).toHaveCount(0); // Thread-only fallback must not light channel scope.
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(page.locator(`[data-message-id="${typing.id}"]`)).toHaveCount(
      0,
    );
    const entry = region.getByRole("button", {
      name: new RegExp(agent.slice(0, 12)),
    });
    const form = thread.getByRole("form", {
      name: "Reply to thread",
      exact: true,
    });
    const typingIndicator = thread.getByRole("status", {
      name: "Typing activity",
    });
    sendTyping(root.id);
    await expect(entry).toBeVisible();
    await expect(typingIndicator).toHaveCount(0);
    const entryBox = await entry.boundingBox(),
      formBox = await form.boundingBox();
    expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(formBox.y);
    expect(formBox.y - entryBox.y - entryBox.height).toBeCloseTo(4, 0);
    const inset = await entry.evaluate((element) =>
      parseFloat(getComputedStyle(element).paddingLeft),
    );
    expect(entryBox.x).toBeCloseTo(formBox.x, 0);
    expect((await entry.locator(".buzz-avatar").boundingBox()).x).toBeCloseTo(
      formBox.x + inset,
      0,
    );
    await entry.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "Details show channel activity",
    );
    // Same agent, two observer turns, and scoped thread typing. Do not infer
    // that either channel-wide turn belongs to this thread, or hide other work.
    app.observer(activity("turn_liveness", "alpha", "parallel-one"), key);
    app.observer(activity("turn_liveness", "alpha", "parallel-two"), key);
    sendTyping(root.id);
    const summary = channelActivity(page).locator("summary");
    await expect(summary).toHaveText("Channel-wide activity · 1 agent");
    await expect(agentEntry(page, agent)).toBeHidden();
    await expect(entry).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(
      page.getByRole("tooltip", { includeHidden: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-above-composer.png"),
    });
    // Native disclosure semantics and keyboard operation need real browsers.
    await summary.focus();
    await summary.press("Enter");
    await expect(agentEntry(page, agent)).toBeVisible();
    await agentEntry(page, agent).hover();
    await expect(page.getByRole("tooltip")).toContainText("2 working turn(s)");
    await page.mouse.move(0, 0);
    await summary.focus();
    await summary.press("Space");
    await expect(agentEntry(page, agent)).toBeHidden();
    await page.mouse.move(0, 0);
    // A closing tooltip retains its desktop position until its exit completes.
    await expect(
      page.getByRole("tooltip", { includeHidden: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    sendTyping(root.id);
    await expect(entry).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(390);
    await expect(typingIndicator).toHaveCount(0);
    const narrowEntry = await entry.boundingBox(),
      narrowForm = await form.boundingBox();
    expect(narrowEntry.y + narrowEntry.height).toBeLessThanOrEqual(
      narrowForm.y,
    );
    expect(narrowForm.y - narrowEntry.y - narrowEntry.height).toBeCloseTo(4, 0);
    expect((await entry.locator(".buzz-avatar").boundingBox()).x).toBeCloseTo(
      narrowForm.x +
        (await entry.evaluate((element) =>
          parseFloat(getComputedStyle(element).paddingLeft),
        )),
      0,
    );
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-narrow.png"),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await entry.click();
    await expect(activityPanel(page).locator("code").first()).toHaveText(agent);
    await expect(
      activityPanel(page).getByRole("combobox", {
        name: "Channel",
        exact: true,
      }),
    ).toHaveText(/Alpha.*alpha/);
    await page
      .getByRole("button", { name: /^Close (?!Thread).* tab$/, exact: true })
      .click();
    app.observer(activity("turn_completed", "alpha", "parallel-one"), key);
    app.observer(activity("turn_completed", "alpha", "parallel-two"), key);
    sendTyping();
    await expect(marker).toBeVisible();
    const workingBox = await marker.boundingBox();
    expect(workingBox).toEqual(
      expect.objectContaining({ width: 26, height: 15 }),
    );
    await expect(channelActivity(page)).toBeVisible();
    await expandChannelActivity(page);
    const channelBox = await channelActivity(page)
      .getByRole("button")
      .first()
      .boundingBox();
    const channelForm = await page
      .getByRole("form", { name: "Send a message to Alpha", exact: true })
      .boundingBox();
    const channelTyping = page
      .getByRole("form", { name: "Send a message to Alpha", exact: true })
      .locator("..")
      .getByRole("status", { name: "Typing activity" });
    await expect(channelTyping).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("channel-agent-single-presentation.png"),
    });
    expect(channelBox.y + channelBox.height).toBeLessThanOrEqual(channelForm.y);
    await expect(marker).toHaveCount(0, { timeout: 10_000 });
    await expect(channelActivity(page)).toHaveCount(0);
  });
  // Browser-only: real composer/accessory wiring through signed relay traffic,
  // mixed-status geometry at narrow width, and navigation across live scopes.
  test("thread working rows deduplicate agents while preserving human typing and scope transitions", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const keys = [generateSecretKey(), generateSecretKey()];
    const agents = keys.map(getPublicKey);
    const roots = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const region = thread.getByRole("region", {
      name: "Agent activity in this thread",
      exact: true,
    });
    const indicator = thread.getByRole("status", { name: "Typing activity" });
    const workingStatus = thread.locator("[data-agent-working-status]");
    const openThread = async (root) => {
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
    };
    const publish = (key, root, kind = 20002) => {
      app.relay.publish(
        "primary",
        finalizeEvent(
          {
            kind,
            created_at: Math.floor(Date.now() / 1000),
            content: kind === 9 ? "Work finished" : "",
            tags: [
              ["h", "alpha"],
              ...(root
                ? [
                    ["e", root.id, "", "root"],
                    ["e", root.id, "", "reply"],
                  ]
                : []),
            ],
          },
          key,
        ),
      );
    };
    await openThread(roots[0]);
    await expect(workingStatus).toBeAttached();
    await expect(workingStatus).toBeEmpty();
    for (const [index, key] of keys.entries()) {
      app.serveProfile(key, { name: `Worker ${index + 1}`, is_agent: true });
      app.observer(
        activity("turn_liveness", "alpha", `recognize-${index}`),
        key,
      );
    }
    await expect(channelActivity(page).locator("summary")).toHaveText(
      "Channel-wide activity · 2 agents",
    );
    for (const [index, key] of keys.entries())
      app.observer(
        activity("turn_completed", "alpha", `recognize-${index}`),
        key,
      );
    await expect(channelActivity(page)).toHaveCount(0);
    publish(keys[0], roots[0]);
    await expect(region.getByRole("button")).toHaveCount(1);
    await expect(workingStatus).toContainText("Worker 1 is working");
    await expect(indicator).toHaveCount(0);
    publish(keys[1], roots[0]);
    await expect(region.getByRole("button")).toHaveCount(2);
    await expect(workingStatus).toContainText(
      /Worker [12], Worker [12] are working/,
    );
    for (const agent of agents)
      await expect(
        region.getByRole("button", { name: new RegExp(agent.slice(0, 12)) }),
      ).toHaveCount(1);
    await expect(indicator).toHaveCount(0);
    const human = generateSecretKey();
    app.serveProfile(human, { name: "Human typer" });
    publish(human, roots[0]);
    await expect(indicator).toHaveCount(1);
    await expect(indicator).not.toContainText("Worker");
    await expect(workingStatus).toContainText("are working");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("[data-panel-dock]").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    for (const key of keys) publish(key, roots[0]);
    publish(human, roots[0]);
    await expect(region.getByRole("button")).toHaveCount(2);
    await expect(indicator).toBeVisible();
    const typingBox = await indicator.boundingBox();
    const rowBox = await region.getByRole("button").first().boundingBox();
    const formBox = await thread
      .getByRole("form", { name: "Reply to thread", exact: true })
      .boundingBox();
    expect(typingBox.y + typingBox.height).toBeLessThan(rowBox.y);
    expect(typingBox.x).toBeGreaterThanOrEqual(formBox.x);
    expect(typingBox.x + typingBox.width).toBeLessThanOrEqual(
      formBox.x + formBox.width,
    );
    await page.screenshot({
      path: testInfo.outputPath(
        "thread-single-agent-presentation-human-typing.png",
      ),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    publish(human, roots[0], 9);
    await expect(indicator).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close Thread tab", exact: true })
      .click();
    await openThread(roots[1]);
    await expect(
      thread.getByRole("region", { name: "Thread messages", exact: true }),
    ).toContainText(roots[1].content);
    await expect(region).toHaveCount(0);
    await expect(indicator).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close Thread tab", exact: true })
      .click();
    await openThread(roots[0]);
    // Fresh pulses avoid making the navigation assertions depend on fixture speed.
    for (const key of keys) publish(key, roots[0]);
    await expect(region.getByRole("button")).toHaveCount(2);
    publish(keys[0], roots[0], 9);
    await expect(region.getByRole("button")).toHaveCount(1);
    publish(keys[1], roots[0], 9);
    await expect(region).toHaveCount(0);
    await expect(workingStatus).toBeAttached();
    await expect(workingStatus).toBeEmpty();
    await expect(indicator).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close Thread tab", exact: true })
      .click();
    // Channel uses the same rows behind an existing visible disclosure.
    const channelStatus = page
      .getByRole("form", { name: "Send a message to Alpha", exact: true })
      .locator("..")
      .locator("[data-agent-working-status]");
    const channelTyping = page
      .getByRole("form", { name: "Send a message to Alpha", exact: true })
      .locator("..")
      .getByRole("status", { name: "Typing activity" });
    publish(keys[0]);
    await expect(channelActivity(page).locator("summary")).toHaveText(
      "Channel-wide activity · 1 agent",
    );
    await expect(channelStatus).toContainText("Worker 1 is working");
    await expect(channelTyping).toHaveCount(0);
    publish(keys[1]);
    await expect(channelActivity(page).locator("summary")).toHaveText(
      "Channel-wide activity · 2 agents",
    );
    await expect(channelStatus).toContainText(
      /Worker [12], Worker [12] are working/,
    );
    await expect(channelActivity(page).locator("details")).not.toHaveAttribute(
      "open",
    );
    await expandChannelActivity(page);
    await expect(channelActivity(page).getByRole("button")).toHaveCount(2);
    await expect(channelTyping).toHaveCount(0);
    publish(human);
    await expect(channelTyping).toBeVisible();
    await expect(channelTyping).not.toContainText("Worker");
    await expect(channelStatus).toContainText("are working");
    await page.screenshot({
      path: testInfo.outputPath("channel-multiple-agents-human-typing.png"),
    });
    publish(human, undefined, 9);
    await expect(channelTyping).toHaveCount(0);
    publish(keys[0], undefined, 9);
    await expect(channelActivity(page).getByRole("button")).toHaveCount(1);
    publish(keys[1], undefined, 9);
    await expect(channelActivity(page)).toHaveCount(0);
    await page.locator('[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(
      page.getByRole("status", { name: "Typing activity" }),
    ).toHaveCount(0);
  });
});

// Browser-only: production broker SQLite survives document reload and the real
// Settings confirmation clears the mounted plugin. Native process restart is tested in Rust.
test.describe("host archive durability", () => {
  test.use({ archiveOnDisk: true });
  test("encrypted host history survives reload without working evidence and can be cleared", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey();
    const agent = getPublicKey(key);
    app.serveProfile(key, { name: "History agent", is_agent: true });
    const record = app.observer(
      activity("turn_liveness", "alpha", "saved", {
        text: "secret-history-marker",
      }),
      key,
    );
    await expandChannelActivity(page);
    await agentEntry(page, agent).click();
    const panel = activityPanel(page);
    await expect(
      panel.getByText("Saved history loaded.", { exact: true }),
    ).toBeVisible();
    const disk = async () =>
      Buffer.concat(
        await Promise.all(
          [app.archiveFile, `${app.archiveFile}-wal`].map(async (path) => {
            try {
              return await readFile(path);
            } catch (error) {
              if (error.code === "ENOENT") return Buffer.alloc(0);
              throw error;
            }
          }),
        ),
      ).toString("utf8");
    await expect.poll(disk).toContain(record.event.id);
    expect(await disk()).not.toContain("secret-history-marker");
    await open(page, app); // new document and session, same device/account/community
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    // Open through a profile: restored history must not create a working launcher.
    const message = finalizeEvent(
      {
        kind: 9,
        tags: [["h", "alpha"]],
        content: "History profile entry",
        created_at: Math.floor(Date.now() / 1000),
      },
      key,
    );
    app.relay.publish("primary", message);
    await page
      .locator(`[data-message-id="${message.id}"]`)
      .getByRole("button", { name: /profile/ })
      .click();
    await page
      .getByRole("button", { name: "View activity", exact: true })
      .click();
    await expect(
      panel.getByText("Saved history loaded.", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("No fresh working evidence.", { exact: true }),
    ).toBeVisible();
    await expect(agentEntry(page, agent)).toHaveCount(0);
    await panel.getByRole("button", { name: /turn_liveness/ }).click();
    await expect(panel.locator("pre code")).toContainText(
      "secret-history-marker",
    );
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const archive = page.getByRole("region", { name: /Saved agent activity/ });
    await expect(archive.getByText(/not in this browser/)).toBeVisible();
    await archive
      .getByRole("button", { name: "Clear activity history", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Clear activity history?",
    });
    await expect(confirmation).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("archive-clear-confirmation.png"),
    });
    await confirmation
      .getByRole("button", { name: "Clear saved records" })
      .click();
    await expect(confirmation).toHaveCount(0);
    const count = () => {
      const database = new DatabaseSync(app.archiveFile, { readOnly: true });
      try {
        return database
          .prepare(
            "SELECT COUNT(*) AS count FROM archive_events WHERE kind=24200",
          )
          .get().count;
      } finally {
        database.close();
      }
    };
    expect(count()).toBe(0);
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: /turn_liveness/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("archive-cleared.png"),
    });
  });
});
