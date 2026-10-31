import { test as appTest } from "./fixture.mjs";
import { expect } from "./playwright-test.mjs";
import {
  anchor,
  expectAnchor,
  keyScroll,
  open,
  settle,
  upper,
  wheel,
} from "./timeline.mjs";
import {
  holdReadingFocus,
  readJournal,
  releaseReadingFocus,
} from "./reading.mjs";

appTest.use({
  productionBroker: true,
  readState: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 1 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const separator = (page) =>
  history(page).locator("[data-new-messages-boundary]");
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
const messageAfter = (element) =>
  element.evaluate((separator) => {
    let sibling = separator.nextElementSibling;
    while (sibling) {
      const row = sibling.matches("[data-message-id]")
        ? sibling
        : sibling.querySelector("[data-message-id]");
      if (row) return row.dataset.messageId;
      sibling = sibling.nextElementSibling;
    }
    return null;
  });

async function reachEdge(page, direction) {
  const scroller = history(page);
  const distance = () =>
    scroller.evaluate(
      (element, direction) =>
        direction < 0
          ? element.scrollTop
          : element.scrollHeight - element.scrollTop - element.clientHeight,
      direction,
    );
  await scroller.hover();
  for (let gesture = 0; gesture < 8; gesture++) {
    const before = await distance();
    if (before < 4) break;
    await wheel(page, direction * before, scroller);
    await expect
      .poll(distance, { message: "wheel progresses toward timeline edge" })
      .toBeLessThan(before);
  }
  expect(await distance(), "timeline reaches the requested edge").toBeLessThan(
    4,
  );
}

async function scrollBoundaryIntoView(page) {
  const scroller = history(page);
  await scroller.hover();
  const offset = await scroller.evaluate((element) => {
    const boundary = element.querySelector("[data-new-messages-boundary]");
    return (
      boundary.getBoundingClientRect().top - element.getBoundingClientRect().top
    );
  });
  const delta = offset - 32;
  if (Math.abs(delta) > 4) await wheel(page, delta, scroller);
  await expect(separator(page)).toBeInViewport();
  await settle(page);
}

appTest(
  "keeps the first unread boundary stable through reading and live appends",
  async ({ page, app }, testInfo) => {
    await holdReadingFocus(page);
    let releaseSnapshot;
    const snapshotGate = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshotRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/query") &&
        request
          .postDataJSON()
          .some((filter) => filter.read_state_snapshot === 1),
    );
    await page.route("**/query", async (route) => {
      if (
        route
          .request()
          .postDataJSON()
          .some((filter) => filter.read_state_snapshot === 1)
      )
        await snapshotGate;
      await route.continue();
    });
    try {
      await open(page, app);
      await snapshotRequest;
      expect(
        await page.evaluate(
          () =>
            window.fixtureRelay.snapshot().session.unread.sync().completeness,
        ),
      ).toBe("unknown");
      await expect(separator(page)).toHaveCount(0);

      await reachEdge(page, -1);
      await wheel(page, 8);
      await settle(page);
      expect(
        await history(page).evaluate((element) => element.scrollTop),
        "reader has scrolled without leaving the first row",
      ).toBeGreaterThan(0);
      const beforeBoundaryAnchor = await anchor(page);
      const boundaryId = app.histories.get("primary/alpha")[0].id;
      expect(beforeBoundaryAnchor.id).toBe(boundaryId);
      const beforeBoundaryBubble = await history(page)
        .locator(`[data-message-id="${boundaryId}"] [data-bubble]`)
        .boundingBox();
      expect(beforeBoundaryBubble).not.toBeNull();
      await expect(separator(page)).toHaveCount(0);
      await page.mouse.move(0, 0);
      const beforePath = testInfo.outputPath("boundary-before.png");
      await history(page).screenshot({ path: beforePath });
      await testInfo.attach("boundary-before.png", {
        path: beforePath,
        contentType: "image/png",
      });

      releaseSnapshot();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.fixtureRelay.snapshot().session.unread.sync().completeness,
          ),
        )
        .toBe("snapshot");
      await expect(separator(page)).toBeVisible();
      const entryLabelBounds = await separator(page).boundingBox();
      const entryHistoryBounds = await history(page).boundingBox();
      expect(entryLabelBounds).not.toBeNull();
      expect(entryHistoryBounds).not.toBeNull();
      expect(entryLabelBounds.y).toBeGreaterThanOrEqual(entryHistoryBounds.y);
      const boundaryRow = history(page).locator(
        `[data-message-id="${boundaryId}"] [data-layout="timeline"]`,
      );
      await expect(boundaryRow).toHaveCount(1);
      await expect(
        boundaryRow.locator("xpath=..").locator("[data-day]"),
      ).toHaveCount(1);
      await expect(boundaryRow).toHaveAttribute("data-stack-next", "true");
      const boundaryPath = testInfo.outputPath("t001-boundary.png");
      await history(page).screenshot({ path: boundaryPath });
      await testInfo.attach("t001-boundary.png", {
        path: boundaryPath,
        contentType: "image/png",
      });
      expect(entryLabelBounds.y).toBeCloseTo(entryHistoryBounds.y, 0);
      const entryMessageBounds = await history(page)
        .locator(`[data-message-id="${boundaryId}"] [data-bubble]`)
        .boundingBox();
      expect(entryMessageBounds).not.toBeNull();
      expect(entryMessageBounds.y).toBeGreaterThan(beforeBoundaryBubble.y);
      expect(entryMessageBounds.y - beforeBoundaryBubble.y).toBeLessThan(64);
      expect(await messageAfter(separator(page))).toBe(boundaryId);

      const base = Date.now();
      await page.clock.install({ time: base });
      await page.clock.pauseAt(base + 20_000);
      await releaseReadingFocus(page);
      await composer(page).focus();
      await expect(composer(page)).toBeFocused();
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const { unread } = window.fixtureRelay.snapshot().session;
            return unread.attention("alpha", id).viewing;
          }, boundaryId),
        )
        .toBe(true);
      await page.clock.runFor(300);
      await expect
        .poll(async () =>
          Object.hasOwn(
            (await readJournal(page)).state.frontiers,
            `msg:${boundaryId}`,
          ),
        )
        .toBe(true);
      await expect(separator(page)).toHaveCount(1);
      expect(await messageAfter(separator(page))).toBe(boundaryId);

      await reachEdge(page, -1);
      await page.mouse.move(10, 10);
      await expect(
        history(page).getByRole("group", { name: "Message actions" }).first(),
      ).toHaveCSS("opacity", "0");
      const afterPath = testInfo.outputPath("boundary-after.png");
      await history(page).screenshot({ path: afterPath });
      await testInfo.attach("boundary-after.png", {
        path: afterPath,
        contentType: "image/png",
      });

      const targetId = await messageAfter(separator(page));
      expect(targetId).toBe(boundaryId);
      const alphaSidebar = page.getByRole("button", { name: /^Alpha/ });
      await alphaSidebar.focus();
      await expect(alphaSidebar).toBeFocused();
      await composer(page).focus();
      await expect(composer(page)).toBeFocused();
      await page.clock.runFor(300);
      await expect
        .poll(async () =>
          Object.hasOwn(
            (await readJournal(page)).state.frontiers,
            `msg:${boundaryId}`,
          ),
        )
        .toBe(true);
      await expect(separator(page)).toHaveCount(1);
      expect(await messageAfter(separator(page))).toBe(boundaryId);
      await page.clock.resume();

      await page.getByRole("button", { name: /^Beta/ }).click();
      await expect(
        page.getByRole("textbox", { name: "Message #Beta", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: /^Alpha/ }).click();
      await expect(composer(page)).toBeVisible();
      await expect(separator(page)).toBeVisible();
      const revisitBoundaryId = await page.evaluate(
        (ids) => {
          const { unread } = window.fixtureRelay.snapshot().session;
          return ids.find((id) => {
            const attention = unread.attention("alpha", id);
            return (
              attention.status !== "unknown" &&
              !attention.pending &&
              (attention.forced || attention.unread)
            );
          });
        },
        app.histories.get("primary/alpha").map((row) => row.id),
      );
      expect(revisitBoundaryId).toBeTruthy();
      const revisitBoundary = history(page).locator(
        `[data-message-id="${revisitBoundaryId}"] [data-layout="timeline"]`,
      );
      await expect(revisitBoundary).toHaveAttribute(
        "data-stack-previous",
        "true",
      );
      const actualBoundaryId = await messageAfter(separator(page));
      const actualBoundaryIndex = app.histories
        .get("primary/alpha")
        .findIndex((row) => row.id === actualBoundaryId);
      expect(actualBoundaryId).toBe(revisitBoundaryId);
      expect(actualBoundaryIndex).toBeGreaterThan(0);
      await scrollBoundaryIntoView(page);
      await page.mouse.move(0, 0);
      await expect(separator(page)).toBeVisible();
      const labelBounds = await separator(page)
        .getByText("New messages", { exact: true })
        .boundingBox();
      const wideHistoryBounds = await history(page).boundingBox();
      const messageBounds = await history(page)
        .locator(`[data-message-id="${revisitBoundaryId}"] [data-bubble]`)
        .boundingBox();
      expect(labelBounds).not.toBeNull();
      expect(wideHistoryBounds).not.toBeNull();
      expect(messageBounds).not.toBeNull();
      expect(labelBounds.y).toBeGreaterThanOrEqual(wideHistoryBounds.y);
      expect(labelBounds.y + labelBounds.height).toBeLessThanOrEqual(
        wideHistoryBounds.y + wideHistoryBounds.height,
      );
      expect(
        labelBounds.y + labelBounds.height,
        "the boundary label clears the first unread message bubble",
      ).toBeLessThanOrEqual(messageBounds.y);
      const revisitPath = testInfo.outputPath("boundary-revisit-grouped.png");
      await history(page).screenshot({ path: revisitPath });
      await testInfo.attach("boundary-revisit-grouped.png", {
        path: revisitPath,
        contentType: "image/png",
      });

      await reachEdge(page, 1);
      await upper(page);
      const heldAnchor = await anchor(page);
      const live = app.append(
        "primary",
        "alpha",
        "Synthetic live follow-up",
        true,
        false,
      );
      await expectAnchor(page, heldAnchor);

      await reachEdge(page, 1);
      await expect(
        history(page).locator(`[data-message-id="${live.id}"]`),
      ).toBeVisible();
      await reachEdge(page, -1);
      expect(await messageAfter(separator(page))).toBe(revisitBoundaryId);

      await page.evaluate(() => {
        document.documentElement.dataset.colorMode = "dark";
        document.documentElement.dataset.fontSize = "larger";
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await settle(page);
      await scrollBoundaryIntoView(page);
      await page.mouse.move(0, 0);
      await expect(separator(page)).toBeVisible();
      await expect(separator(page)).toHaveText("New messages");
      const bounds = await separator(page).boundingBox();
      const viewport = await history(page).boundingBox();
      const narrowBubble = await history(page)
        .locator(`[data-message-id="${revisitBoundaryId}"] [data-bubble]`)
        .boundingBox();
      expect(bounds).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(narrowBubble).not.toBeNull();
      expect(bounds.x).toBeGreaterThanOrEqual(viewport.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        viewport.x + viewport.width,
      );
      expect(bounds.y).toBeGreaterThanOrEqual(viewport.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(narrowBubble.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        viewport.y + viewport.height,
      );
      const narrowPath = testInfo.outputPath("boundary-narrow-dark.png");
      await history(page).screenshot({ path: narrowPath });
      await testInfo.attach("boundary-narrow-dark.png", {
        path: narrowPath,
        contentType: "image/png",
      });

      await page.evaluate(() => {
        document.documentElement.dataset.colorMode = "light";
        delete document.documentElement.dataset.fontSize;
      });
      await page.setViewportSize({ width: 1280, height: 850 });
      await settle(page);
      await history(page).focus();
      const beforeKeyScroll = await history(page).evaluate((element) =>
        Math.round(element.scrollTop),
      );
      await keyScroll(page, "PageDown");
      await expect
        .poll(() =>
          history(page).evaluate((element) => Math.round(element.scrollTop)),
        )
        .toBeGreaterThan(beforeKeyScroll);
      await expect(separator(page)).toHaveCount(1);
    } finally {
      releaseSnapshot();
    }
  },
);
