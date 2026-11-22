import { test, expect } from "./fixture.mjs";
import { activate, clickRow, open, settle } from "./timeline.mjs";

// Browser-only: with the Inline setting, profiles and link panels open as
// dialogs over the view they were opened from, addressed by its visit. Only
// real history events, sheet layout around a composer and the tab workspace
// prove that. The decision itself and the address are covered by unit tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});

const pull = "https://github.com/sample/project/pull/42";
const pullLink = (scope) =>
  scope.getByRole("link", { name: "project#42 · Fixture change", exact: true });
const pullHeading = (scope) =>
  scope.getByRole("heading", { name: "Fixture change #42", exact: true });
const routePull = (page) =>
  page.route("https://api.github.com/repos/sample/project/pulls/*", (route) =>
    route.fulfill({
      json: {
        title: "Fixture change",
        state: "open",
        user: { login: "fixture" },
        body: "Read-only fixture content",
      },
    }),
  );
const roots = (app) =>
  app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
const viewThread = (page, root) =>
  page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
const sheets = (page) => page.locator("[data-details-sheet-surface]");
const titled = (page, name) =>
  sheets(page).and(page.getByRole("dialog", { name, exact: true }));
const thread = (page) => titled(page, "Thread");
const profile = (page) => titled(page, "Profile");
const github = (page) => titled(page, "GitHub");
const side = (page) => page.locator("[data-panel-workspace]");
const close = (sheet) =>
  sheet.getByRole("button", { name: "Close", exact: true }).first();
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
// The visit's target, as the browser history entry records it.
const address = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry.target);
const avatar = (scope) =>
  scope.getByRole("button", { name: /^View .+ profile$/ }).first();

test.describe("Side panel", () => {
  test.use({ threadPlacement: "side" });

  test("a profile and a pull request still open as tabs", async ({
    page,
    app,
  }) => {
    await routePull(page);
    await open(page, app);
    app.append("primary", "alpha", `Review ${pull}`);
    await activate(pullLink(page));
    await expect(
      pullHeading(page.getByRole("complementary", { name: "GitHub" })),
    ).toBeVisible();
    await expect(sheets(page)).toHaveCount(0);
    await clickRow(page, avatar(page.locator("[data-channel-timeline]")));
    await expect(
      page.getByRole("complementary", { name: "Profile", exact: true }),
    ).toBeVisible();
    await expect(sheets(page)).toHaveCount(0);
  });
});

