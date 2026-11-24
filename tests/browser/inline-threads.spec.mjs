import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { activate, clickRow, open, settle } from "./timeline.mjs";

// Browser-only: the inline thread and details are dialogs on the conversation
// visit. Only real history events, layout around a composer and the composer's
// draft storage across a remount prove them. Address parsing and the setting
// are covered by their unit tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});

const roots = (app) =>
  app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
const viewThread = (page, root) =>
  page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
const threadHeading = (page) =>
  page.getByRole("heading", { name: "Thread", exact: true });
const sheet = (page) =>
  page
    .locator("[data-details-sheet-surface]")
    .filter({ has: threadHeading(page) });
// A details sheet holds no thread of its own.
const detailsSheet = (page) =>
  page
    .locator("[data-details-sheet-surface]")
    .filter({ hasNot: threadHeading(page) });
const threadTab = (page, root) =>
  page.locator(`[role="tab"][data-tab-value="thread:alpha:${root.id}"]`);
const reply = (scope) =>
  scope.getByRole("textbox", { name: "Reply to thread", exact: true });
const side = (page) => page.locator("[data-panel-workspace]");
const filler = "More of it follows here. ".repeat(30);
/** A peer's details message: in `root`'s thread, or the channel's own. */
const details = (app, text, root) =>
  app.append(
    "primary",
    "alpha",
    `${text}\n\n${filler}`,
    true,
    false,
    root?.id,
    undefined,
    [["audience", "details"]],
  );
const showMore = (scope, text) =>
  scope
    .locator("[data-message-id]")
    .filter({ hasText: text })
    .getByRole("button", { name: "Show more", exact: true });
const close = (scope) =>
  scope.getByRole("button", { name: "Close", exact: true }).first();
/** In a thread, Show more expands the details in place: no sheet or dialog
 * opens over the view, so its reply box stays in reach, and Show less folds
 * them back. `dialogs` counts the dialogs the view itself is drawn in. */
