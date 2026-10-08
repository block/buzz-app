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
  page.locator("[data-channel-timeline]").getByRole("region", {
    name: "Agent activity on this message",
    exact: true,
  });
const agentEntry = (page, agent) =>
  channelActivity(page)
    .getByRole("button", { name: /^View agent activity:/ })
    .filter({
      has: page.getByRole("img", {
        name: new RegExp(
          `npub…${npubEncode(agent).slice(-3)}(?:, (?:online|away|offline))?$`,
        ),
      }),
    });
const activityPopup = (page) =>
  page.getByRole("dialog", { name: "Agent activity", exact: true });
const openProfileActivity = async (page, entry, agent) => {
  await entry.click();
  const popup = activityPopup(page);
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("tab")).toHaveCount(0);
  await popup
    .getByRole("button", {
      name: agent
        ? new RegExp(`^View activity for npub…${npubEncode(agent).slice(-3)}$`)
        : /^View activity for/,
    })
    .click();
  await expect(
    page.getByRole("tab", { name: "Activity", selected: true, exact: true }),
  ).toBeVisible();
};
const openRawRecords = async (panel) => {
  const disclosure = panel.getByRole("button", { name: /^Raw records/ });
  if ((await disclosure.getAttribute("aria-expanded")) !== "true")
    await disclosure.click();
};
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

// Message presentation requires a real explicit start, not a liveness heuristic.
function messageObserver(app) {
  const started = new Set();
  const sequences = new Map();
  const request = app.histories.get("primary/alpha").at(-1);
  return (raw, key) => {
    const id = `${getPublicKey(key)}:${raw.turnId}`;
    if (!started.has(id)) {
      app.observer(
        {
          ...activity("turn_started", "alpha", raw.turnId, {
            triggeringEventIds: [request.id],
          }),
          timestamp: raw.timestamp,
        },
        key,
      );
      started.add(id);
      sequences.set(id, 1);
    }
    const seq = (sequences.get(id) ?? 1) + 1;
    sequences.set(id, seq);
    return app.observer({ ...raw, seq }, key);
  };
}

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

