import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { hoverMessage } from "./message-actions.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "guest",
  historyCounts: { alpha: 1, beta: 1 },
});

const readerChannelId = "11111111-1111-4111-8111-111111111111";
const permalink = (app, messageId) =>
  `${app.origin}/#buzz=${encodeURIComponent(
    JSON.stringify({
      version: 1,
      kind: "conversation",
      channelId: readerChannelId,
      messageId,
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
    }),
  )}`;

async function readPermalink(page, app, messageId) {
  await page.goto(permalink(app, messageId));
  const thread = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  const row = thread.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toBeVisible();
  await expect(
    thread.locator(`[data-message-id="${app.exact.root.id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator(`[data-message-id="${app.exact.replies[1].id}"]`),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Read-only channel" }).last(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Join", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  // Opening the actual message menu settles the deferred message actions.
  await hoverMessage(row);
  await row
    .getByRole("button", { name: "More message actions", exact: true })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "React", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(React|Add reaction)/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
}

function expectNotJoined(app) {
  expect(
    app
      .startupCache()
      .discovery.filter(
        (event) =>
          event.kind === 39002 &&
          event.tags.some(
            ([key, value]) => key === "d" && value === readerChannelId,
          ),
      ),
  ).toEqual([]);
  expect(app.report.lifecyclePublications ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 9021 })]),
  );
  expect(app.report.publications).toEqual([]);
  expect(app.report.unexpected).toEqual([]);
}

// Browser-only: cold-link resolution, surrounding thread history, deferred row
// actions, and a departed guest cross routing, discovery and publication owners.
test.describe("Guest-default permalinks", () => {
  test.use({ guestPermalinks: true, exactMessages: "nested" });

  test.describe("nonmember", () => {
    test.use({ lifecycleRole: "nonmember" });
    test("old message and nested reply links read without joining", async ({
      page,
      app,
    }) => {
      expectNotJoined(app);
      await readPermalink(page, app, app.exact.root.id);
      await readPermalink(page, app, app.exact.target.id);
      expectNotJoined(app);
    });
  });

  test("a guest leaves and reopens both links as the same read-only preview", async ({
    page,
    app,
  }) => {
    await readPermalink(page, app, app.exact.target.id);
    await page
      .getByRole("button", { name: "Channel actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Leave channel", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Leave channel: Lifecycle channel",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Leave channel", exact: true })
      .click();
    await expect
      .poll(() => app.report.lifecyclePublications?.map((event) => event.kind))
      .toEqual([9022]);
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Leaving channel…", exact: true }),
    ).toHaveCount(0);
    await readPermalink(page, app, app.exact.root.id);
    await readPermalink(page, app, app.exact.target.id);
    expectNotJoined(app);
  });
});

// The real broker -> signed roster -> sidebar -> conversation wiring and
// keyboard menu handoff are browser boundaries; role matrices stay in Vitest.
test("a joined guest can read and leave without receiving a composer or Join prompt", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.getByRole("button", {
    name: "Lifecycle channel",
    exact: true,
  });
  await row.click();
  await expect(
    page.getByRole("region", { name: "Read-only channel" }),
  ).toHaveText("Read-only access");
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Join", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Channel history" }),
  ).toBeVisible();
  await expect(
    page.getByText("Start the conversation below.", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Channel actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Leave channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Channel actions", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  const members = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  await expect(members.getByRole("searchbox")).toHaveAttribute(
    "placeholder",
    "Search members",
  );
  await expect(
    members.getByRole("region", { name: "Not in this channel" }),
  ).toHaveCount(0);
  expect(app.report.lifecyclePublications ?? []).toEqual([]);
  expect(app.report.unexpected).toEqual([]);
});
