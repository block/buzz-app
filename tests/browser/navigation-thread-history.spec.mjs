import { test, expect, ids } from "./fixture.mjs";
import { open, virtuaIdle, wheel } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 20 },
});

test("Back restores each thread visit before the previous channel", async ({
  page,
  app,
}) => {
  const beta = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator(`button[data-channel-id="${ids.beta}"]`);
  // Intent preparation can supply the same badge as the held unread batch.
  // Gate both sources; focus explicitly instead of relying on roster warming.
  let releaseHead;
  let sawHead;
  const headHeld = new Promise((resolve) => {
    releaseHead = resolve;
  });
  const headStarted = new Promise((resolve) => {
    sawHead = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.top_level && filter["#h"]?.includes(ids.beta))
    ) {
      sawHead();
      await headHeld;
    }
    await route.continue().catch(() => {});
  });
  app.relay.sidebarApi.hold();
  try {
    await open(page, app);
    await beta.focus(); // Prepare without selecting or adding a navigation visit.
    await headStarted;
    await expect.poll(() => app.report.sidebarHolds.length).toBe(1);
    await expect(beta).toHaveAccessibleName("Beta");
  } finally {
    releaseHead();
    app.relay.sidebarApi.release();
  }
  // Unread evidence changes the accessible name independently of navigation.
  await expect(beta.getByRole("img")).toHaveAccessibleName(
    "20 unread messages.",
  );
  const roots = app.histories
    .get(`primary/${ids.alpha}`)
    .filter((row) => row.content.startsWith("Thread root"));
  const threadButton = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });

  await threadButton(roots[0]).click();
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await threadButton(roots[1]).click();
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  const openThread = await panel
    .getByRole("region", { name: "Thread messages", exact: true })
    .elementHandle();
  await threadButton(roots[1]).click();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  expect(await openThread.evaluate((node) => node.isConnected)).toBe(true);
  await beta.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();

  await page.goBack();
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  const threadPanel = await panel.elementHandle();
  await page.goBack();
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  expect(
    await threadPanel.evaluate(
      (node) => node === document.querySelector('aside[aria-label="Thread"]'),
    ),
  ).toBe(true);
});

