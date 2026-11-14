import { pluginAction } from "./plugin-settings.mjs";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import {
  closeSettings,
  channelRow,
  newChat,
  openChannel,
  openSettings,
  rail,
  selectSettingsSection,
  sendOnlyTo,
} from "./navigation.mjs";
import { npubEncode } from "nostr-tools/nip19";
import { openSoloList, soloRow } from "./rail-helpers.mjs";
const id = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
test.use({
  productionBroker: true,
  channelIds: [id, other, "gamma"],
  channelNames: { [id]: "Alpha", [other]: "Beta", gamma: "Gamma" },
  soloChannels: [id, other],
  ownSoloChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, gamma: 1 },
});
// Activity opens the agent's profile, where its type's Activity tab lives.
const agentProfile = (page) =>
  page.getByRole("region", { name: "Profile details", exact: true });
const closeProfile = (page) =>
  page.getByRole("button", { name: /^Close (?!Thread).* tab$/ });
// Verifies shell routing, actual hover/focus and retained drafts across the real panel host.
test("Solo chat Activity opens the agent's profile locally, restores per conversation and retires on plugin disable", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await soloRow(page, id).click();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await composer.fill("Keep my Solo draft");
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  app.observer(
    {
      kind: "turn_liveness",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "solo-activity",
    },
    key,
  );
  const trigger = page.getByRole("button", {
    name: /^Activity: .+ working$/,
  });
  await trigger.hover();
  const preview = page.getByRole("dialog", { name: "Working now" });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: /^View .+ activity$/ }).click();
  const panel = agentProfile(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator("code").first()).toHaveText(
    npubEncode(getPublicKey(key)),
  );
  await expect(preview).toBeHidden();
  await expect(rail(page)).toBeVisible();
  await expect(composer).toHaveText("Keep my Solo draft");
  await closeProfile(page).click();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await preview.getByRole("button", { name: /^View .+ activity$/ }).click();
  await expect(panel).toBeVisible();
  await soloRow(page, other).click();
  await expect(panel).toHaveCount(0);
  await soloRow(page, id).click();
  await expect(panel).toBeVisible();
  await expect(composer).toHaveText("Keep my Solo draft");
  await closeProfile(page).click();
  // Restored panels have no retained launcher; closing uses the stable chat region.
  await expect(
    page.getByRole("region", { name: "Chat Alpha", exact: true }),
  ).toBeFocused();
  await trigger.focus();
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowDown");
  await expect(preview).toBeVisible();
  await expect(preview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await preview.getByRole("button", { name: /^View .+ activity$/ }).click();
  await expect(panel).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await page
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await pluginAction(page, "Agent Activity").click();
  // Closing Settings returns to the retained Solo visit without the trigger.
  await closeSettings(page);
  await expect(trigger).toHaveCount(0);
});

// Reading needs real focus inside the chat; a pointer selection leaves it on the row.
test.describe("reading", () => {
  test.use({ readState: true });
  const unread = (row) => expect(row).toHaveAttribute("data-state", "unread");
  const read = (row) => expect(row).toHaveAttribute("data-state", "read");
  test("Solo chat reads a chat opened from the sidebar, so it stays unbolded after leaving", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const alpha = soloRow(page, id);
    const beta = soloRow(page, other);
    // Startup shows Alpha in Messages first, so read Beta, which only Solo shows.
    await unread(beta);
    await expect(beta).toHaveAccessibleDescription("Unread messages");
    await beta.click();
    // The dwell policy reads the visible bottom without any further input,
    // because selection hands focus to the chat's composer.
    await read(beta);
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeFocused();
    await alpha.click();
    // Unselected, Beta's row shows its saved read state rather than selection.
    await expect(alpha).toHaveAttribute("aria-current", "page");
    await read(beta);
    expect(app.report.unexpected).toEqual([]);
  });
});

