import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { hoverMessage } from "./message-actions.mjs";
import {
  holdReadingFocus,
  releaseReadingFocus,
  readJournal,
} from "./reading.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "guest",
  channelWriteKinds: [9, 9007, 40100],
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

async function readPermalink(page, app, messageId, joined = false) {
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
  const readAction = page.getByRole("menuitem", {
    name: /^(Mark read|Mark unread)$/,
  });
  const followAction = page.getByRole("menuitem", {
    name: /^(Follow thread|Unfollow thread)$/,
  });
  if (joined) {
    await expect(readAction).toBeVisible();
    const wasFollowing = (await followAction.textContent()).includes(
      "Unfollow",
    );
    await followAction.click();
    await hoverMessage(row);
    await row
      .getByRole("button", { name: "More message actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", {
        name: wasFollowing ? "Follow thread" : "Unfollow thread",
        exact: true,
      }),
    ).toBeVisible();
  } else {
    await expect(readAction).toHaveCount(0);
    await expect(followAction).toHaveCount(0);
  }
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
    await readPermalink(page, app, app.exact.target.id, true);
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
    name: "Channel access",
    exact: true,
  });
  await expect(members.getByRole("searchbox")).toHaveAttribute(
    "placeholder",
    "Search members",
  );
  await expect(
    members.getByRole("region", { name: "Not in this channel" }),
  ).toHaveCount(0);
  await members.getByRole("button", { name: "Done", exact: true }).click();
  // The registered channel menu and panel must retain Guest reading access.
  await page
    .getByRole("button", { name: "Channel actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "View canvas", exact: true })
    .click();
  const canvas = page.getByRole("region", {
    name: "Channel Canvas",
    exact: true,
  });
  const editor = canvas.getByRole("textbox", {
    name: "Canvas Markdown",
    exact: true,
  });
  await expect(editor).toBeEnabled();
  await expect(editor).toHaveJSProperty("readOnly", true);
  await expect(
    canvas.getByRole("button", { name: "Save Canvas", exact: true }),
  ).toBeDisabled();
  await expect(
    canvas.getByText("Canvas is read-only.", { exact: true }),
  ).toBeVisible();
  expect(app.report.lifecyclePublications ?? []).toEqual([]);
  expect(app.report.unexpected).toEqual([]);
});

// Real navigation focus, settled layout and durable receipt wiring are browser
// contracts. useReading's tests own dwell timing and visibility permutations.
const readingTest = test.extend({ pluginFixtures: true });
readingTest.describe("Guest reading focus", () => {
  readingTest.use({ readState: true, guestPermalinks: true });

  for (const width of [1440, 600])
    readingTest(
      `opening a read-only channel hands focus to history and quiets ordinary unread (${width}px)`,
      async ({ page, app }) => {
        const history = app.histories.get(`primary/${readerChannelId}`);
        const message = history[0];
        history.splice(1);
        await page.setViewportSize({ width, height: 950 });
        await holdReadingFocus(page);
        await page.goto(app.origin);
        await openPage(page, "Messages");
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                window.fixtureRelay.snapshot().session.unread.sync()
                  .completeness,
            ),
          )
          .toBe("snapshot");
        await releaseReadingFocus(page);
        if (width < 650)
          await page
            .getByRole("button", { name: "Show navigation", exact: true })
            .click();
        const channel = page
          .getByRole("navigation", { name: "Subscribed channels" })
          .getByRole("button", { name: /^Lifecycle channel/ });
        await expect(
          channel.getByText("Lifecycle channel", { exact: true }),
        ).toHaveCSS("font-weight", "600");
        expect(
          (await readJournal(page)).state.frontiers[
            `activity:${readerChannelId}`
          ],
        ).toBeUndefined();
        await channel.click();
        const timeline = page.getByRole("region", {
          name: "Channel message history",
          exact: true,
        });
        await expect(
          timeline.locator(`[data-message-id="${message.id}"]`),
        ).toBeVisible();
        await expect(
          page.getByRole("region", { name: "Read-only channel", exact: true }),
        ).toBeVisible();
        await expect(timeline).toBeFocused();
        await expect
          .poll(
            async () =>
              (await readJournal(page)).state.frontiers[
                `activity:${readerChannelId}`
              ],
          )
          .toBe(message.created_at);
        await expect(
          page
            .locator(
              `nav[aria-label="Subscribed channels"] [data-channel-id="${readerChannelId}"]`,
            )
            .getByText("Lifecycle channel", { exact: true }),
        ).toHaveCSS("font-weight", "400");
      },
    );
});