const expandsInPlace = async (page, scope, text, dialogs = 0) => {
  const row = scope.locator("[data-message-id]").filter({ hasText: text });
  const whole = () =>
    row
      .getByText(filler.trim())
      .evaluate((element) => element.scrollHeight <= element.clientHeight + 1);
  await expect.poll(whole).toBe(false);
  await row.getByRole("button", { name: "Show more", exact: true }).click();
  const less = row.getByRole("button", { name: "Show less", exact: true });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect.poll(whole).toBe(true);
  await expect(detailsSheet(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(dialogs);
  await less.click();
  await expect.poll(whole).toBe(false);
};

test.describe("Side panel", () => {
  test.use({ threadPlacement: "side" });

  test("a thread still opens in its tab", async ({ page, app }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toBeVisible();
    await expect(reply(side(page))).toBeFocused();
    await expect(sheet(page)).toHaveCount(0);
  });

  test("details in a thread tab expand in place beside its reply box", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toBeVisible();
    details(app, "Tab findings", root);
    await expandsInPlace(page, side(page), "Tab findings");
    await expect(reply(side(page))).toBeVisible();
  });
});

test.describe("Inline", () => {
  test.use({ threadPlacement: "inline" });

  test("a thread opens over the composer and follows the dialog contract", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const beta = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator('button[data-channel-id="beta"]');
    const alpha = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator('button[data-channel-id="alpha"]');
    await beta.click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta" }),
    ).toBeVisible();
    await alpha.click();
    await settle(page);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    await expect(reply(sheet(page))).toBeFocused();
    await expect(threadTab(page, root)).toHaveCount(0);
    // Back closes the dialog and stays in the channel; Forward reopens it.
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha" }),
    ).toBeVisible();
    await page.goForward();
    await expect(sheet(page)).toBeVisible();
    // X retires it: Back leaves the channel with no redundant Alpha stop.
    await close(sheet(page)).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.goBack();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta" }),
    ).toBeVisible();
    await page.goForward();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha" }),
    ).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    // Opening another thread replaces the inline one; Escape closes it.
    await clickRow(page, viewThread(page, roots(app)[1]));
    await expect(sheet(page).getByText("Unread reply 1")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
  });

  test("the conversation's jump control hides under the sheet, not the sheet's own", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const display = (locator) =>
      locator.evaluate(
        (button) => getComputedStyle(button.closest("[data-visible]")).display,
      );
    const conversationJump = page.locator(
      "[data-channel-timeline] button[data-jump-to-latest]",
    );
    await expect.poll(() => display(conversationJump)).not.toBe("none");
    await clickRow(page, viewThread(page, roots(app)[0]));
    await expect(sheet(page)).toBeVisible();
    await expect.poll(() => display(conversationJump)).toBe("none");
    const sheetJump = sheet(page).locator("button[data-jump-to-latest]");
    await expect.poll(() => display(sheetJump)).not.toBe("none");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => display(conversationJump)).not.toBe("none");
  });

  test("details in the inline thread expand in place: Back closes the thread", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page)).toBeVisible();
    details(app, "Nested findings", root);
    await expandsInPlace(page, sheet(page), "Nested findings", 1);
    await expect(reply(sheet(page))).toBeVisible();
    // Opening long details at the latest reply keeps their start in view,
    // rather than following the latest reply past it.
    app.append(
      "primary",
      "alpha",
      `Long findings\n\n${`${filler}\n\n`.repeat(6)}`,
      true,
      false,
      root.id,
      undefined,
      [["audience", "details"]],
    );
    await showMore(sheet(page), "Long findings").click();
    await expect(sheet(page).getByText("Long findings")).toBeInViewport();
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
  });

  test("a thread sheet fits its content, starts at its header's edge and fades into its own surface", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [short, long] = roots(app);
    await clickRow(page, viewThread(page, short));
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    // The first row's name starts where the header's material ends: the
    // row's own top padding lies under that fade, not below it.
    const lead = (surface) =>
      Math.abs(
        surface
          .querySelector("[data-message-scroller] [data-message-author]")
          .getBoundingClientRect().top -
          surface
            .querySelector("header .buzz-dialog-bar-material")
            .getBoundingClientRect().bottom,
      );
    await expect.poll(() => sheet(page).evaluate(lead)).toBeLessThan(4);
    // A short thread hugs its rows instead of taking the full height.
    const room = (element) =>
      Number.parseFloat(getComputedStyle(element).maxHeight) -
      element.getBoundingClientRect().height;
    await expect.poll(() => sheet(page).evaluate(room)).toBeGreaterThan(100);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    for (let index = 0; index < 30; index++) app.reply(long.id, false, false);
    await clickRow(page, viewThread(page, long));
    await expect(sheet(page).getByText("Unread reply 1")).toBeVisible();
    // A long one grows to the maximum and reads up from its reply box.
    await expect.poll(() => sheet(page).evaluate(room)).toBeLessThan(1);
    await sheet(page)
      .locator("[data-message-scroller]")
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await expect(
      sheet(page).getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
    // Scrolled to its start, a long one leads as a short one does.
    await expect.poll(() => sheet(page).evaluate(lead)).toBeLessThan(4);
    // The panel-colored composer fade would paint a darker strip over the
    // raised sheet; the sheet's own edge material replaces it.
    expect(
      await sheet(page)
        .locator("[data-thread-history-frame] + *")
        .evaluate((element) => getComputedStyle(element, "::before").content),
    ).toBe("none");
  });

  test("details in the conversation read over its composer", async ({
    page,
    app,
  }) => {
    await open(page, app);
    details(app, "Channel findings");
    const timeline = page.locator("[data-channel-timeline]");
    await showMore(timeline, "Channel findings").click();
    const reader = detailsSheet(page);
    await expect(reader).toBeVisible();
    await expect(reader).toBeFocused();
    // The composer stays usable above the reader.
    const composer = page.getByRole("textbox", { name: "Message #Alpha" });
    await composer.click();
    await composer.pressSequentially("Thanks");
    await expect(reader).toBeVisible();
    await page.goBack();
    await expect(reader).toHaveCount(0);
    await page.goForward();
    await expect(detailsSheet(page)).toBeVisible();
    await page.reload();
    await expect(detailsSheet(page)).toBeVisible();
    await detailsSheet(page).focus();
    await page.keyboard.press("Escape");
    await expect(detailsSheet(page)).toHaveCount(0);
    await page.goForward();
    await expect(detailsSheet(page)).toHaveCount(0);
  });

  test("Move to side panel hands the thread, its draft and the reply it answers to a tab", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(reply(sheet(page))).toBeFocused();
    // The draft is aimed at a reply, not at the thread.
    const parent = sheet(page)
      .locator("[data-message-id]")
      .filter({ hasText: "Unread reply 0" });
    const parentId = await parent.getAttribute("data-message-id");
    await hoverMessage(parent);
    await parent.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(
      sheet(page).getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await expect(reply(sheet(page))).toBeFocused();
    await page.keyboard.type("Half-written reply");
    await sheet(page)
      .getByRole("button", { name: "Move to side panel", exact: true })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(threadTab(page, root)).toBeVisible();
    await expect(reply(side(page))).toHaveText("Half-written reply");
    await expect(
      side(page).getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    // The handoff retired the inline visit: Back never shows both.
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    // A thread that has a tab opens there, never inline beside it.
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(sheet(page)).toHaveCount(0);
    await expect(reply(side(page))).toHaveText("Half-written reply");
    // Sent from the tab, the draft still answers the reply it was aimed at.
    await reply(side(page)).press("Enter");
    await expect
      .poll(() =>
        app.report.publications
          .find(({ event }) => event?.content === "Half-written reply")
          ?.event.tags.filter(([key]) => key === "e"),
      )
      .toEqual([
        ["e", root.id, "", "root"],
        ["e", parentId, "", "reply"],
      ]);
  });

  // On a cold start the open channel is listed from saved membership until
  // its roster read settles, and the session reads no thread of it before
  // then. Only a real reload restores that listing with the thread's address.
  test("a thread restored before its channel is confirmed waits, then shows", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    let release;
    const roster = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = [route.request().postDataJSON()].flat();
      if (filters.some((filter) => filter?.kinds?.includes(39002))) {
        requested = true;
        await roster;
      }
      return route.continue().catch(() => {});
    });
    try {
      await page.reload();
      await expect.poll(() => requested).toBe(true);
      // The sheet is drawn once the saved channel is open. A thread mounted
      // on it would be refused at once, so settled geometry is past that.
      await expect(sheet(page)).toBeVisible();
      await settle(page);
      await expect(sheet(page).locator("[data-message-waiting]")).toHaveCount(
        1,
      );
      // The waiting sheet draws no placeholders.
      await expect(sheet(page).locator("[data-message-loading]")).toHaveCount(
        0,
      );
      await expect(sheet(page).getByRole("alert")).toHaveCount(0);
      release();
      await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
      await expect(sheet(page).locator("[data-message-waiting]")).toHaveCount(
        0,
      );
    } finally {
      release();
    }
  });
});