for (const mode of ["bottom", "reading", "jump"]) {
  const reading = mode === "reading";
  test(`ordinary reply-count opening ${reading ? "preserves intervening reading" : mode === "jump" ? "preserves keyboard jump intent" : "finishes at the bottom"} after held pagination`, async ({
    page,
    app,
  }) => {
    const root = app.histories
      .get(`primary/${ids.alpha}`)
      .find((row) => row.content === "Thread root 0");
    let last;
    for (let i = 0; i < 120; i++) last = app.reply(root.id, false, false);
    await open(page, app);
    const region = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    let heldContinuation;
    const routePattern = "**/api/relay/**/query";
    const holdHistory = async (route) => {
      if (
        !requested &&
        route
          .request()
          .postDataJSON()
          .some(
            (filter) =>
              filter.thread_window &&
              filter.until !== undefined &&
              filter.until < last.created_at - 100,
          )
      ) {
        requested = true;
        heldContinuation = held.then(() => route.continue());
        await heldContinuation;
        return;
      }
      await route.continue();
    };
    await page.route(routePattern, holdHistory);
    try {
      const trigger = page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      // Virtua can retain its pointer lock after geometry stops moving. Wait
      // for input readiness before Playwright tries alternate scroll alignments.
      await virtuaIdle(page);
      await trigger.click();
      await expect(
        region.getByText("New peer reply", { exact: true }),
      ).toHaveCount(10);
      // Main's opening-completion barrier belongs before user-demand pagination,
      // not inside the deliberately held final page.
      await expect(region).toHaveAttribute("aria-busy", "false");
      await expect
        .poll(() =>
          region.evaluate(
            (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
          ),
        )
        .toBeLessThan(4);
      const demandOlder = async () => {
        await region.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        await region.hover();
        await page.mouse.wheel(0, -300);
      };
      for (const count of [60, 110]) {
        await demandOlder();
        await expect(
          region.getByText("New peer reply", { exact: true }),
        ).toHaveCount(count);
      }
      await demandOlder();
      await expect.poll(() => requested).toBe(true);
      // The final strict page is held; opening and earlier user-demand pages
      // already completed. Cached broadcast plus root and 110 replies mount.
      await expect(region.locator("[data-message-id]")).toHaveCount(112);
      await expect(
        region.getByText("Broadcast descendant", { exact: true }),
      ).toHaveCount(0);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      // The panel is presented even while bounded history is still pending.
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      let position = 0;
      let anchor;
      if (reading || mode === "jump") {
        await region.evaluate((node) => {
          node.scrollTop = 500;
          node.dispatchEvent(new Event("scroll"));
        });
        await expect
          .poll(() => region.evaluate((node) => node.scrollTop))
          .toBe(500);
        anchor = await region.evaluate((node) => {
          const top = node.getBoundingClientRect().top;
          const row = [...node.querySelectorAll("ol [data-message-id]")].find(
            (row) => row.getBoundingClientRect().bottom > top,
          );
          return {
            id: row.dataset.messageId,
            offset: row.getBoundingClientRect().top - top,
          };
        });
      } else {
        await region.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          node.dispatchEvent(new Event("scroll"));
        });
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(4);
      }
      if (mode === "jump") {
        // Hold history across the keyboard jump, before its completion fallback.
        // pauseAt installs the clock itself; a separate install followed by
        // pauseAt(start + 1) races real elapsed time between the two calls.
        await page.clock.pauseAt(new Date());
        const jumpToLatest = region.locator("button[data-jump-to-latest]");
        await expect(jumpToLatest).toHaveAccessibleName("Jump to latest");
        await jumpToLatest.focus();
        await page.keyboard.press("Enter");
        await page.clock.runFor(500);
        await expect(region).toBeFocused();
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(4);
        // Deliver the final native-scroll notification before releasing history.
        await region.evaluate((node) =>
          node.dispatchEvent(new Event("scroll")),
        );
      }
      release();
      await expect(region.locator("[data-message-id]")).toHaveCount(123);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      if (reading) {
        await expect
          .poll(() =>
            region.evaluate((node, anchor) => {
              const row = node.querySelector(
                `[data-message-id="${anchor.id}"]`,
              );
              // scrollTop uses whole pixels here; row layout retains fractions.
              return Math.abs(
                row.getBoundingClientRect().top -
                  node.getBoundingClientRect().top -
                  anchor.offset,
              );
            }, anchor),
          )
          .toBeLessThan(1);
        position = await region.evaluate((node) => node.scrollTop);
        const jumpToLatest = region.locator("button[data-jump-to-latest]");
        await expect(jumpToLatest).toHaveAccessibleName("Jump to latest");
      } else {
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(4);
        await expect(
          region.locator(`[data-message-id="${last.id}"]`),
        ).toBeInViewport();
        if (mode === "bottom")
          await expect(
            page.getByRole("tab", { name: "Thread", exact: true }),
          ).toBeFocused();
      }
      const live = app.reply(root.id);
      await expect(
        region.locator(`[data-message-id="${live.id}"]`),
      ).toBeVisible();
      if (reading) {
        expect(await region.evaluate((node) => node.scrollTop)).toBe(position);
        const jumpToLatest = region.locator("button[data-jump-to-latest]");
        await expect(jumpToLatest).toHaveAccessibleName("1 new message");
        await jumpToLatest.focus();
        await page.keyboard.press("Space");
        await expect(region).toBeFocused();
        await expect(
          region.locator(`[data-message-id="${live.id}"]`),
        ).toBeInViewport();
        await expect(jumpToLatest).toHaveCount(1);
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("inert", "");
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("aria-hidden", "true");
        await expect(region.getByRole("button").and(jumpToLatest)).toHaveCount(
          0,
        );
        await expect(jumpToLatest).toBeHidden();
        await region.hover();
        await wheel(page, -500, region);
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeGreaterThan(80);
        const nextLive = app.reply(root.id);
        await expect(jumpToLatest).toHaveAccessibleName("1 new message");
        await jumpToLatest.focus();
        await page.keyboard.press("Enter");
        await expect(region).toBeFocused();
        await expect(
          region.locator(`[data-message-id="${nextLive.id}"]`),
        ).toBeInViewport();
        await expect(jumpToLatest).toHaveCount(1);
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("inert", "");
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("aria-hidden", "true");
        await expect(region.getByRole("button").and(jumpToLatest)).toHaveCount(
          0,
        );
        await expect(jumpToLatest).toBeHidden();
      } else {
        await expect(
          region.locator(`[data-message-id="${live.id}"]`),
        ).toBeInViewport();
      }
      if (mode === "jump") {
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(4);
        await page.clock.runFor(500);
      }
      // Expansion changes visibility, not the loaded-history count.
      await region.getByRole("button", { name: /^View 1 reply/ }).click();
      await expect(
        region.getByText("Broadcast descendant", { exact: true }),
      ).toBeInViewport();
      await expect(region.locator("[data-message-id]")).toHaveCount(
        reading ? 126 : 125,
      );
    } finally {
      release();
      try {
        // Let the held handler finish before unroute changes interception.
        await heldContinuation;
      } finally {
        await page.unroute(routePattern, holdHistory);
      }
    }
  });
}