// Real PersonalComposer -> signing boundary remains covered through the main reader.
// A Solo chat no longer has a user path that opens another conversation as a side tab.
// Owner-authored inventory supplies choices; signed membership remains authority.
test.describe("personal recipients", () => {
  test.use({
    soloAgentNames: ["Owned Honey", "Owned Brain"],
    soloOutsideAgentNames: ["Outside Agent"],
  });
  test("Solo chat signs only explicit owned recipients and never offers an outside identity, in a linked tab too", async ({
    page,
    app,
  }) => {
    // An older finite head may finish after a live arrival mounts the reader.
    // Hold the response to exercise that route; the mounted timeline test
    // controls the exact zero-viewport ordering independently of browser timing.
    let releaseHead;
    const heldHead = new Promise((resolve) => {
      releaseHead = resolve;
    });
    let readHead = false;
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.top_level && filter["#h"]?.includes("gamma"))
      )
        return route.continue();
      const response = await route.fetch();
      readHead = true;
      await heldHead;
      await route.fulfill({ response }).catch(() => {});
    });
    try {
      await page.goto(app.origin);
      await openChannel(page, "gamma");
      // Opening Gamma holds its head from here. Deliver the live
      // arrival and release now rather than across the whole Solo section,
      // which would outlast the relay reader's deadline.
      await expect.poll(() => readHead).toBe(true);
      await expect
        .poll(() =>
          app.report.liveRequests.some((request) =>
            request.filters.some((filter) => filter["#h"]?.includes("gamma")),
          ),
        )
        .toBe(true);
      // Own Solo chats are listed in the Solo section, not the Team channel
      // list. A real conversation link still opens them in the Messages reader.
      const link = app.append(
        "primary",
        "gamma",
        `[Open Beta](buzz://channel/${other})`,
      );
      releaseHead();
      await expect(
        page.locator(`[data-message-id="${link.id}"]`),
      ).toBeVisible();
      await newChat(page);
      await soloRow(page, other).click();
      const workspace = page.getByRole("main");
      const composer = page.getByRole("textbox", {
        name: "Message your agents",
        exact: true,
      });
      const [, brain, outsider] = app.soloAgents;
      // Agents-only Solo chats address agents from the composer's pill.
      const pill = (scope) =>
        scope.getByRole("button", { name: /Change agents$|^Choose agent$/ });
      await expect(composer).toHaveText("");
      // An existing chat starts addressed to one of its agents.
      await expect(pill(workspace)).toHaveAccessibleName(
        /^Sending to .+\. Change agents$/,
      );
      // Choose an owned recipient from the pill.
      await sendOnlyTo(page, pill(workspace), brain);
      await composer.press("End");
      await page.keyboard.insertText("Only this agent from Beta");
      await composer.press("Enter");
      const publications = () =>
        app.report.publications.filter(({ event }) => event.kind === 9);
      await expect.poll(() => publications().length).toBe(1);
      const sent = publications()[0].event;
      expect(verifyEvent(sent)).toBe(true);
      expect(sent.tags.filter(([key]) => key === "h")).toEqual([["h", other]]);
      expect(sent.tags.filter(([key]) => key === "p")).toEqual([
        ["p", brain.pubkey],
      ]);
      // The next draft retains the last notified agent, not the account
      // default, and keeps it out of the text.
      await expect(pill(workspace)).toHaveAccessibleName(
        `Sending to ${brain.name}. Change agents`,
      );
      await expect(composer).toHaveText("");
      // A draft from the ordinary Messages reader may retain a channel member
      // who isn't in the owner's inventory. A Solo chat must reject that explicit recipient.
      await composer.fill("");
      await openChannel(page, "gamma");
      await page
        .locator(`[data-message-id="${link.id}"]`)
        .getByRole("link", {
          name: "Open Chat: Beta",
          exact: true,
        })
        .click();
      const linkedChat = page.getByRole("tabpanel", {
        name: "Beta",
        exact: true,
      });
      // The linked tab follows the same Solo policy as the main reader: the
      // channel member outside the owner's inventory is not offered.
      await pill(linkedChat).click();
      const linkedPicker = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      await expect(
        linkedPicker
          .getByRole("button")
          .and(page.locator(`[data-mention-choice="${brain.pubkey}"]`)),
      ).toBeVisible();
      await expect(
        linkedPicker
          .getByRole("button")
          .and(page.locator(`[data-mention-choice="${outsider.pubkey}"]`)),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      expect(publications()).toHaveLength(1);
    } finally {
      releaseHead();
    }
  });
});

// The rail lists no activity; Solo's list marks a working chat's row, with
// no hover affordance needed on touch.
test.describe("touch Solo activity", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("a working chat's Solo list row shows working until its turn completes", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey();
    const event = (kind) => ({
      kind,
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "touch",
    });
    app.observer(event("turn_liveness"), key);
    await openSoloList(page);
    const row = channelRow(page, id);
    await expect(row).toHaveAttribute("data-state", "working");
    app.observer(event("turn_completed"), key);
    await expect(row).not.toHaveAttribute("data-state", "working");
  });
});