test.describe("Sending", () => {
  test.use({ productionBroker: false, sendChannels: ["alpha"] });

  test("a send from the composer closes the details read over it", async ({
    page,
    app,
  }) => {
    await open(page, app);
    details(app, "Channel findings");
    await showMore(
      page.locator("[data-channel-timeline]"),
      "Channel findings",
    ).click();
    await expect(detailsSheet(page)).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message #Alpha" });
    await composer.click();
    await composer.pressSequentially("Thanks, merging");
    await composer.press("Enter");
    await expect(detailsSheet(page)).toHaveCount(0);
    await expect(
      page.locator("[data-channel-timeline]").getByText("Thanks, merging"),
    ).toBeVisible();
    // Like ✕, the send retired the visit: Forward does not reopen it.
    await page.goForward();
    await expect(detailsSheet(page)).toHaveCount(0);
  });
});

const presentedTest = test.extend({
  pluginFixtures: true,
  threadPlacement: "inline",
  enabledPlugins: ["fixture.thread-arrangement"],
});

presentedTest.describe("Presented focus", () => {
  const threadHistory = (scope) =>
    scope.getByRole("region", { name: "Thread messages", exact: true });
  const arrangementStatus = (scope) =>
    scope.getByRole("status", { name: "Arrangement status", exact: true });
  const rowInReader = (history, id) =>
    history.evaluate((section, messageId) => {
      const row = section.querySelector(`[data-message-id="${messageId}"]`);
      const s = section.getBoundingClientRect();
      const r = row?.getBoundingClientRect();
      return !!r && r.bottom > s.top && r.top < s.bottom;
    }, id);

  const presentRows = (scope) =>
    scope.getByRole("button", { name: "Present rows", exact: true });

  presentedTest(
    "deleting a focused presented reply in an inline thread keeps the surviving focused row in view",
    async ({ page, app }) => {
      const [root] = roots(app);
      const replies = [];
      for (let index = 0; index < 80; index++) {
        const content =
          index === 79
            ? `Jump to <buzz://message?channel=alpha&id=${replies[40].id}&thread=${root.id}>`
            : `Presented reply ${index}: ${"Synthetic history line. ".repeat(3)}`;
        replies.push(
          app.append(
            "primary",
            "alpha",
            content,
            false,
            true,
            root.id,
            undefined,
            [],
            root.created_at + index + 10,
          ),
        );
      }
      const target = replies[40];
      const survivor = replies[41];
      const linkReply = replies[79];
      app.append("primary", "alpha", "Channel tail", false, true);

      await open(page, app);
      await clickRow(page, viewThread(page, root));
      await expect(sheet(page)).toBeVisible();
      await page.evaluate(
        ({ events, rememberTopId }) => {
          window.fixtureArrangement = { events, rememberTopId };
        },
        { events: replies, rememberTopId: linkReply.id },
      );
      await presentRows(sheet(page)).click();
      await expect(arrangementStatus(sheet(page))).toHaveText("Arranged: 80");

      const history = threadHistory(sheet(page));
      const linkRow = history.locator(`[data-message-id="${linkReply.id}"]`);
      await linkRow.scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        let armed = true;
        window.__releaseRemembered = () => release();
        window.fixtureArrangementBeforePresent = () => {
          if (!armed) return Promise.resolve();
          armed = false;
          return gate;
        };
      });
      await activate(linkRow.getByRole("link"));
      await expect(sheet(page)).toBeVisible();
      const reopenedHistory = threadHistory(sheet(page));
      const targetRow = reopenedHistory.locator(
        `[data-message-id="${target.id}"]`,
      );
      await expect(
        targetRow.locator(
          '[data-highlight-surface][class*="messageHighlight"]',
        ),
      ).toBeVisible();
      await expect(targetRow).toBeFocused();
      await page.evaluate(() => window.__releaseRemembered?.());
      await expect(arrangementStatus(sheet(page))).toHaveText("Arranged: 80");
      expect(await rowInReader(reopenedHistory, target.id)).toBe(true);
      await expect(targetRow).toBeInViewport();
      await settle(page, reopenedHistory);
      expect(await rowInReader(reopenedHistory, target.id)).toBe(true);
      await expect(targetRow).toBeInViewport();

      app.deleteTarget(target);
      await expect(targetRow).toHaveCount(0);
      const survivorRow = reopenedHistory.locator(
        `[data-message-id="${survivor.id}"]`,
      );
      await expect(survivorRow.locator(":scope > [data-layout]")).toBeFocused();
      await settle(page, reopenedHistory);

      expect(await rowInReader(reopenedHistory, survivor.id)).toBe(true);
      await expect(survivorRow).toBeInViewport();

      const scrolledAway = reopenedHistory.locator(
        `[data-message-id="${replies[75].id}"]`,
      );
      await scrolledAway.scrollIntoViewIfNeeded();
      await settle(page, reopenedHistory);
      expect(await rowInReader(reopenedHistory, survivor.id)).toBe(false);
      expect(await rowInReader(reopenedHistory, replies[75].id)).toBe(true);
      const pluginTarget = replies[5];
      await page.evaluate(
        ({ events, placeId }) => {
          window.fixtureArrangement = {
            events,
            place: { id: placeId },
          };
        },
        {
          events: replies.filter((row) => row.id !== target.id),
          placeId: pluginTarget.id,
        },
      );
      await presentRows(sheet(page)).click();
      await expect(arrangementStatus(sheet(page))).toHaveText("Arranged: 79");
      await settle(page, reopenedHistory);
      expect(await rowInReader(reopenedHistory, pluginTarget.id)).toBe(true);
      await expect(
        reopenedHistory.locator(`[data-message-id="${pluginTarget.id}"]`),
      ).toBeInViewport();
    },
  );

  presentedTest(
    "following a link to a reply hidden by a remembered presentation keeps focus on the linked reply after withdrawal",
    async ({ page, app }) => {
      const [root] = roots(app);
      const replies = Array.from({ length: 80 }, (_, index) =>
        app.append(
          "primary",
          "alpha",
          `Filtered reply ${index}`,
          false,
          true,
          root.id,
          undefined,
          [],
          root.created_at + index + 10,
        ),
      );
      const target = replies[2];
      const filtered = replies.filter((row) => row.id !== target.id);
      const linkMessage = app.append(
        "primary",
        "alpha",
        `Jump to <buzz://message?channel=alpha&id=${target.id}&thread=${root.id}>`,
        false,
        true,
      );
      await open(page, app);
      await clickRow(page, viewThread(page, root));
      await expect(sheet(page)).toBeVisible();
      await page.evaluate(
        ({ events, rememberTopId }) => {
          window.fixtureArrangement = { events, rememberTopId };
        },
        { events: filtered, rememberTopId: replies[70].id },
      );
      await presentRows(sheet(page)).click();
      await expect(arrangementStatus(sheet(page))).toHaveText("Arranged: 79");
      await expect(
        threadHistory(sheet(page)).locator(`[data-message-id="${target.id}"]`),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toHaveCount(0);

      await page.evaluate((targetId) => {
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        let armed = true;
        window.fixtureArrangementBeforePresent = () => {
          if (!armed) return Promise.resolve();
          armed = false;
          return gate;
        };
        const onFocusIn = (event) => {
          const node = event.target instanceof Element ? event.target : null;
          const row = node?.closest?.("[data-message-id]");
          if (row?.getAttribute("data-message-id") === targetId) {
            document.removeEventListener("focusin", onFocusIn, true);
            release();
          }
        };
        document.addEventListener("focusin", onFocusIn, true);
      }, target.id);

      await activate(
        page
          .locator(
            `[data-channel-timeline] [data-message-id="${linkMessage.id}"]`,
          )
          .getByRole("link"),
      );
      await expect(sheet(page)).toBeVisible();
      const history = threadHistory(sheet(page));
      const targetRow = history.locator(`[data-message-id="${target.id}"]`);
      await expect(arrangementStatus(sheet(page))).toHaveText(
        "Showing the linked reply in Buzz order",
      );
      await expect(
        targetRow.locator(
          '[data-highlight-surface][class*="messageHighlight"]',
        ),
      ).toBeVisible();
      await expect(targetRow).toBeInViewport();
      await expect(targetRow).toBeFocused();
    },
  );

  presentedTest(
    "plugin placement applies after a second hiding presentation in an inline sheet and after a failed exact lookup",
    async ({ page, app }) => {
      const [root] = roots(app);
      const replies = Array.from({ length: 80 }, (_, index) =>
        app.append(
          "primary",
          "alpha",
          `Placement reply ${index}: ${"Synthetic history line. ".repeat(3)}`,
          false,
          true,
          root.id,
          undefined,
          [],
          root.created_at + index + 10,
        ),
      );
      const target = replies[2];
      const deletedTarget = replies[40];
      const secondPlace = replies[65];
      const failedPlace = replies[60];
      const filtered = replies.filter((row) => row.id !== target.id);
      const linkHidden = app.append(
        "primary",
        "alpha",
        `Hidden link <buzz://message?channel=alpha&id=${target.id}&thread=${root.id}>`,
        false,
        true,
      );
      const linkDeleted = app.append(
        "primary",
        "alpha",
        `Missing link <buzz://message?channel=alpha&id=${deletedTarget.id}&thread=${root.id}>`,
        false,
        true,
      );

      await open(page, app);
      await clickRow(page, viewThread(page, root));
      await expect(sheet(page)).toBeVisible();
      await page.evaluate(
        ({ events, rememberTopId, placeId }) => {
          window.fixtureArrangement = {
            events,
            rememberTopId,
            onWithdraw: { events, place: { id: placeId } },
          };
        },
        {
          events: filtered,
          rememberTopId: replies[70].id,
          placeId: secondPlace.id,
        },
      );
      await presentRows(sheet(page)).click();
      await expect(arrangementStatus(sheet(page))).toHaveText("Arranged: 79");
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toHaveCount(0);

      await page.evaluate((targetId) => {
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        let armed = true;
        window.fixtureArrangementBeforePresent = () => {
          if (!armed) return Promise.resolve();
          armed = false;
          return gate;
        };
        const onFocusIn = (event) => {
          const node = event.target instanceof Element ? event.target : null;
          const row = node?.closest?.("[data-message-id]");
          if (row?.getAttribute("data-message-id") === targetId) {
            document.removeEventListener("focusin", onFocusIn, true);
            release();
          }
        };
        document.addEventListener("focusin", onFocusIn, true);
      }, target.id);

      await activate(
        page
          .locator(
            `[data-channel-timeline] [data-message-id="${linkHidden.id}"]`,
          )
          .getByRole("link"),
      );
      await expect(sheet(page)).toBeVisible();
      await expect(arrangementStatus(sheet(page))).toHaveText("Arranged: 79");
      const secondHistory = threadHistory(sheet(page));
      await settle(page, secondHistory);
      expect(await rowInReader(secondHistory, secondPlace.id)).toBe(true);
      await expect(
        secondHistory.locator(`[data-message-id="${secondPlace.id}"]`),
      ).toBeInViewport();

      await page.keyboard.press("Escape");
      await expect(sheet(page)).toHaveCount(0);

      app.deleteTarget(deletedTarget);
      await activate(
        page
          .locator(
            `[data-channel-timeline] [data-message-id="${linkDeleted.id}"]`,
          )
          .getByRole("link"),
      );
      await expect(sheet(page)).toBeVisible();
      await expect(
        sheet(page).getByText("Selected message unavailable.", { exact: true }),
      ).toBeVisible();
      const remaining = replies.filter((row) => row.id !== deletedTarget.id);
      await page.evaluate(
        ({ events, placeId }) => {
          window.fixtureArrangement = {
            events,
            place: { id: placeId },
            onWithdraw: { events, place: { id: placeId } },
          };
        },
        { events: remaining, placeId: failedPlace.id },
      );
      await presentRows(sheet(page)).click();
      await expect(arrangementStatus(sheet(page))).toHaveText("Arranged: 79");
      const failedHistory = threadHistory(sheet(page));
      await settle(page, failedHistory);
      expect(await rowInReader(failedHistory, failedPlace.id)).toBe(true);
      await expect(
        failedHistory.locator(`[data-message-id="${failedPlace.id}"]`),
      ).toBeInViewport();
    },
  );
});
