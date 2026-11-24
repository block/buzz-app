import { test, expect } from "./fixture.mjs";
import { activate, clickRow, open, settle } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

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
// A point of the conversation left of the sheets over it, clear of them all.
const background = async (page) => {
  const pane = await page
    .getByRole("article", { name: "Conversation", exact: true })
    .boundingBox();
  const sheet = await sheets(page).first().boundingBox();
  return [(pane.x + sheet.x) / 2, pane.y + pane.height / 2];
};

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

  test("a thread from the sidebar's preview or a link in another channel opens inline in its channel", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    const reply = app.append(
      "primary",
      "alpha",
      "Linked reply",
      true,
      false,
      root.id,
    );
    await page.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    // The sidebar's unread-thread preview goes to the thread's channel with
    // the thread inline, not a tab.
    await page.locator('button[data-channel-id="alpha"]').hover();
    await page
      .getByRole("dialog", { name: "Activity in Alpha" })
      .getByRole("region", { name: "Unread threads" })
      .getByRole("button", { name: /^Open unread thread/ })
      .first()
      .click();
    await expect(thread(page)).toBeVisible();
    expect(await address(page)).toMatchObject({ channelId: "alpha" });
    expect((await address(page)).inline).toMatch(/^[a-f0-9]{64}$/);
    expect(await address(page)).not.toHaveProperty("threadRootId");
    await expect(side(page).getByRole("tab")).toHaveCount(0);
    await close(thread(page)).click();
    await expect(thread(page)).toHaveCount(0);
    // So does a link in another channel to a reply in that thread, as the
    // app copies one.
    await page.locator('button[data-channel-id="beta"]').click();
    const message = app.append(
      "primary",
      "beta",
      `See <buzz://message?channel=alpha&id=${reply.id}&thread=${root.id}>`,
    );
    await activate(
      page
        .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
        .getByRole("link", { name: /Alpha$/ }),
    );
    await expect(thread(page).getByText("Linked reply")).toBeVisible();
    await expect
      .poll(() => address(page))
      .toMatchObject({ channelId: "alpha", inline: root.id });
    await expect(side(page).getByRole("tab")).toHaveCount(0);
  });

  test("a link here to a reply opens its thread inline at that reply", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root, other] = roots(app);
    const [linked] = Array.from({ length: 30 }, () =>
      app.reply(root.id, false, false),
    );
    // The link's thread hint names another thread. The reply's own thread
    // opens, and the address names the root read from the reply.
    const message = app.append(
      "primary",
      "alpha",
      `See <buzz://message?channel=alpha&id=${linked.id}&thread=${other.id}>`,
    );
    await activate(
      page
        .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
        .getByRole("link", { name: /Alpha$/ }),
    );
    await expect
      .poll(() => address(page))
      .toMatchObject({ inline: root.id, inlineMessage: linked.id });
    const row = thread(page).locator(`[data-message-id="${linked.id}"]`);
    await expect(row).toBeInViewport();
    await expect(side(page).getByRole("tab")).toHaveCount(0);
    await page.reload();
    await expect(row).toBeInViewport();
    // The reply goes with the thread that named it, so the sheet closes.
    await close(thread(page)).click();
    await expect(thread(page)).toHaveCount(0);
    expect(await address(page)).not.toHaveProperty("inline");
    expect(await address(page)).not.toHaveProperty("inlineMessage");
  });

  test("a thread link in a side-pane thread opens beside it; the same link in the conversation opens inline", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root, other] = roots(app);
    const tab = (row) =>
      side(page).locator(
        `[role="tab"][data-tab-value="thread:alpha:${row.id}"]`,
      );
    // A thread in the side pane, with the conversation still in the main one.
    await clickRow(page, viewThread(page, root));
    await thread(page)
      .getByRole("button", { name: "Move to side panel", exact: true })
      .click();
    await expect(tab(root)).toHaveAttribute("aria-selected", "true");
    await expect(thread(page)).toHaveCount(0);
    const linked = app.append(
      "primary",
      "alpha",
      "Linked reply",
      true,
      false,
      other.id,
    );
    const link = `See <buzz://message?channel=alpha&id=${linked.id}&thread=${other.id}>`;
    const inChannel = app.append("primary", "alpha", link);
    const inThread = app.append("primary", "alpha", link, true, false, root.id);
    const linkIn = (scope, message) =>
      scope
        .locator(`[data-message-id="${message.id}"]`)
        .getByRole("link", { name: /Alpha$/ });
    // From the conversation, the link's thread still opens over the composer,
    // with a thread open beside it.
    await activate(linkIn(page.locator("[data-channel-timeline]"), inChannel));
    await expect(thread(page).getByText("Linked reply")).toBeVisible();
    await expect
      .poll(() => address(page))
      .toMatchObject({ channelId: "alpha", inline: other.id });
    await expect(side(page).getByRole("tab")).toHaveCount(1);
    await close(thread(page)).click();
    await expect(thread(page)).toHaveCount(0);
    // From the side-pane thread, it opens as a tab beside that thread: the
    // conversation takes no sheet, and the address names the thread's tab.
    await activate(linkIn(side(page), inThread));
    await expect(tab(other)).toHaveAttribute("aria-selected", "true");
    await expect(side(page).getByText("Linked reply")).toBeVisible();
    await expect(thread(page)).toHaveCount(0);
    await expect(side(page).getByRole("tab")).toHaveCount(2);
    await expect
      .poll(() => address(page))
      .toMatchObject({ channelId: "alpha", threadRootId: other.id });
    expect(await address(page)).not.toHaveProperty("inline");
    // Back and Forward switch the pane's tabs, as for any thread tab.
    await page.goBack();
    await expect(tab(root)).toHaveAttribute("aria-selected", "true");
    await expect(thread(page)).toHaveCount(0);
    await page.goForward();
    await expect(tab(other)).toHaveAttribute("aria-selected", "true");
    await expect(thread(page)).toHaveCount(0);
    // The thread has its tab now. Its link in the conversation names the
    // visit already on screen, and leaves that tab showing.
    await activate(linkIn(page.locator("[data-channel-timeline]"), inChannel));
    await expect(composer(page)).toBeVisible();
    await expect(tab(other)).toHaveAttribute("aria-selected", "true");
    await expect(thread(page)).toHaveCount(0);
    // And from another tab, the same link brings it back.
    await tab(root).click();
    await expect(tab(root)).toHaveAttribute("aria-selected", "true");
    await activate(linkIn(page.locator("[data-channel-timeline]"), inChannel));
    await expect(tab(other)).toHaveAttribute("aria-selected", "true");
    await expect(thread(page)).toHaveCount(0);
  });

  test("a thread link in a side-pane thread leaves the thread open over the conversation as it is", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root, other] = roots(app);
    const tab = (row) =>
      side(page).locator(
        `[role="tab"][data-tab-value="thread:alpha:${row.id}"]`,
      );
    await clickRow(page, viewThread(page, root));
    await thread(page)
      .getByRole("button", { name: "Move to side panel", exact: true })
      .click();
    await expect(tab(root)).toHaveAttribute("aria-selected", "true");
    // A third thread, linked from the thread in the side pane.
    const third = app.append("primary", "alpha", "Third root");
    const linked = app.append(
      "primary",
      "alpha",
      "Linked reply",
      true,
      false,
      third.id,
    );
    const inThread = app.append(
      "primary",
      "alpha",
      `See <buzz://message?channel=alpha&id=${linked.id}&thread=${third.id}>`,
      true,
      false,
      root.id,
    );
    // The conversation has its own thread open over the composer.
    await clickRow(page, viewThread(page, other));
    await expect(thread(page)).toBeVisible();
    // The side link opens its tab, and the sheet stays where it was.
    await activate(
      side(page)
        .locator(`[data-message-id="${inThread.id}"]`)
        .getByRole("link", { name: /Alpha$/ }),
    );
    await expect(tab(third)).toHaveAttribute("aria-selected", "true");
    await expect(side(page).getByText("Linked reply")).toBeVisible();
    await expect(thread(page)).toBeVisible();
    await expect
      .poll(() => address(page))
      .toMatchObject({ threadRootId: third.id, inline: other.id });
    // Closing that tab is the side pane's business too.
    await tab(third).hover();
    await side(page)
      .getByRole("button", { name: /^Close .*tab/ })
      .last()
      .click();
    await expect(tab(third)).toHaveCount(0);
    await expect(thread(page)).toBeVisible();
    // The sheet still closes on its own, leaving the side pane's tab.
    await close(thread(page)).click();
    await expect(thread(page)).toHaveCount(0);
    await expect(tab(root)).toHaveAttribute("aria-selected", "true");
  });

  test("a pinned reply opens its thread as a tab from the Pinned panel", async ({
    page,
    app,
  }) => {
    // The relay's pin list names a reply from the seeded history.
    const reply = () =>
      app.histories
        .get("primary/alpha")
        .find((row) => row.content === "Broadcast reply");
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (!filters.every((filter) => filter.kinds?.includes(30623)))
        return route.continue();
      return route.fulfill({
        json: [
          app.signRelay({
            kind: 30623,
            content: "",
            tags: [
              ["d", "alpha"],
              ["h", "alpha"],
              ["e", reply().id],
            ],
            created_at: Math.floor(Date.now() / 1000),
          }),
        ],
      });
    });
    await open(page, app);
    await page
      .getByRole("button", { name: "Pinned messages", exact: true })
      .click();
    // The panel sits in the side pane, so the thread opens there.
    await page
      .getByRole("list", { name: "Pinned messages" })
      .getByRole("button")
      .first()
      .click();
    await expect(
      side(page).getByRole("tab", { selected: true }),
    ).toHaveAttribute("data-tab-value", /^thread:alpha:/);
    await expect(side(page).getByText("Broadcast reply")).toBeVisible();
    await expect(sheets(page)).toHaveCount(0);
  });

  test.describe("Activity", () => {
    test.use({
      threadUnreadMentions: true,
      historyCounts: { alpha: 2, beta: 1 },
    });

    test("a thread tab's channel button opens the channel with the thread inline", async ({
      page,
      app,
    }) => {
      await open(page, app);
      const root = roots(app).find((row) => row.content === "Thread root 1");
      // The root row's thread summary says whether the thread is unread.
      const summary = page.locator(
        `[data-channel-timeline] [data-message-id="${root.id}"] [data-thread-summary]`,
      );
      await expect(summary).toHaveAttribute("aria-label", /unread/);
      await clickRow(page, viewThread(page, root));
      await expect(thread(page)).toBeVisible();
      // Read here, the thread's Activity row opens its tab at its reply, the
      // message the channel button then carries.
      await expect(summary).not.toHaveAttribute("aria-label", /unread/);
      await openPage(page, "Activity");
      const inbox = page.getByRole("region", { name: "Activity", exact: true });
      await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
      const item = inbox.locator(`[data-inbox-row="alpha:${root.id}"]`);
      await expect(item).not.toHaveAttribute("data-unread", "true");
      await item.getByRole("button", { name: /^Open / }).click();
      await side(inbox)
        .getByRole("button", { name: "#Alpha", exact: true })
        .click();
      await expect(thread(page)).toBeVisible();
      await expect
        .poll(() => address(page))
        .toMatchObject({ channelId: "alpha", inline: root.id });
      expect(await address(page)).not.toHaveProperty("threadRootId");
      expect(await address(page)).not.toHaveProperty("context");
      await expect(side(page).getByRole("tab")).toHaveCount(0);
      await page.goBack();
      await expect(inbox).toBeVisible();
    });
  });

  test.describe("Membership", () => {
    test.use({
      membershipActivity: true,
      readState: false,
      threadUnread: false,
      historyCounts: { alpha: 1, beta: 1 },
    });

    test("a name in a membership notice opens its profile over the conversation", async ({
      page,
      app,
    }) => {
      await open(page, app);
      await page
        .locator("[data-membership-row]")
        .getByRole("button", { name: "View Pinky profile" })
        .click();
      await expect(profile(page)).toContainText("Pinky");
      expect((await address(page)).layer).toMatchObject({
        target: expect.stringMatching(/^nostr:/),
      });
      await expect(side(page).getByRole("tab")).toHaveCount(0);
    });
  });

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

  test("thread → profile → pull request: Back walks them, reload restores, X or a press around them closes the top", async ({
    page,
    app,
  }) => {
    await routePull(page);
    await open(page, app);
    await settle(page);
    const [root] = roots(app);
    app.append("primary", "alpha", `Review ${pull}`, true, false, root.id);
    await clickRow(page, viewThread(page, root));
    // The thread is drawn, and its reply box focused, once it has read.
    await expect(
      thread(page).getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      }),
    ).toBeFocused();
    const threadVisit = await address(page);
    // The profile reads over the thread's reply box; the thread grows tall
    // beneath it.
    await avatar(thread(page)).click();
    await expect(profile(page)).toBeVisible();
    expect((await address(page)).layer).toMatchObject({ rootId: root.id });
    await expect(thread(page)).toHaveAttribute("data-tall", "true");
    // Opening the profile draws the thread again; it takes input once drawn.
    await expect(thread(page)).toHaveAttribute("data-revealed", "");
    // From the thread, the pull request replaces the profile. The thread may
    // still be redrawing from the profile's remount, inert until it shows.
    await expect(async () => {
      await pullLink(thread(page)).focus();
      await expect(pullLink(thread(page))).toBeFocused({ timeout: 500 });
    }).toPass();
    await pullLink(thread(page)).press("Enter");
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
    // Escape closes only the top layer too.
    await avatar(thread(page)).click();
    await expect(profile(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(profile(page)).toHaveCount(0);
    // Closing the profile draws the thread again, inert until it shows; its
    // reply box takes focus as it does.
    await expect(
      thread(page).getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      }),
    ).toBeFocused();
    // A press in the top sheet closes nothing; each press on the conversation
    // around the sheets closes the top one. The sheet is still moving when its
    // heading shows, so the click waits for it to come to rest.
    await activate(pullLink(thread(page)));
    await pullHeading(github(page)).click();
    await expect(github(page)).toBeVisible();
    await page.mouse.click(...(await background(page)));
    await expect(github(page)).toHaveCount(0);
    await expect(thread(page)).toBeVisible();
    expect((await address(page)).layer).toBeUndefined();
    await page.mouse.click(...(await background(page)));
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

  test("Canvas still opens as a tab, and a thread link in it opens a tab beside it", async ({
    page,
    app,
  }) => {
    let canvas;
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (!filters.every((filter) => filter.kinds?.includes(40100)))
        return route.continue();
      return route.fulfill({ json: [canvas] });
    });
    await open(page, app);
    const [root] = roots(app);
    const reply = app.append(
      "primary",
      "alpha",
      "Linked reply",
      true,
      false,
      root.id,
    );
    canvas = app.sign({
      kind: 40100,
      content: `[The thread](buzz://message?channel=alpha&id=${reply.id}&thread=${root.id})`,
      tags: [["h", "alpha"]],
      created_at: 1700000000,
    });
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
    // The Canvas sits in the side pane, so its thread link opens there.
    await side(page)
      .getByRole("region", { name: "Channel Canvas", exact: true })
      .getByRole("link")
      .click();
    await expect(
      side(page).locator(
        `[role="tab"][data-tab-value="thread:alpha:${root.id}"]`,
      ),
    ).toHaveAttribute("aria-selected", "true");
    await expect(side(page).getByText("Linked reply")).toBeVisible();
    await expect(side(page).getByRole("tab", { name: "Canvas" })).toBeVisible();
    await expect(sheets(page)).toHaveCount(0);
  });
});
