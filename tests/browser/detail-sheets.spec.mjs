import { test, expect } from "./fixture.mjs";
import { animationsSettled } from "./animations.mjs";

test.use({
  productionBroker: true,
  soloChannels: ["beta"],
  historyCounts: { alpha: 2, beta: 2 },
});

// Real portals, native editing, history traversal and unchanged background
// geometry cannot be established by the state-owner DOM tests.
test("conversation and profile details share the full workspace without losing drafts", async ({
  page,
  app,
}, testInfo) => {
  const conversationUrl = (channelId) =>
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        channelId,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    )}`;
  // Give Close a meaningful previous visit; traversing beyond the first app
  // entry would leave the document rather than exercise detail dismissal.
  await page.goto(conversationUrl("beta"));
  await expect(page.locator('[data-channel-timeline="beta"]')).toBeVisible();
  await page.goto(conversationUrl("alpha"));
  const main = page.locator("[data-main-workspace]");
  const alpha = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await alpha.fill("Keep the main draft");
  const dock = page.locator("[data-channel-workspace] > [data-panel-dock]");
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  const opener = main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link");
  await opener.click();
  const beta = dock;
  await expect(beta).toBeVisible();
  await animationsSettled(page.locator("body"), { subtree: true });
  const mainBox = await main.boundingBox();
  const sideBox = await dock.boundingBox();
  expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(sideBox.x + 1);
  expect(sideBox.height).toBeCloseTo(mainBox.height, 0);
  const mainAction = await main
    .getByRole("button", { name: "Conversation actions", exact: true })
    .boundingBox();
  const sideAction = await dock
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .boundingBox();
  const selectedTab = await dock
    .getByRole("tab", { name: "Beta", exact: true })
    .boundingBox();
  expect(mainAction.y + mainAction.height / 2).toBeCloseTo(
    sideAction.y + sideAction.height / 2,
    0,
  );
  expect(selectedTab.y + selectedTab.height / 2).toBeCloseTo(
    sideAction.y + sideAction.height / 2,
    0,
  );

  const betaEditor = beta.getByRole("textbox", { name: /^Message/ });
  await betaEditor.fill("Keep the detail draft");
  await page.screenshot({
    path: testInfo.outputPath("conversation-sheet-wide.png"),
  });
  await page.setViewportSize({ width: 480, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect(betaEditor).toBeInViewport();
  const bounds = await beta.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(480);
  await page.screenshot({
    path: testInfo.outputPath("conversation-sheet-narrow.png"),
  });
  await beta
    .getByRole("button", { name: "Close Beta tab", exact: true })
    .click();
  await expect(beta).toBeHidden();
  await expect(alpha).toHaveText("Keep the main draft");
  await opener.click();
  await expect(betaEditor).toHaveText("Keep the detail draft");
  await beta
    .getByRole("button", { name: "Close Beta tab", exact: true })
    .click();
  await expect(beta).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await main
    .getByRole("button", { name: /^View .* profile$/ })
    .first()
    .click();
  const profile = dock;
  await expect(profile).toBeVisible();
  await animationsSettled(page.locator("body"), { subtree: true });
  const splitMain = await main.boundingBox();
  const splitDetail = await profile.boundingBox();
  expect(splitMain.x + splitMain.width).toBeLessThanOrEqual(splitDetail.x + 1);
  expect(splitDetail.height).toBeCloseTo(splitMain.height, 0);
  await alpha.fill("Keep typing behind the profile");
  await expect(profile).toBeVisible();
  await animationsSettled(page.locator("body"), { subtree: true });
  const workspaceBounds = await page
    .locator("[data-detail-container]")
    .boundingBox();
  expect((await profile.boundingBox()).height).toBeGreaterThan(
    workspaceBounds.height * 0.9,
  );
  await page.screenshot({ path: testInfo.outputPath("profile-rail-wide.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 480, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  const cardBounds = await profile.boundingBox();
  expect(cardBounds.x).toBeGreaterThanOrEqual(0);
  expect(cardBounds.x + cardBounds.width).toBeLessThanOrEqual(480);
  await expect(
    profile.getByRole("button", { name: /^Close .* tab$/ }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("profile-rail-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await expect(
    profile.getByRole("complementary", { name: "Profile", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(profile).toBeHidden();
  await page.goForward();
  await expect(profile).toBeVisible();
  await profile.getByRole("button", { name: /^Close .* tab$/ }).click();
  await expect(profile).toBeHidden();
  await page.goBack();
  await expect(page.locator('[data-channel-timeline="beta"]')).toBeVisible();
  await page.goForward();
  await expect(page.locator('[data-channel-timeline="alpha"]')).toBeVisible();
  await expect(profile).toBeHidden();
});

// This needs real shell routing, portals and editor identity: a link must add a
// detail tab without replacing Team's list or remounting the source composer.
test("Team's list opens linked conversations and threads beside the source", async ({
  page,
  app,
}, testInfo) => {
  const root = app.append("primary", "beta", "Linked topic", false);
  const message = app.append(
    "primary",
    "alpha",
    `[Related thread](buzz://channel/beta/${root.id}) [Related chat](buzz://channel/beta)`,
    false,
  );
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  const team = page.getByRole("region", { name: "Team", exact: true });
  await team
    .locator('[data-activity-row="alpha"] [data-conversation-row]')
    .click();
  const reader = team.getByRole("region", {
    name: "Conversation detail",
    exact: true,
  });
  const editor = reader.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await editor.fill("Keep Team context");
  const original = await editor.elementHandle();
  const route = page.url();
  const source = reader.locator(`[data-message-id="${message.id}"]`);
  await source
    .getByRole("link", { name: "Related thread", exact: true })
    .click();
  const dock = reader.locator("[data-panel-dock]");
  await expect(
    dock.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveText("Keep Team context");
  expect(page.url()).toBe(route);
  await source
    .getByRole("link", { name: "Open Chat: Beta", exact: true })
    .click();
  await expect(dock.getByRole("tab")).toHaveCount(2);
  await expect(dock.locator('[data-channel-timeline="beta"]')).toBeVisible();
  await expect(editor).toHaveText("Keep Team context");
  expect(
    await editor.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("team-contextual-tabs.png"),
  });
  await dock
    .getByRole("button", { name: "Close Beta tab", exact: true })
    .click();
  await dock.getByRole("button", { name: /^Close .* tab$/ }).click();
  await expect(dock).toBeHidden();
  await expect(editor).toHaveText("Keep Team context");
  await expect(
    team.locator('[data-activity-row="alpha"] [data-conversation-row]'),
  ).toHaveAttribute("aria-current", "page");
});
