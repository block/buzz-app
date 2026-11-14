import { channelRow, openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { holdReadingFocus, readJournal } from "./reading.mjs";
import { animationsSettled } from "./animations.mjs";
import { showChannels } from "./rail-helpers.mjs";

// Browser-only boundary: real shared-menu focus/dismissal, production broker,
// IndexedDB reload and app-global preference startup. Policy matrices live in Vitest.
test.use({
  enabledPlugins: ["buzz.workflows"],
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 8, beta: 6 },
});

test("channel menu mute/read persist without selecting the row; failed mute remains retryable", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
  });
  // List actions and reload must not read the selected conversation.
  await holdReadingFocus(page);
  await open(page, app);
  const beta = channelRow(page, "beta");
  const alpha = channelRow(page, "alpha");
  const menu = page.getByRole("menu").filter({
    has: page.getByRole("menuitem", { name: "Add to section", exact: true }),
  });
  // A muted channel is quiet in the list: its row no longer reads unread.
  const unread = (row) => expect(row).toHaveAttribute("data-state", "unread");
  const quiet = (row) => expect(row).toHaveAttribute("data-state", "read");
  await unread(beta);
  // The selected channel's row is quiet; read state proves nothing read it.
  const alphaUnread = async () => {
    const frontiers = (await readJournal(page))?.state.frontiers ?? {};
    return frontiers.alpha === undefined && !frontiers["activity:alpha"];
  };
  await quiet(alpha);
  expect(await alphaUnread()).toBe(true);
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  // This fixture's legacy "beta" id cannot carry lifecycle commands, so the
  // menu offers none beside the others.
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Add to section",
    "Pin",
    "Mute",
    "Mark as read",
    "Copy link",
  ]);
  await expect(menu.getByRole("alert")).toHaveCount(0);
  await expect(menu.getByRole("separator")).toHaveCount(0);
  for (const name of ["Mute", "Mark as read"]) {
    await expect(
      menu
        .getByRole("menuitem", { name, exact: true })
        .locator(".buzz-menu-icon"),
    ).toHaveAttribute("aria-hidden", "true");
  }
  await captureActions(page, menu, testInfo.outputPath("mute-read-menu.png"));
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-mute", async (route) => {
    started();
    await gate;
    app.report.sidebarMuteFailures ??= [];
    app.report.sidebarMuteFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture mute failure" }),
    });
  });
  try {
    await menu.getByRole("menuitem", { name: "Mute", exact: true }).click();
    await requested;
    await expect(menu).toHaveCount(0);
    await expect(beta).toBeFocused();
    await expect(alpha).toHaveAttribute("aria-current", "page");
    // Reopening is usable while the relay is still held; no frozen Saving menu.
    await page.keyboard.press("Shift+F10");
    await expect(
      menu.getByRole("menuitem", { name: "Unmute", exact: true }),
    ).toBeEnabled();
    await expect(
      menu.getByRole("menuitem", { name: "Mark as read" }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
  } finally {
    release();
  }
  const failure = page.getByRole("dialog", { name: "Couldn’t mute Beta" });
  await expect(failure).toContainText("Relay request failed (502)");
  // The failed mute leaves Beta as it was.
  await unread(beta);
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    menu.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.unroute("**/sidebar-mute");
  // Session-owned retry UI remains usable while the list is hidden.
  await openPage(page, "Workflows");
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeHidden();
  await openPage(page, "Team");
  await showChannels(page);
  await beta.focus();
  await expect(beta).toBeFocused();
  await quiet(beta);
  await expect
    .poll(() => app.report.sidebarPublications?.at(-1))
    .toMatchObject({
      coordinate: "channel-mutes",
      blob: { channels: { beta: { muted: true } } },
    });
  await page.keyboard.press("ContextMenu");
  await expect(
    menu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeVisible();
  // The explicit cut is the click, not the newest loaded message: capture the
  // page clock on both sides of it rather than tolerating an arbitrary range.
  const seconds = () => page.evaluate(() => Math.floor(Date.now() / 1000));
  const clickedAfter = await seconds();
  await menu.getByRole("menuitem", { name: "Mark as read" }).click();
  await expect(menu).toHaveCount(0);
  const clickedBefore = await seconds();
  await expect(beta).toBeFocused();
  await quiet(beta);
  await quiet(alpha);
  expect(await alphaUnread()).toBe(true);
  await expect
    .poll(
      () =>
        app.report.readPublications.some(
          ({ blob }) =>
            blob.contexts.beta >= clickedAfter &&
            blob.contexts.beta <= clickedBefore,
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  await readStateSettled(page);
  await page.reload();
  await openPage(page, "Team");
  await showChannels(page);
  await beta.click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await quiet(alpha);
  expect(await alphaUnread()).toBe(true);
  await quiet(beta);
  await beta.click({ button: "right" });
  const markUnread = menu.getByRole("menuitem", {
    name: "Mark as unread",
    exact: true,
  });
  await expect(markUnread).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Mark as read", exact: true }),
  ).toHaveCount(0);
  await captureActions(page, menu, testInfo.outputPath("mark-unread-menu.png"));
  await markUnread.click();
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  // A mark is unread even in a muted channel.
  await unread(beta);
  await expect(alpha).toHaveAttribute("aria-current", "page");
  // Marked unread survives a reload whose read state is still on its way.
  const reads = holdResponse(page, "**/read-state-decode");
  await reads.ready;
  try {
    await page.reload();
    await openPage(page, "Team");
    await showChannels(page);
    await reads.started;
    await unread(beta);
    await beta.focus();
    await page.keyboard.press("Shift+F10");
    await expect(markUnread).toHaveCount(0);
    await menu
      .getByRole("menuitem", { name: "Mark as read", exact: true })
      .click();
    await expect(menu.getByRole("status")).toHaveText("Saving…");
    reads.release();
    await expect(menu).toHaveCount(0);
    await expect(beta).toBeFocused();
  } finally {
    reads.release();
    await page.unroute("**/read-state-decode");
  }
  await quiet(beta);
  await quiet(alpha);
  expect(await alphaUnread()).toBe(true);
  await page.keyboard.press("Shift+F10");
  await expect(markUnread).toBeVisible();
  const unmute = holdResponse(page, "**/sidebar-mute");
  await unmute.ready;
  try {
    await menu.getByRole("menuitem", { name: "Unmute", exact: true }).click();
    await unmute.started;
    await expect(menu).toHaveCount(0);
    await expect(beta).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await expect(
      menu.getByRole("menuitem", { name: "Mute", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
  } finally {
    unmute.release();
  }
  await expect
    .poll(() => app.report.sidebarPublications.at(-1))
    .toMatchObject({
      coordinate: "channel-mutes",
      blob: { channels: { beta: { muted: false } } },
    });
  await readStateSettled(page);
  await page.reload();
  await openPage(page, "Team");
  await showChannels(page);
  await beta.click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", { name: "Mute", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // A click in the same instant as Escape can be lost while the row menu
  // dismisses. Open the next menu only after this one has closed.
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  // Attention and lifecycle actions remain divider-free.
  await beta.click({ button: "right" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Add to section",
    "Pin",
    "Mute",
    "Mark as unread",
    "Copy link",
  ]);
  await expect(menu.getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  expect(app.report.unexpected).toEqual([]);
});

// A relay publication is not the end of read-state work: the app still reads
// its own write back and decodes it. WebKit reports a decode cut off by reload
// as a page error, so reload only after the saved journal records acceptance.
async function readStateSettled(page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("buzz-read-state-v1", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("partitions", "readonly");
              const read = tx.objectStore("partitions").getAll();
              read.onsuccess = () => {
                const journal = read.result[0];
                resolve(
                  !!journal &&
                    !journal.pending &&
                    journal.acceptedRevision >= journal.revision,
                );
              };
              read.onerror = () => reject(read.error);
              tx.oncomplete = () => db.close();
            };
          }),
      ),
    )
    .toBe(true);
}

function holdResponse(page, pattern) {
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  const ready = page.route(pattern, async (route) => {
    started();
    await gate;
    await route.continue();
  });
  return { ready, started: requested, release: () => release() };
}

// Capture the real built app menu, without unrelated conversation content.
async function captureActions(page, menu, path) {
  // Page screenshots do not wait for the menu's entrance transition to finish.
  await animationsSettled(menu, { subtree: true });
  const first = await menu.getByRole("menuitem").first().boundingBox();
  const last = await menu
    .getByRole("menuitem", { name: /^Mark as (read|unread)$/ })
    .boundingBox();
  if (!first || !last) throw new Error("Read/mute actions are not laid out");
  await page.screenshot({
    path,
    clip: {
      x: first.x - 4,
      y: first.y - 4,
      width: first.width + 8,
      height: last.y + last.height - first.y + 8,
    },
  });
}