// The triggering message is the activity launcher. Profile activity remains the
// durable fallback after fresh working evidence disappears (covered below).
test("channel activity consumes telemetry, isolates mixed batches, selects agents, and resets on disable", async ({
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
  const observe = messageObserver(app);
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
    unsafe = observe(
      activity("turn_liveness", "alpha", "one", {
        text: '<img src=x onerror="window.telemetryExecuted=true">',
      }),
      firstKey,
    );
    observe(activity("turn_liveness", "alpha", "two"), secondKey);
    app.observer(
      {
        kind: "batch",
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        payload: {
          events: [
            { ...activity("acp_read", "alpha", "one", "wanted child"), seq: 3 },
            activity("acp_write", "beta", "other-channel", "other channel"),
          ],
        },
      },
      firstKey,
    );

    await expect(region).toBeVisible();
    await expect(firstEntry).toBeVisible();
    expect(firstAuthors).not.toContain(first);
    expect(firstAuthors).not.toContain(second);
    // Neither agent publishes live presence in this fixture. Even if demand
    // cancels and retries the held snapshot, neither response can label it yet.
    await expect(firstEntry.getByRole("img").first()).not.toHaveAccessibleName(
      /, (online|away|offline)$/,
    );
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
  await expect(
    firstEntry.getByRole("img", { name: /, online$/ }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  // A busy skip followed by a successful retry must not masquerade as recovery.
  expect(
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/presence-snapshot"),
    ),
  ).toHaveLength(app.report.presenceSnapshots.length);
  await expect(firstEntry).toHaveAccessibleName(/working/);
  await expect(secondEntry).toBeVisible();
  await expect(region).toHaveCSS("border-top-width", "0px");
  await expect(region).toHaveCSS("border-right-width", "0px");
  await expect(region).toHaveCSS("border-bottom-width", "0px");
  await expect(region).toHaveCSS("border-left-width", "0px");
  const workingIndicator = firstEntry
    .locator('span[aria-hidden="true"] > span')
    .first();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(workingIndicator).not.toHaveCSS("animation-name", "none");
  await expect(workingIndicator).toHaveCSS("animation-duration", "1.4s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(workingIndicator).toHaveCSS("animation-name", "none");
  await expect(firstEntry).toHaveAccessibleName(/working/);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await firstEntry.hover();
  const popup = activityPopup(page);
  await expect(popup).toContainText(
    "Latest reported activity for this message.",
  );
  await expect(popup.getByRole("tab")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await page.mouse.move(0, 0);
  await firstEntry.focus();
  await firstEntry.press("Enter");
  await expect(popup).toBeVisible();
  await popup
    .getByRole("button", {
      name: new RegExp(
        `^View activity for npub…${npubEncode(first).slice(-3)}$`,
      ),
    })
    .click();
  await expect(
    page.getByRole("tab", { name: "Activity", selected: true, exact: true }),
  ).toBeVisible();

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
  await openRawRecords(panel);
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
  await openProfileActivity(page, secondEntry, second);
  await expect(panel.locator("code").first()).toHaveText(second);
  await openRawRecords(panel);
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  await openProfileActivity(page, secondEntry, second);
  await expect(panel.locator("code").first()).toHaveText(second);
  await openRawRecords(panel);

  const sockets = app.relay.sockets.length;
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "Enable Agent Activity",
    exact: true,
  });
  await toggle.click();
  // Owner-review requests share the observer transport but own independent
  // demand. Disabling the optional activity UI clears its evidence without
  // tearing down the app-level agent-update listener.
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
  await toggle.click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  observe(activity("turn_liveness", "alpha", "after-reset"), firstKey);
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(agentEntry(page, first)).toBeVisible();
  await expect(agentEntry(page, second)).toHaveCount(0);
  await openProfileActivity(page, agentEntry(page, first));
  await openRawRecords(panel);
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);

  // Stale evidence is unknown, not completed; one terminal turn must not hide
  // another active turn for the same agent. Capture survives closing the panel.
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  observe(activity("turn_completed", "alpha", "after-reset"), firstKey);
  await expect(agentEntry(page, first)).toHaveCount(0);
  observe(
    {
      ...activity("turn_liveness", "alpha", "stale"),
      timestamp: new Date(Date.now() - 31_000).toISOString(),
    },
    firstKey,
  );
  await expect(agentEntry(page, first)).toContainText("Status unknown");
  await expect(
    agentEntry(page, first).locator('span[aria-hidden="true"] > span'),
  ).toHaveCount(0);
  observe(activity("turn_liveness", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toHaveAccessibleName(/working/);
  observe(activity("turn_completed", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toContainText("Status unknown");
  observe(activity("turn_completed", "alpha", "stale"), firstKey);
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
    const observe = messageObserver(app);
    observe(activity("turn_liveness", "alpha", "second-layout"), secondKey);
    observe(
      activity("acp_read", "alpha", "layout", {
        text: "A long literal raw record. ".repeat(40),
      }),
      agentKey,
    );
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
      const avatar = entry.locator(".buzz-avatar").first();
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
      expect(entryBox.x).toBeGreaterThanOrEqual(formBox.x);
      expect(avatarBox.x).toBeCloseTo(entryBox.x + inset, 0);
      const lastRow = await channelActivity(page)
        .getByRole("button")
        .last()
        .boundingBox();
      expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(formBox.y);
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
      await expect(activityPopup(page)).toContainText("for this message");
      const popupBox = await activityPopup(page).boundingBox();
      expect(popupBox.x).toBeGreaterThanOrEqual(0);
      expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-entry-${mode}-${width}.png`),
      });
      await page.keyboard.press("Escape");
      // Escape starts Base UI's asynchronous unmount. The closing portal still
      // has its wide-screen position and can overflow the next narrow viewport.
      await expect(
        page.getByRole("dialog", { includeHidden: true }).filter({
          has: page.getByRole("button", {
            name: /^View activity for/,
            includeHidden: true,
          }),
        }),
      ).toHaveCount(0);
    }

    await openProfileActivity(page, entry, agent);
    const panel = activityPanel(page);
    await openRawRecords(panel);
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
          blob.contexts[`msg:${message.id}`] === message.created_at,
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
  await expect(profile).toBeVisible();
  await expect(
    profile.getByRole("tab", { name: "Activity", selected: true, exact: true }),
  ).toBeVisible();
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel.locator("code").first()).toHaveText(agent);
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(`Alpha · ${profileChannelId}`);
  await expect(
    panel.getByText(
      /Waiting for live records for this identity in this channel/,
    ),
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
  await openRawRecords(panel);
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
  // Activity is now part of this profile rather than a replacement panel.
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  const profileTab = page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { selected: true });
  await profileTab.focus();
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

  test("typing alone does not invent message activity and human typing remains separate", async ({
    page,
    app,
  }) => {
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
      name: "Agent activity on this message",
      exact: true,
    });
    const marker = page
      .locator('[data-channel-id="alpha"]')
      .getByRole("img", { name: /working in Alpha$/ });
    const sendTyping = (threadId, signingKey = key) => {
      const event = finalizeEvent(
        {
          kind: 20002,
          created_at: Math.floor(Date.now() / 1000),
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
    app.observer(activity("turn_liveness", "alpha", "previous"), key);
    await expect(marker).toBeVisible();
    app.observer(
      { ...activity("turn_completed", "alpha", "previous"), seq: 2 },
      key,
    );
    await expect(marker).toHaveCount(0);
    const human = generateSecretKey();
    sendTyping(root.id, human);
    sendTyping("b".repeat(64));
    const typingEvent = sendTyping(root.id);
    const typing = thread.getByRole("status", { name: "Typing activity" });
    await expect(typing).toContainText(getPublicKey(human).slice(0, 10));
    await expect(typing).not.toContainText(agent.slice(0, 10));
    await expect(region).toHaveCount(0);
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(marker).toHaveCount(0);
    await expect(
      page.locator(`[data-message-id="${typingEvent.id}"]`),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(390);
    await page.setViewportSize({ width: 1440, height: 950 });
    await expect(page.locator('[data-channel-id="alpha"]')).toBeVisible();
    sendTyping();
    await expect(marker).toBeVisible();
    expect(await marker.boundingBox()).toEqual(
      expect.objectContaining({ width: 26, height: 15 }),
    );
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(marker).toHaveCount(0, { timeout: 10000 });
    await expect(region).toHaveCount(0);
  });
});
