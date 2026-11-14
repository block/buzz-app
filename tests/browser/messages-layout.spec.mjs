import { test, expect } from "./fixture.mjs";
import { generateSecretKey, getPublicKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  inboxDm: true,
  enabledPlugins: ["buzz.bestie", "buzz.workflows"],
  channelIds: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
  historyCounts: { alpha: 4, beta: 3, gamma: 1, delta: 1, epsilon: 1, zeta: 1 },
});

// Browser-only: shell routing, persistent pin wiring, real collection/reader
// geometry, and the narrow rail overlay must work together without losing drafts.
test("the combined rail pins destinations and opens centered Messages", async ({
  page,
  app,
}, testInfo) => {
  const identities = Array.from({ length: 5 }, (_, index) => ({
    pubkey: getPublicKey(generateSecretKey()),
    name: `Agent ${index + 1}`,
  }));
  await page.route("**/agent-library", (route) =>
    route.fulfill({ json: { definitions: [], identities } }),
  );
  await page.goto(app.origin, { waitUntil: "domcontentloaded" });
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  for (const name of ["Pins", "Messages", "Solo", "Agents"])
    await expect(
      rail.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  for (const name of ["Agent 1", "Agent 2", "Agent 3", "Agent 4"])
    await expect(rail.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(
    rail.getByRole("button", { name: "Agent 5", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Discover", exact: true }),
  ).toHaveCount(0);
  const railHeader = rail
    .locator("header")
    .filter({ has: page.getByRole("heading", { name: "Buzz", exact: true }) });
  const community = await railHeader
    .getByRole("button", { name: /^Community switcher:/ })
    .boundingBox();
  const buzz = await railHeader
    .getByRole("heading", { name: "Buzz", exact: true })
    .boundingBox();
  const headerNew = railHeader.getByRole("button", {
    name: "Create",
    exact: true,
  });
  await expect
    .poll(() =>
      headerNew.evaluate((button) =>
        button.checkVisibility({ opacityProperty: true }),
      ),
    )
    .toBe(true);
  const plus = await headerNew.boundingBox();
  expect(community.x + community.width).toBeLessThanOrEqual(buzz.x);
  expect(plus.x).toBeGreaterThan(buzz.x + buzz.width);
  await headerNew.click();
  for (const action of [
    "New chat",
    "New workspace",
    "New message",
    "New channel",
    "New section",
  ])
    await expect(
      page.getByRole("menuitem", { name: action, exact: true }),
    ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(headerNew).toBeFocused();
  await headerNew.click();
  await page
    .getByRole("menuitem", { name: "New message", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  await page.goBack();
  // The app lands on Team.
  await expect(
    page.getByRole("region", { name: "Team", exact: true }),
  ).toBeVisible();
  const headerSearch = railHeader.getByRole("button", {
    name: "Search",
    exact: true,
  });
  await headerSearch.click();
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", exact: true }),
  ).toHaveCount(0);
  await expect(headerSearch).toBeFocused();

  // App wiring: sorting precedes the four-row cap and survives a reload.
  const newestAt =
    Math.max(
      ...[...app.histories.values()].flat().map((event) => event.created_at),
    ) + 1;
  app.append(
    "primary",
    "alpha",
    "Newest Alpha activity",
    true,
    false,
    undefined,
    undefined,
    [],
    newestAt,
  );
  const cardRows = rail
    .getByRole("list", { name: "Recent conversations" })
    .getByRole("button");
  await expect(cardRows.nth(0)).toHaveAccessibleName("Alpha");
  const messageCard = rail.locator('[data-rail-section="messages"]');
  const sortMessages = rail.getByRole("button", {
    name: "Filter and sort Team card",
  });
  await page.mouse.move(1300, 20);
  await expect
    .poll(() =>
      sortMessages.evaluate((button) =>
        button.checkVisibility({ opacityProperty: true }),
      ),
    )
    .toBe(false);
  await messageCard.hover();
  await expect
    .poll(() =>
      sortMessages.evaluate((button) =>
        button.checkVisibility({ opacityProperty: true }),
      ),
    )
    .toBe(true);
  await sortMessages.click();
  await page.mouse.move(1300, 20);
  await expect
    .poll(() =>
      sortMessages.evaluate((button) =>
        button.checkVisibility({ opacityProperty: true }),
      ),
    )
    .toBe(true);
  const cardMenu = page.getByRole("menu").filter({
    has: page.getByRole("menuitemradio", { name: "A–Z", exact: true }),
  });
  await expect(cardMenu).toBeVisible();
  await cardMenu.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({
    path: testInfo.outputPath("messages-card-filter-menu.png"),
  });
  await page.getByRole("menuitemradio", { name: "A–Z", exact: true }).click();
  for (const [i, label] of [
    "Alice Fixture",
    "Alpha",
    "Beta",
    "delta",
  ].entries())
    await expect(cardRows.nth(i)).toHaveAccessibleName(label);
  await page.reload();
  await messageCard.hover();
  await sortMessages.click();
  await expect(
    page.getByRole("menuitemradio", { name: "A–Z", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Recent activity" }).click();
  await expect(cardRows.nth(0)).toHaveAccessibleName("Alpha");

  await sortMessages.click();
  await page
    .getByRole("menuitemradio", { name: "Direct", exact: true })
    .click();
  await expect(
    messageCard.getByRole("button", { name: "Alice Fixture", exact: true }),
  ).toBeVisible();
  await expect(
    messageCard.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await messageCard.hover();
  await sortMessages.click();
  await expect(
    page.getByRole("menuitemradio", { name: "Direct", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  for (const view of ["Threads", "Working", "Waiting"]) {
    await messageCard.hover();
    await sortMessages.click();
    await page.getByRole("menuitemradio", { name: view, exact: true }).click();
    await expect(
      messageCard.getByText("No matching conversations.", { exact: true }),
    ).toBeVisible();
  }
  await messageCard.hover();
  await sortMessages.click();
  await page.getByRole("menuitemradio", { name: "All", exact: true }).click();

  await rail.getByRole("button", { name: "Team", exact: true }).click();
  const index = page.getByRole("region", { name: "Team", exact: true });
  await expect(
    index.getByRole("heading", { name: "Team", level: 2 }),
  ).toBeVisible();
  // Real geometry: view chips share the rows' leading content edge.
  const firstRow = index
    .locator("[data-activity-row] [data-conversation-row]")
    .first();
  await expect(firstRow).toBeVisible();
  const contentLeft = await firstRow.evaluate(
    (element) =>
      element.getBoundingClientRect().left +
      Number.parseFloat(getComputedStyle(element).paddingInlineStart),
  );
  const firstFilter = await index
    .getByRole("tab", { name: "All", exact: true })
    .boundingBox();
  expect(firstFilter.x).toBeCloseTo(contentLeft, 0);
  // Both hosts must project the same objects before the card's four-row cap.
  // This catches received-only ranking, fixed plugin priority, and split filters.
  const expectMatchingMessages = async () => {
    await page.mouse.move(1300, 20);
    await expect
      .poll(async () => {
        const full = await index
          .locator("[data-activity-row]")
          .evaluateAll((rows) =>
            rows
              .map((row) => row.getAttribute("data-activity-row"))
              .slice(0, 4),
          );
        const compact = await cardRows.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-rail-channel")),
        );
        return {
          full,
          compact,
          matches:
            full.length > 0 && JSON.stringify(full) === JSON.stringify(compact),
        };
      })
      .toMatchObject({ matches: true });
  };
  await expectMatchingMessages();
  await index
    .getByRole("button", { name: "Filter and sort conversations", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "A–Z", exact: true }).click();
  await expectMatchingMessages();
  await messageCard.hover();
  await sortMessages.click();
  await expect(
    page.getByRole("menuitemradio", { name: "A–Z", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("menuitemradio", { name: "Recent activity", exact: true })
    .click();
  await expectMatchingMessages();
  await index.getByRole("tab", { name: "Direct", exact: true }).click();
  await expectMatchingMessages();
  await messageCard.hover();
  await sortMessages.click();
  await expect(
    page.getByRole("menuitemradio", { name: "Direct", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await index.getByRole("tab", { name: "All", exact: true }).click();
  await index
    .getByRole("button", { name: "Filter and sort conversations", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Unread only", exact: true })
    .click();
  await expectMatchingMessages();
  await messageCard.hover();
  await sortMessages.click();
  const unreadCardChoice = page.getByRole("menuitemcheckbox", {
    name: "Unread only",
    exact: true,
  });
  await expect(unreadCardChoice).toHaveAttribute("aria-checked", "true");
  await unreadCardChoice.click();
  await page.keyboard.press("Escape");
  await expect(
    index.getByRole("button", {
      name: "Filter and sort conversations",
      exact: true,
    }),
  ).toBeVisible();
  await expectMatchingMessages();
  await page.screenshot({
    path: testInfo.outputPath("messages-card-page-parity.png"),
  });
  const beta = index.locator('[data-activity-row="beta"]');
  const recentBeta = rail
    .getByRole("list", { name: "Recent conversations" })
    .getByRole("button", { name: "Beta", exact: true });
  await expect(
    recentBeta.getByRole("img", { name: "Unread", exact: true }),
  ).toBeVisible();
  const beforeMark = page.url();
  await beta.hover();
  await beta.getByRole("button", { name: "Mark as read", exact: true }).click();
  await expect(
    beta.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(beforeMark);
  await expect(
    recentBeta.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  const recentAlpha = rail
    .getByRole("list", { name: "Recent conversations" })
    .getByRole("button", { name: "Alpha", exact: true });
  // Rail destinations open the full conversation for pinning and navigation;
  // collection-row navigation is exercised in messages-sheet.spec.mjs.
  await recentAlpha.click();
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const editor = conversation.getByRole("textbox");
  await editor.fill("Keep this Messages draft");
  await expect(
    recentAlpha.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  await expect(
    rail
      .getByRole("list", { name: "Recent conversations" })
      .getByRole("listitem"),
  ).toHaveCount(4);
  await expect(
    rail
      .getByRole("list", { name: "Recent conversations" })
      .getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(1);
  const currentConversation = page.url();
  await rail.getByRole("button", { name: "Add pin", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add a pin", exact: true });
  await picker
    .getByRole("textbox", { name: "Find something to pin" })
    .fill("Alpha");
  await picker.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  const pins = rail
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Pins", exact: true }) });
  await expect(
    pins.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(currentConversation);
  await expect(editor).toHaveText("Keep this Messages draft");
  const pinnedAlpha = pins.getByRole("button", { name: "Alpha", exact: true });
  await expect(
    pinnedAlpha.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  await rail.getByRole("button", { name: "Bestie", exact: true }).click();
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  app.append("primary", "alpha", "New sidebar unread message", true, false);
  await expect(
    recentAlpha.getByRole("img", { name: "Unread", exact: true }),
  ).toBeVisible();
  await expect(
    pinnedAlpha.getByRole("img", { name: "Unread", exact: true }),
  ).toBeVisible();
  await pinnedAlpha.hover();
  await expect(
    pinnedAlpha.getByRole("img", { name: "Unread", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("rail-unread.png") });
  await pinnedAlpha.click();
  await expect(editor).toHaveText("Keep this Messages draft");
  await expect(
    pinnedAlpha.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  await expect(
    recentAlpha.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);

  await rail.getByRole("button", { name: "Team", exact: true }).click();
  await index.getByRole("tab", { name: "Direct", exact: true }).click();
  await expect(
    index.getByRole("heading", { name: "Direct", level: 2 }),
  ).toBeVisible();
  await pins.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(editor).toHaveText("Keep this Messages draft");
  await page.reload();
  await expect(
    pins.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveText("Keep this Messages draft");

  await rail.getByRole("button", { name: "Add pin", exact: true }).click();
  await picker
    .getByRole("textbox", { name: "Find something to pin" })
    .fill("Alice Fixture");
  await picker
    .getByRole("button", { name: "Pin person Alice Fixture", exact: true })
    .click();
  await pins
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  await expect(page).not.toHaveURL(currentConversation);
  await expect(rail.getByRole("alert")).toHaveCount(0);
  await expect(
    conversation.getByRole("textbox", { name: /Message/ }),
  ).toBeVisible();
  await pins.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(editor).toHaveText("Keep this Messages draft");
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    const railBox = await rail.boundingBox();
    const reader = await conversation.boundingBox();
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(reader.x);
    await expect(editor).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`rail-${mode}.png`) });
  }
  await page.setViewportSize({ width: 900, height: 950 });
  await expect(editor).toBeInViewport();
  await expect(rail).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("rail-medium.png") });
  await rail.getByRole("button", { name: "Bestie", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Choose your bestie agent",
      exact: true,
    }),
  ).toBeVisible();
  await expect(rail).toBeVisible();
  await pins.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(editor).toHaveText("Keep this Messages draft");

  await page.setViewportSize({ width: 480, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  await expect(editor).toBeInViewport();
  await expect(rail).toBeHidden();
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await expect(
    pins.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("rail-narrow.png") });
  await pins
    .getByRole("button", { name: "Alpha", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect(
    rail.getByRole("button", { name: "Add pin", exact: true }),
  ).toBeFocused();
  await expect(
    pins.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(rail).toBeHidden();
  await expect(editor).toBeInViewport();
});

// Host wiring: an agent shortcut must use the shared DM opener, including its
// readiness failure, while View all continues to navigate to the directory.
test("agent rail rows open DMs and keep View all for the directory", async ({
  page,
  app,
}) => {
  const peer = app.histories.get("primary/dm-peer").at(-1).pubkey;
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: [
          { pubkey: peer, name: "DM agent" },
          {
            pubkey: getPublicKey(generateSecretKey()),
            name: "Unavailable agent",
          },
        ],
      },
    }),
  );
  await page.goto(app.origin, { waitUntil: "domcontentloaded" });
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const agents = rail.locator("section").filter({
    has: page.getByRole("heading", { name: "Agents", exact: true }),
  });
  await expect(
    agents
      .getByRole("button", { name: "DM agent", exact: true })
      .getByRole("img", { name: "Unread", exact: true }),
  ).toBeVisible();
  await agents
    .getByRole("button", { name: "Unavailable agent", exact: true })
    .click();
  await expect(rail.getByRole("alert")).toHaveText(
    "This agent is not ready to message in this community.",
  );
  await agents.getByRole("button", { name: "DM agent", exact: true }).click();
  await expect(page).toHaveURL(/dm-peer/);
  await expect(
    page
      .getByRole("article", { name: "Conversation", exact: true })
      .getByRole("textbox"),
  ).toBeVisible();
  await expect(
    agents.getByRole("button", { name: "DM agent", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    agents
      .getByRole("button", { name: "DM agent", exact: true })
      .getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  await expect(rail.getByRole("alert")).toHaveCount(0);
  await rail.getByRole("button", { name: "Open Agents", exact: true }).click();
  await expect(page).toHaveURL(/buzz.agents/);
  await page.goBack();
  await expect(page).toHaveURL(/dm-peer/);
});

// Browser-only: pointer collision geometry, the animated footer drop target,
// context-menu handoff, and remounted shell rows cannot be proved in jsdom.
test("rail sections and rows can be arranged and a drop creates a named section", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin, { waitUntil: "domcontentloaded" });
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const messages = rail.locator('[data-rail-section="messages"]');
  const agents = rail.locator('[data-rail-section="agents"]');
  const beta = messages.getByRole("button", { name: "Beta", exact: true });
  await expect(beta).toBeVisible();
  const primary = rail.locator("section").filter({
    has: page.getByRole("button", { name: "Workflows", exact: true }),
  });
  await expect(
    primary.getByRole("button", { name: "Open Plugins", exact: true }),
  ).toBeVisible();
  await expect(
    primary.getByRole("button", { name: "Open Plugins", exact: true }),
  ).toHaveText("Open Plugins");
  await expect(
    rail.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await expect(beta.getByRole("img", { name: "Unread" })).toBeVisible();
  const startDrag = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 9, {
      steps: 3,
    });
  };
  const dropOn = async (locator) => {
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
  };
  const order = () =>
    rail
      .locator("[data-rail-section]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.railSection));
  const navigation = rail.locator('[data-rail-section="navigation"]');
  const pins = rail.locator('[data-rail-section="pins"]');
  await pins.hover();
  const pinGrabber = pins.getByRole("button", {
    name: "Move Pins section",
    exact: true,
  });
  await pinGrabber.hover();
  await expect
    .poll(() =>
      pinGrabber.evaluate((button) =>
        button.checkVisibility({ opacityProperty: true }),
      ),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rail-card-grabber.png") });
  await startDrag(pinGrabber);
  await dropOn(
    navigation.getByRole("heading", { name: "Plugins", exact: true }),
  );
  await expect
    .poll(order)
    .toEqual(["pins", "navigation", "messages", "solo", "agents"]);
  await page.reload();
  await expect
    .poll(order)
    .toEqual(["pins", "navigation", "messages", "solo", "agents"]);
  await startDrag(agents.getByRole("heading", { name: "Agents", exact: true }));
  await dropOn(messages.getByRole("heading", { name: "Team", exact: true }));
  await expect
    .poll(order)
    .toEqual(["pins", "navigation", "agents", "messages", "solo"]);

  await startDrag(beta);
  const newSection = rail.getByRole("region", {
    name: "New section",
    exact: true,
  });
  await expect(newSection).toBeInViewport();
  await expect(newSection).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("rail-dragging.png") });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(newSection).toBeHidden();
  await expect(beta).toBeVisible();

  await startDrag(beta);
  await dropOn(agents.getByRole("heading", { name: "Agents", exact: true }));
  const movedBeta = agents.getByRole("button", { name: "Beta", exact: true });
  await expect(movedBeta).toBeVisible();
  await expect(beta).toHaveCount(0);
  await expect(movedBeta.getByRole("img", { name: "Unread" })).toBeVisible();

  await startDrag(movedBeta);
  await expect(newSection).toHaveCSS("opacity", "1");
  await dropOn(newSection);
  const dialog = page.getByRole("dialog", {
    name: "Move to new section",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(movedBeta).toBeVisible();

  await startDrag(movedBeta);
  await expect(newSection).toHaveCSS("opacity", "1");
  await dropOn(newSection);
  await dialog
    .getByRole("textbox", { name: "Section name" })
    .fill("Project chats");
  await dialog
    .getByRole("button", { name: "Create and move", exact: true })
    .click();
  const custom = rail.locator("[data-rail-section]").filter({
    has: page.getByRole("heading", { name: "Project chats", exact: true }),
  });
  await expect(
    custom.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(movedBeta).toHaveCount(0);
  await navigation
    .getByRole("button", { name: "Workflows", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Project chats", exact: true })
    .click();
  await expect(
    navigation.getByRole("button", { name: "Workflows", exact: true }),
  ).toHaveCount(0);
  await custom
    .getByRole("button", { name: "Workflows", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Plugins", exact: true }).click();
  await expect(
    navigation.getByRole("button", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect
    .poll(order)
    .toEqual([
      "pins",
      "navigation",
      "agents",
      "messages",
      "solo",
      await custom.getAttribute("data-rail-section"),
    ]);
  await expect(
    navigation
      .locator("[data-rail-row]")
      .last()
      .getByRole("button", { name: "Open Plugins", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("rail-arranged.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.screenshot({
    path: testInfo.outputPath("rail-arranged-dark.png"),
  });

  // Collapse retains the saved card order as usable destinations, including
  // custom cards. Real layout must leave room beside the dock for content.
  const expandedRail = await rail.boundingBox();
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(rail).toBeVisible();
  const dock = rail.getByRole("region", {
    name: "Sidebar sections",
    exact: true,
  });
  const dockIcons = dock.getByRole("button");
  await expect(dockIcons).toHaveCount(6);
  for (const [index, name] of [
    "Pins",
    "Plugins",
    "Agents",
    "Messages",
    "Solo",
    "Project chats",
  ].entries())
    await expect(dockIcons.nth(index)).toHaveAccessibleName(name);
  const compactRail = await rail.boundingBox();
  expect(compactRail.width).toBeLessThan(expandedRail.width / 2);
  await dock
    .getByRole("button", { name: "Project chats", exact: true })
    .click();
  const sectionPage = page.getByRole("region", {
    name: "Project chats",
    exact: true,
  });
  await expect(
    sectionPage.locator('[data-activity-row="beta"] [data-conversation-row]'),
  ).toBeVisible();
  expect((await sectionPage.boundingBox()).x).toBeGreaterThanOrEqual(
    compactRail.x + compactRail.width,
  );
  await expect(
    dock.getByRole("button", { name: "Project chats", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("rail-compact-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await page.screenshot({
    path: testInfo.outputPath("rail-compact-light.png"),
  });
  await page.setViewportSize({ width: 800, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  for (const icon of await dockIcons.all()) await expect(icon).toBeInViewport();
  await expect(sectionPage).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("rail-compact-enlarged.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await dock.getByRole("button", { name: "Agents", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    dock.getByRole("button", { name: "Team", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tooltip", { name: "Team", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Team", exact: true }),
  ).toBeVisible();
  await expect(dock).toBeVisible();
  await page.goBack();
  await expect(sectionPage).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expect(
    custom.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect
    .poll(order)
    .toEqual([
      "pins",
      "navigation",
      "agents",
      "messages",
      "solo",
      await custom.getAttribute("data-rail-section"),
    ]);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hide sidebar", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 480, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await expect(
    custom.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  const scroller = rail.locator('[data-scroll-fade="scrolled"]');
  await expect(scroller).toHaveAttribute("data-overflow-end", "");
  await scroller.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  });
  await expect(scroller).toHaveAttribute("data-overflow-start", "");
  await expect(scroller).toHaveAttribute("data-overflow-end", "");
  await page.screenshot({
    path: testInfo.outputPath("rail-arranged-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });

  await page.reload();
  await expect(
    custom.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await custom
    .getByRole("button", { name: "Beta", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Team", exact: true }).click();
  await messages.getByRole("button", { name: /^Team$/i }).click();
  const messagesPage = page.getByRole("region", {
    name: "Team",
    exact: true,
  });
  await expect(
    messagesPage.locator('[data-activity-row="beta"] [data-conversation-row]'),
  ).toBeVisible();
  await expect(messages.locator("[data-rail-row]")).toHaveCount(4);
  await page.goBack();
  await expect(
    custom.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveCount(0);
  await custom
    .getByRole("heading", { name: "Project chats", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Remove section", exact: true })
    .click();
  await expect(custom).toHaveCount(0);

  await agents
    .getByRole("button", { name: "Move Agents section", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(order)
    .toEqual(["pins", "navigation", "messages", "agents", "solo"]);
  await messages.getByRole("button", { name: /^Team$/i }).click();
  const fullBeta = messagesPage.locator(
    '[data-activity-row="beta"] [data-conversation-row]',
  );
  await fullBeta.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: /to section$/ }).hover();
  await expect(
    page.getByRole("menuitem", { name: "New section…", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await fullBeta.click();
  await expect(
    page
      .getByRole("article", { name: "Conversation", exact: true })
      .getByRole("textbox"),
  ).toBeVisible();
  await messages.getByRole("button", { name: /^Team$/i }).click();
  await expect(fullBeta.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await fullBeta.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  const pinnedBeta = pins.getByRole("button", { name: "Beta", exact: true });
  await pinnedBeta.hover();
  await expect(
    rail.getByRole("button", { name: /^(?:Pin|Unpin) Beta$/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("rail-row-actions.png") });
  await pinnedBeta.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await expect(pinnedBeta).toHaveCount(0);
  await expect(beta).toBeVisible();
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(pinnedBeta).toBeVisible();
  await rail.getByRole("button", { name: "Open Agents", exact: true }).click();
  const agentPage = page.getByRole("region", { name: "Agents", exact: true });
  await expect(
    agentPage.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("page-header-agents.png"),
  });
  await primary.getByRole("button", { name: "Workflows", exact: true }).click();
  const pluginPage = page.getByRole("region", {
    name: "Workflows",
    exact: true,
  });
  await expect(
    pluginPage.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("page-header-plugin.png"),
  });
  const createSection = rail.getByRole("button", {
    name: "New section",
    exact: true,
  });
  await createSection.click();
  const emptySectionDialog = page.getByRole("dialog", {
    name: "Create new section",
    exact: true,
  });
  await expect(
    emptySectionDialog.getByRole("textbox", { name: "Section name" }),
  ).toBeFocused();
  await expect(
    emptySectionDialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await emptySectionDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(createSection).toBeFocused();
  await createSection.click();
  await emptySectionDialog
    .getByRole("textbox", { name: "Section name" })
    .fill("Saved for later");
  await emptySectionDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();
  const emptySection = rail.locator("[data-rail-section]").filter({
    has: page.getByRole("heading", { name: "Saved for later", exact: true }),
  });
  await expect(emptySection).toBeVisible();
  await expect(emptySection.locator("[data-rail-row]")).toHaveCount(0);
  await expect(createSection).toBeFocused();
  await page.reload();
  await expect(emptySection).toBeVisible();
  await createSection.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("rail-new-section.png") });
});

// Browser-only: align actual chip hit targets with row content, and retain the
// same view strip through overflow, themes and enlarged text in both hosts.
test.describe("Solo rail", () => {
  test.use({
    soloChannels: ["alpha"],
    ownSoloChannels: ["alpha"],
    historyCounts: { alpha: 0, beta: 1 },
  });
  // Host wiring: a Solo with no received messages must be reachable, then stay
  // out of Messages as replies arrive and open through the existing chat host.
  test("Solo chats have their own card and New chat entry point", async ({
    page,
    app,
  }, testInfo) => {
    await page.goto(app.origin);
    const rail = page.getByRole("navigation", { name: "Apps", exact: true });
    const solo = rail.locator('[data-rail-section="solo"]');
    const messages = rail.locator('[data-rail-section="messages"]');
    const alpha = solo.getByRole("button", { name: "Alpha", exact: true });
    await expect(alpha).toBeVisible();
    await solo
      .getByRole("button", { name: "New Solo chat", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "New chat", exact: true }),
    ).toBeVisible();
    await alpha.click();
    await expect(
      page.getByRole("region", {
        name: "Channel message history",
        exact: true,
      }),
    ).toBeVisible();
    app.append("primary", "alpha", "Solo agent reply", true, false);
    await expect(
      page.getByText("Solo agent reply", { exact: true }),
    ).toBeVisible();
    await expect(
      messages.getByRole("button", { name: "Alpha", exact: true }),
    ).toHaveCount(0);
    await expect(
      messages.getByRole("button", { name: "Beta", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(alpha).toBeVisible();
    await expect(
      messages.getByRole("button", { name: "Alpha", exact: true }),
    ).toHaveCount(0);
    await messages.getByRole("button", { name: "Team", exact: true }).click();
    const messagePage = page.getByRole("region", {
      name: "Team",
      exact: true,
    });
    await expect(
      messagePage.locator('[data-activity-row="beta"]'),
    ).toBeVisible();
    await expect(
      messagePage.locator('[data-activity-row="alpha"]'),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("solo-card.png") });
  });
});

test.describe("Sidebar row limits", () => {
  const chats = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  test.use({ soloChannels: chats, ownSoloChannels: chats });
  // App routing must retain the collection as the inline draft becomes addressable.
  test("Solo new-message drafts keep their collection after reload", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    const rail = page.getByRole("navigation", { name: "Apps", exact: true });
    await rail.getByRole("button", { name: "Open Solo", exact: true }).click();
    const collection = page.getByRole("region", { name: "Solo", exact: true });
    await collection
      .getByRole("button", { name: "New message", exact: true })
      .click();
    const draft = collection.getByRole("region", {
      name: "New message",
      exact: true,
    });
    await draft.getByRole("textbox").fill("Keep this Solo draft");
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).hash))
      .toContain('"collection":"solo"');
    await page.reload();
    await expect(draft.getByRole("textbox")).toHaveText("Keep this Solo draft");
    await collection
      .getByRole("button", { name: "Show Solo list", exact: true })
      .click();
    await expect(
      collection.getByRole("region", { name: "Solo list", exact: true }),
    ).toBeVisible();
  });

  test("Solo opens a full list with history while Pins stays uncapped", async ({
    page,
    app,
  }, testInfo) => {
    await page.goto(app.origin);
    const rail = page.getByRole("navigation", { name: "Apps", exact: true });
    const solo = rail.locator('[data-rail-section="solo"]');
    await expect(solo.locator("[data-rail-row]")).toHaveCount(4);
    const more = solo.getByRole("button", {
      name: "Open Solo",
      exact: true,
    });
    await more.focus();
    await page.keyboard.press("Enter");
    const list = page.getByRole("region", { name: "Solo", exact: true });
    await expect(list.locator("[data-rail-row]")).toHaveCount(6);
    const previewText =
      "Solo preview stays on one line even when this message is long. "
        .repeat(12)
        .trim();
    app.append("primary", "alpha", previewText, true, false);
    const preview = list.getByText(/^Solo preview stays on one line/);
    await expect(preview).toBeVisible();
    expect(
      await preview.evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          parseFloat(getComputedStyle(element).lineHeight),
      ),
    ).toBeLessThanOrEqual(1.05);
    await list
      .getByRole("button", {
        name: "Filter and sort conversations",
        exact: true,
      })
      .click();
    await page.getByRole("menuitemradio", { name: "A–Z", exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath("solo-full-list-previews.png"),
    });
    await expect(solo.locator("[data-rail-row]")).toHaveCount(4);
    await expect(rail.getByRole("button", { name: /^View less/ })).toHaveCount(
      0,
    );
    await list
      .locator('[data-activity-row="alpha"] [data-conversation-row]')
      .click();
    await expect(
      page.getByRole("region", {
        name: "Channel message history",
        exact: true,
      }),
    ).toBeVisible();
    await expect(list.locator("[data-rail-row]")).toHaveCount(6);
    const selectedRow = list.locator('[data-activity-row="alpha"]');
    await expect(selectedRow).toBeVisible();
    const reader = list.getByRole("region", {
      name: "Conversation detail",
      exact: true,
    });
    const rowBox = await selectedRow.boundingBox();
    const readerBox = await reader.boundingBox();
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(readerBox.x);
    await page.screenshot({
      path: testInfo.outputPath("solo-master-detail.png"),
    });
    const selectedUrl = page.url();
    await reader
      .getByRole("button", { name: "Hide Solo list", exact: true })
      .click();
    await expect(selectedRow).toBeHidden();
    await expect(page).toHaveURL(selectedUrl);
    await reader
      .getByRole("button", { name: "Show Solo list", exact: true })
      .click();
    await expect(selectedRow).toBeVisible();
    await page.goBack();
    await expect(list.locator("[data-rail-row]")).toHaveCount(6);
    await page.reload();
    await expect(list.locator("[data-rail-row]")).toHaveCount(6);
    await page.goBack();
    // The app lands on Team.
    await expect(
      page.getByRole("region", { name: "Team", exact: true }),
    ).toBeVisible();
    await page.goForward();
    await expect(list.locator("[data-rail-row]")).toHaveCount(6);
    for (const row of await list.locator("[data-rail-row]").all()) {
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    }
    const pins = rail.locator('[data-rail-section="pins"]');
    await expect(pins.locator("[data-rail-row]")).toHaveCount(6);
    await expect(pins.getByRole("button", { name: /^Open Pins/ })).toHaveCount(
      0,
    );
    const pinRows = pins.locator("[data-rail-row]");
    // Real layout: avatar destinations wrap after four and stay inside the card.
    const pinButtons = pinRows.getByRole("button");
    await expect(pinButtons).toHaveCount(6);
    await expect
      .poll(() =>
        pinButtons.evaluateAll((buttons) => {
          const rows = new Map();
          for (const button of buttons) {
            const rect = button.getBoundingClientRect();
            const top = Math.round(rect.top);
            rows.set(top, (rows.get(top) ?? 0) + 1);
          }
          return Math.max(...rows.values());
        }),
      )
      .toBe(4);
    const card = await pins.boundingBox();
    for (const button of await pinButtons.all()) {
      const box = await button.boundingBox();
      expect(box.width).toBeCloseTo(box.height, 0);
      expect(box.x).toBeGreaterThanOrEqual(card.x);
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
    }
    await pinButtons.first().hover();
    await expect(page.getByRole("tooltip")).toHaveText("Alpha");
    await page.screenshot({ path: testInfo.outputPath("pins-grid-light.png") });
    await page.keyboard.press("Escape");
    await pinButtons.first().focus();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("tooltip", { name: "Beta", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 480, height: 900 });
    await page
      .getByRole("button", { name: "Show navigation", exact: true })
      .click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
    });
    await expect
      .poll(() => pins.evaluate((card) => card.scrollWidth <= card.clientWidth))
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("pins-grid-narrow-dark.png"),
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 950 });
    await pinRows.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: /to section$/ }).hover();
    await page
      .getByRole("menuitem", { name: "New section…", exact: true })
      .click();
    const naming = page.getByRole("dialog", {
      name: "Move to new section",
      exact: true,
    });
    await naming
      .getByRole("textbox", { name: "Section name" })
      .fill("Saved chats");
    await naming
      .getByRole("button", { name: "Create and move", exact: true })
      .click();
    while (await pinRows.count()) {
      await pinRows.first().click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Saved chats", exact: true })
        .click();
    }
    const customCard = rail.locator("[data-rail-section]").filter({
      has: page.getByRole("heading", { name: "Saved chats", exact: true }),
    });
    await expect(customCard.locator("[data-rail-row]")).toHaveCount(4);
    await customCard
      .getByRole("button", { name: "Open Saved chats", exact: true })
      .click();
    const customPage = page.getByRole("region", {
      name: "Saved chats",
      exact: true,
    });
    await expect(customPage.locator("[data-rail-row]")).toHaveCount(6);
    // The section opens on its first conversation; a reload keeps the
    // conversation, and its list is one toggle away.
    await page.reload();
    await page
      .getByRole("button", { name: "Show Saved chats list", exact: true })
      .click();
    await expect(customPage.locator("[data-rail-row]")).toHaveCount(6);
    await expect(customCard.locator("[data-rail-row]")).toHaveCount(4);
    await page.screenshot({
      path: testInfo.outputPath("sidebar-four-row-limit.png"),
    });
  });
});

test("Team's list aligns its view filters with its rows", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const checkAlignment = async (view) => {
    const row = view.locator("[data-conversation-row]").first();
    await expect(row).toBeVisible();
    const contentLeft = await row.evaluate(
      (element) =>
        element.getBoundingClientRect().left +
        Number.parseFloat(getComputedStyle(element).paddingInlineStart),
    );
    const filter = await view
      .getByRole("button", {
        name: "Filter and sort conversations",
        exact: true,
      })
      .boundingBox();
    expect(filter.x).toBeCloseTo(contentLeft, 0);
    const all = await view
      .getByRole("tab", { name: "All", exact: true })
      .boundingBox();
    expect(filter.x + filter.width).toBeLessThan(all.x);
    const create = view.getByRole("button", {
      name: "New message",
      exact: true,
    });
    await expect(create).toHaveCount(1);
    await expect(
      view
        .locator(".buzz-content-header")
        .getByRole("button", { name: "New message", exact: true }),
    ).toBeVisible();
    const insets = await row.evaluate((element) => {
      const canvas = element.closest(".shell-body").getBoundingClientRect();
      const workspace = element.closest("[data-detail-workspace]");
      const reader = workspace.querySelector(
        '[aria-label="Conversation detail"]',
      );
      const readerBox = reader.getBoundingClientRect();
      const edge = readerBox.width
        ? readerBox.left
        : workspace.getBoundingClientRect().right;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: box.left - canvas.left + parseFloat(style.paddingInlineStart),
        right: edge - box.right + parseFloat(style.paddingInlineEnd),
      };
    });
    expect(insets.right).toBeCloseTo(insets.left, 0);
  };
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  const messages = page.getByRole("region", { name: "Team", exact: true });
  const previewText =
    "Messages preview stays on one line even when this message is long. "
      .repeat(12)
      .trim();
  app.append("primary", "alpha", previewText, true, false);
  const preview = messages.getByText(/^Messages preview stays on one line/);
  await expect(preview).toBeVisible();
  await messages
    .getByRole("button", { name: "Filter and sort conversations", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "A–Z", exact: true }).click();
  for (const [width, theme] of [
    [1440, "light"],
    [760, "dark"],
    [480, "light"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: theme });
    await checkAlignment(messages);
    expect(
      await preview.evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          parseFloat(getComputedStyle(element).lineHeight),
      ),
    ).toBeLessThanOrEqual(1.05);
    await page.screenshot({
      path: testInfo.outputPath(`message-filters-${width}-${theme}.png`),
    });
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = "20px"));
  await checkAlignment(messages);
  await page.screenshot({
    path: testInfo.outputPath("message-filters-enlarged.png"),
  });
});

// Real pointer geometry and CSS paint keep hidden grabbers discoverable without
// revealing them just because the pointer rests elsewhere on a card.
test("rail card controls fade quietly and grabbers only reveal nearby", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const card = rail.locator('[data-rail-section="pins"]');
  const actions = card.locator("[data-rail-card-actions]");
  const grabber = card.getByRole("button", {
    name: "Move Pins section",
    exact: true,
  });
  const grip = grabber.locator("..");
  await expect(actions).toHaveCSS("opacity", "0");
  await expect(grip).toHaveCSS("opacity", "0");
  await card.evaluate((element) => {
    element.addEventListener(
      "pointerenter",
      () => {
        const actions = element.querySelector("[data-rail-card-actions]");
        getComputedStyle(actions).opacity;
        const fade = actions
          .getAnimations()
          .find((item) => item.transitionProperty === "opacity");
        if (!fade) throw new Error("Missing action fade");
        fade.pause();
        fade.currentTime = Number(fade.effect.getTiming().duration) / 2;
      },
      { once: true },
    );
  });
  await page.clock.install();
  await card.getByRole("heading", { name: "Pins", exact: true }).hover();
  const halfway = await actions.evaluate((element) =>
    Number(getComputedStyle(element).opacity),
  );
  expect(halfway).toBeGreaterThan(0);
  expect(halfway).toBeLessThan(1);
  await page.clock.runFor(2000);
  await expect(grip).toHaveCSS("opacity", "0");
  const bounds = await grabber.boundingBox();
  const centerY = bounds.y + bounds.height / 2;
  // The previous, broader proximity zone stays hidden, even after the old timeout.
  await page.mouse.move(bounds.x + bounds.width * 2.5, centerY);
  await expect(grip).toHaveCSS("opacity", "0");
  await page.mouse.move(bounds.x + bounds.width * 1.75, centerY);
  const approaching = await grip.evaluate((element) =>
    Number(getComputedStyle(element).opacity),
  );
  expect(approaching).toBeGreaterThan(0);
  expect(approaching).toBeLessThan(1);
  await page.mouse.move(bounds.x + bounds.width * 1.25, centerY);
  expect(
    await grip.evaluate((element) => Number(getComputedStyle(element).opacity)),
  ).toBeGreaterThan(approaching);
  await grabber.hover();
  await expect(grip).toHaveCSS("opacity", "1");
  await rail.getByRole("button", { name: "Search", exact: true }).hover();
  await expect(grip).toHaveCSS("opacity", "0");
  const focused = await grabber.evaluate((button) => {
    button.focus();
    return getComputedStyle(button.parentElement).opacity;
  });
  expect(focused).toBe("1");
  await expect(grabber).toBeFocused();
});

test.describe("group DM pins", () => {
  test.use({
    dmLabels: true,
    dmMembers: { "dm-peer": [0], "dm-group": [0, 1] },
  });

  // Built-app wiring: a live conversation's participants supply the pin artwork
  // after creation and reload; the pin still opens its exact conversation.
  test("pinned group DMs show both participants and keep their destination", async ({
    page,
    app,
  }, testInfo) => {
    await page.goto(
      `${app.origin}/#buzz=${encodeURIComponent(
        JSON.stringify({
          version: 1,
          kind: "conversation",
          channelId: "dm-group",
          scope: {
            viewer: app.viewer,
            communityOrigin: "https://primary.example",
          },
        }),
      )}`,
    );
    await expect(
      page.locator('[data-channel-timeline="dm-group"]'),
    ).toBeVisible();
    const rail = page.getByRole("navigation", { name: "Apps", exact: true });
    await rail.getByRole("button", { name: "Add pin", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Add a pin",
      exact: true,
    });
    await picker
      .getByRole("textbox", { name: "Find something to pin" })
      .fill("Alice");
    await picker
      .getByRole("button", {
        name: "Pin Alice Fixture, Bob Fixture",
        exact: true,
      })
      .click();
    await expect(picker).toHaveCount(0);
    const pin = rail
      .locator('[data-rail-section="pins"]')
      .getByRole("button", { name: "Alice Fixture, Bob Fixture", exact: true });
    const avatars = pin.locator("[data-avatar-stack]").last();
    await expect(avatars.locator('[title="Alice Fixture"]')).toHaveCount(1);
    await expect(avatars.locator('[title="Bob Fixture"]')).toHaveCount(1);
    await page.screenshot({
      path: testInfo.outputPath("pinned-group-avatars.png"),
    });
    await page.reload();
    await expect(avatars.locator('[title="Alice Fixture"]')).toHaveCount(1);
    await expect(avatars.locator('[title="Bob Fixture"]')).toHaveCount(1);
    await rail.getByRole("button", { name: "Team", exact: true }).click();
    await pin.click();
    await expect(
      page.locator('[data-channel-timeline="dm-group"]'),
    ).toBeVisible();
  });
});
