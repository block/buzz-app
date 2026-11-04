import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Geometry and paint: a DOM emulator cannot show which side a row sits on or
// whether its bubble is filled.
const bubble = (page, text) =>
  page
    .locator("[data-highlight-surface]")
    .filter({ hasText: text })
    .locator('[class*="messageBubble"]')
    .first();
const box = (locator) =>
  locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      fill: getComputedStyle(element).backgroundColor,
    };
  });
const unfilled = "rgba(0, 0, 0, 0)";

async function open(page, name, text) {
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) })
    .click();
  await expect(bubble(page, text)).toBeVisible();
}

test("bubbles stay only with agents when chosen", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() =>
    localStorage.setItem("buzz-message-style.v1", "agents"),
  );
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/tests/fixtures/message-bubbles.html");

  await open(page, "Team", "Please do.");
  const mine = await box(bubble(page, "Please do."));
  const theirs = await box(bubble(page, "Anyone looked"));
  const bots = await box(bubble(page, "I can summarize"));
  expect(mine.left).toBe(theirs.left);
  expect(bots.left).toBe(theirs.left);
  for (const row of [mine, theirs, bots]) expect(row.fill).toBe(unfilled);
  // A run's avatar sits on its first row, and long text uses the row's width.
  const run = page
    .locator("[data-highlight-surface]")
    .filter({ hasText: "They cover the changelog" });
  await expect(
    page
      .locator("[data-highlight-surface]")
      .filter({ hasText: "Anyone looked" })
      .locator('[class*="messageAvatar"]'),
  ).toHaveCount(1);
  await expect(run.locator('[class*="messageAvatar"]')).toHaveCount(0);
  const long = await box(bubble(page, "They cover the changelog"));
  const row = await run.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.round(rect.right);
  });
  expect(row - long.right).toBeLessThan(8);
  // Wide code and tables start at the text column, stay inside the row and
  // scroll there.
  for (const content of ["pre", "table"]) {
    const surface = page
      .locator("[data-highlight-surface]")
      .filter({ has: page.locator(content) })
      .first();
    const edges = await surface.evaluate((element, content) => {
      const box = (node) => node.getBoundingClientRect();
      return {
        row: Math.round(box(element).right),
        bubble: Math.round(
          box(element.querySelector('[class*="messageBubble"]')).right,
        ),
        start: Math.round(box(element.querySelector(content)).left),
        byline: Math.round(box(element.querySelector("strong")).left),
      };
    }, content);
    expect(edges.bubble).toBeLessThanOrEqual(edges.row);
    expect(Math.abs(edges.start - edges.byline)).toBeLessThan(2);
  }
  // Revealing a row's actions washes the row, not its code. This read-only
  // fixture has no actions, so mark rows as the floating action bar does.
  const codeFills = () =>
    page.evaluate(() =>
      ["pre code", ":not(pre) > code"].map(
        (selector) =>
          getComputedStyle(document.querySelector(`[data-unboxed] ${selector}`))
            .backgroundColor,
      ),
    );
  const resting = await codeFills();
  await page.evaluate(() => {
    for (const row of document.querySelectorAll("[data-unboxed]"))
      row.setAttribute("data-actions-revealed", "");
  });
  expect(await codeFills()).toEqual(resting);

  await open(page, "Bot chat", "Here is a first draft.");
  const asked = await box(bubble(page, "Draft a reply"));
  const answered = await box(bubble(page, "Here is a first draft."));
  expect(asked.left).toBeGreaterThan(answered.right);
  expect(asked.fill).not.toBe(unfilled);
  expect(answered.fill).not.toBe(unfilled);
  expect(errors.unexplained()).toEqual([]);
});

test("bubbles stay everywhere by default", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/tests/fixtures/message-bubbles.html");
  await open(page, "Team", "Please do.");
  const mine = await box(bubble(page, "Please do."));
  const theirs = await box(bubble(page, "Anyone looked"));
  expect(mine.left).toBeGreaterThan(theirs.right);
  expect(theirs.fill).not.toBe(unfilled);
  expect(errors.unexplained()).toEqual([]);
});

test("keeping your color keeps your bubble in a list without moving it", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("buzz-message-style.v1", "agents");
    localStorage.setItem("buzz-message-own-color.v1", "on");
  });
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/tests/fixtures/message-bubbles.html");
  await open(page, "Team", "Please do.");
  const mine = await box(bubble(page, "Please do."));
  const theirs = await box(bubble(page, "Anyone looked"));
  expect(mine.left).toBe(theirs.left);
  expect(mine.fill).not.toBe(unfilled);
  expect(theirs.fill).toBe(unfilled);
  // Your bubble takes its own hover; the row wash would only show around it.
  const own = page
    .locator("[data-highlight-surface]")
    .filter({ hasText: "Please do." });
  await own.evaluate((element) =>
    element.setAttribute("data-actions-revealed", ""),
  );
  expect(
    await own.evaluate(
      (element) => getComputedStyle(element, "::after").backgroundColor,
    ),
  ).toBe(unfilled);
  expect((await box(bubble(page, "Please do."))).fill).not.toBe(mine.fill);
  expect(errors.unexplained()).toEqual([]);
});

test("an agent thread keeps bubbles beside a list timeline for the visit", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() =>
    localStorage.setItem("buzz-message-style.v1", "agents"),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/fixtures/message-bubbles.html");
  await open(page, "Team", "Can you draft the changelog?");
  const timelineRoot = page
    .locator("[data-channel-timeline] [data-highlight-surface]")
    .filter({ hasText: "Can you draft the changelog?" });
  await expect(timelineRoot).toHaveAttribute("data-unboxed");
  const openThread = () =>
    page
      .locator("[data-channel-timeline] [data-message-id]")
      .filter({ hasText: "Can you draft the changelog?" })
      .getByRole("button", { name: /^View thread:/ })
      .click();
  await openThread();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const threadRoot = thread
    .locator("[data-highlight-surface]")
    .filter({ hasText: "Can you draft the changelog?" });
  await expect(threadRoot).toHaveAttribute("data-viewer-message");
  await expect(timelineRoot).toHaveAttribute("data-unboxed");

  // A person's reply never reflows the open thread; the next visit lists it.
  await page.evaluate(() =>
    window.bubblesFixture.reply("member", "I'd add the migration note too."),
  );
  await expect(
    thread
      .locator("[data-highlight-surface]")
      .filter({ hasText: "migration note too" }),
  ).toBeVisible();
  await expect(threadRoot).toHaveAttribute("data-viewer-message");
  await page
    .getByRole("button", { name: /^Close Can you draft the changelog/ })
    .click();
  await expect(thread).toHaveCount(0);
  await openThread();
  await expect(threadRoot).toHaveAttribute("data-unboxed");
  expect(errors.unexplained()).toEqual([]);
});