test.describe("Inline", () => {
  test.use({ threadPlacement: "inline" });

  test("a pull request and a profile open over the conversation; Open as tab hands them to a tab", async ({
    page,
    app,
  }) => {
    await routePull(page);
    await open(page, app);
    await settle(page);
    app.append("primary", "alpha", `Review ${pull}`);
    await composer(page).fill("Still typing this");
    await activate(pullLink(page));
    await expect(pullHeading(github(page))).toBeVisible();
    await expect(side(page).getByRole("tab")).toHaveCount(0);
    // A panel takes the full height over the composer it covers.
    const [sheet, pane] = [
      await github(page).boundingBox(),
      await page
        .getByRole("article", { name: "Conversation", exact: true })
        .boundingBox(),
    ];
    expect(sheet.height).toBeGreaterThan(pane.height * 0.7);
    // The conversation's own dialog: no view root.
    expect((await address(page)).layer).toMatchObject({ target: pull });
    expect((await address(page)).layer.rootId).toBeUndefined();
    // Back and Forward walk it as a dialog; reload restores it.
    await page.goBack();
    await expect(github(page)).toHaveCount(0);
    await page.goForward();
    await expect(pullHeading(github(page))).toBeVisible();
    await page.reload();
    await expect(pullHeading(github(page))).toBeVisible();
    // Open as tab: the layer closes and its tab opens; the draft stays.
    await github(page)
      .getByRole("button", { name: "Open as tab", exact: true })
      .click();
    await expect(github(page)).toHaveCount(0);
    await expect(
      pullHeading(page.getByRole("complementary", { name: "GitHub" })),
    ).toBeVisible();
    await expect(composer(page)).toHaveText("Still typing this");
    expect((await address(page)).layer).toBeUndefined();
    // With its tab open, the link focuses that tab instead of a dialog.
    await activate(pullLink(page));
    await expect(github(page)).toHaveCount(0);
    await expect(side(page).getByRole("tab")).toHaveCount(1);
    // A profile from an avatar opens over the conversation; X closes it.
    await clickRow(page, avatar(page.locator("[data-channel-timeline]")));
    await expect(profile(page)).toBeVisible();
    await expect(side(page).getByRole("tab")).toHaveCount(1);
    await close(profile(page)).click();
    await expect(profile(page)).toHaveCount(0);
    await expect(composer(page)).toHaveText("Still typing this");
  });

  test("thread → profile → pull request: Back walks them, reload restores, X closes the top", async ({
    page,
    app,
  }) => {
    await routePull(page);
    await open(page, app);
    await settle(page);
    const [root] = roots(app);
    app.append("primary", "alpha", `Review ${pull}`, true, false, root.id);
    await clickRow(page, viewThread(page, root));
    await expect(thread(page)).toBeVisible();
    const threadVisit = await address(page);
    // The profile reads over the thread's reply box; the thread grows tall
    // beneath it.
    await avatar(thread(page)).click();
    await expect(profile(page)).toBeVisible();
    expect((await address(page)).layer).toMatchObject({ rootId: root.id });
    await expect(thread(page)).toHaveAttribute("data-tall", "true");
    // From the thread, the pull request replaces the profile.
    await activate(pullLink(thread(page)));
    await expect(pullHeading(github(page))).toBeVisible();
    await expect(profile(page)).toHaveCount(0);
    await expect(thread(page)).toBeVisible();
    await page.reload();
    await expect(pullHeading(github(page))).toBeVisible();
    await expect(thread(page)).toBeVisible();
    await page.goBack();
    await expect(profile(page)).toBeVisible();
    await expect(github(page)).toHaveCount(0);
    await page.goBack();
    await expect(profile(page)).toHaveCount(0);
    await expect(thread(page)).toBeVisible();
    await expect(thread(page)).not.toHaveAttribute("data-tall", "true");
    expect(await address(page)).toEqual(threadVisit);
    await page.goBack();
    await expect(thread(page)).toHaveCount(0);
    await page.goForward();
    await page.goForward();
    await page.goForward();
    await expect(pullHeading(github(page))).toBeVisible();
    // X closes only the top layer; the thread stays.
    await close(github(page)).click();
    await expect(github(page)).toHaveCount(0);
    await expect(thread(page)).toBeVisible();
    expect((await address(page)).layer).toBeUndefined();
    // Closing the thread closes a layer over it too.
    await avatar(thread(page)).click();
    await expect(profile(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(profile(page)).toHaveCount(0);
    await close(thread(page)).click();
    await expect(thread(page)).toHaveCount(0);
    await expect(side(page).getByRole("tab")).toHaveCount(0);
  });
});

// Huddles and apps can't open in this fixture (a Huddle needs a UUID channel,
// an app the native browser); the placement unit test covers their
// declarations. Canvas opens here.
test.describe("Inline, live panels", () => {
  test.use({
    threadPlacement: "inline",
    channelWriteKinds: [9, 9007, 40100],
  });

  test("Canvas still opens as a tab", async ({ page, app }) => {
    await open(page, app);
    await page
      .getByRole("button", { name: "Channel actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "View canvas", exact: true })
      .click();
    await expect(
      side(page).getByRole("region", { name: "Channel Canvas", exact: true }),
    ).toBeVisible();
    await expect(side(page).getByRole("tab", { name: "Canvas" })).toBeVisible();
    await expect(sheets(page)).toHaveCount(0);
  });
});
