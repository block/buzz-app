import { test, expect } from "./fixture.mjs";
import { anchor, expectAnchor, open, settle, wheel } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 20 },
  viewport: { width: 1200, height: 650 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const thread = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });
const gap = (region) =>
  region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const reselect = (page) =>
  page.getByRole("button", { name: "Reselect transcript" }).click();
const jump = (page) =>
  page.getByRole("button", { name: "Jump retained transcript" });

async function select(page, params) {
  expect(
    await page.evaluate(
      (params) =>
        window.fixtureNavigation.open({
          version: 1,
          kind: "page",
          pluginId: "fixture.session",
          pageId: "reader",
          route: { version: 1, params },
        }),
      params,
    ),
  ).toEqual({ status: "opened" });
}

async function expectBottom(page, region) {
  await expect.poll(() => gap(region)).toBeLessThan(4);
  await settle(page, region);
  expect(await gap(region)).toBeLessThan(4);
}

async function readEarlier(page, region) {
  await region.hover();
  // Linux WebKit can finish a wheel gesture short of the requested distance.
  let distance = await gap(region);
  for (let gesture = 0; gesture < 4; gesture++) {
    await wheel(page, -450, region);
    const next = await gap(region);
    expect(next, "reading gesture moves away from bottom").toBeGreaterThan(
      distance,
    );
    if (next > 200) return;
    distance = next;
  }
  expect(distance, "reading position is above bottom").toBeGreaterThan(200);
}

async function openReplyTab(app, region) {
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  await region
    .locator(`[data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  return root.content;
}

test("a workspace opens at the end on selection and reselect, and restores reading on Back and Forward", async ({
  page,
  app,
}) => {
  const region = history(page);
  await open(page, app);
  await readEarlier(page, region);

  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  await reselect(page);
  await expectBottom(page, region);

  const replyTab = await openReplyTab(app, region);
  const side = page.locator("[data-panel-workspace]");
  const main = page.getByRole("tablist", { name: "Transcript fixture tabs" });
  await side.getByRole("tab", { name: replyTab }).press("Alt+Shift+ArrowLeft");
  const moved = main.getByRole("tab", { name: replyTab });
  await expect(moved).toHaveAttribute("aria-selected", "true");
  await reselect(page);
  await expect(
    main.getByRole("tab", { name: "Transcript fixture" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(moved).toBeVisible();
  await expectBottom(page, region);

  await readEarlier(page, region);
  const alpha = await anchor(page);

  await select(page, { channelId: "beta" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  const beta = await anchor(page);

  await page.goBack();
  await expectAnchor(page, alpha);
  await page.goForward();
  await expectAnchor(page, beta);
});

test("reselect uncovers the transcript and keeps the narrow reply dock available", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.setViewportSize({ width: 900, height: 650 });
  const region = history(page);
  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);

  const replyTab = await openReplyTab(app, region);
  const side = page
    .locator("[data-panel-workspace]")
    .getByRole("tab", { name: replyTab });
  await expect(side).toBeVisible();
  await expect(region).toHaveCount(0);

  await side.focus();
  await expect(side).toBeFocused();
  // A plugin command can issue a request without taking focus from the dock.
  await jump(page).evaluate((button) => button.click());
  await expectBottom(page, region);
  const toggle = page.getByRole("button", { name: "Toggle tab pane" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(side).toBeVisible();
});

test("a gesture retires a queued latest request before new messages arrive", async ({
  page,
  app,
}) => {
  const region = history(page);
  await open(page, app);
  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);
  await readEarlier(page, region);

  const scroller = await region.elementHandle();
  // The fixture click commits the request synchronously. Send the input in
  // the same browser task, before the timeline's deferred scroll can run.
  await jump(page).evaluate((button, element) => {
    button.click();
    element.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
    );
  }, scroller);
  await settle(page, region);
  const reading = await anchor(page);
  expect(await gap(region)).toBeGreaterThan(200);

  app.append("primary", "alpha", "A message arrived while reading");
  await expect(
    region.getByRole("button", { name: "1 new message" }),
  ).toBeVisible();
  await settle(page, region);
  await expectAnchor(page, reading);
  expect(await gap(region)).toBeGreaterThan(200);
});

test.describe("thread workspace", () => {
  test.use({ exactMessages: true });

  test("reselect moves the retained reader to the end and an explicit reply still wins", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = thread(page);
    const target = { channelId: "alpha", threadId: app.exact.root.id };
    await select(page, target);
    await expectBottom(page, region);
    await readEarlier(page, region);
    await jump(page).click();
    await expectBottom(page, region);
    await readEarlier(page, region);

    const messageId = app.exact.replies.at(-20).id;
    await select(page, { ...target, messageId });
    await expect(
      region.locator(`[data-message-id="${messageId}"]`),
    ).toBeInViewport();
    await settle(page, region);
    expect(await gap(region)).toBeGreaterThan(200);
  });
});

test.describe("trailing content", () => {
  // Rows above the card, the card and its controls, in viewport pixels. The
  // trailing content's top includes the card's own margin.
  const place = (region) =>
    region.evaluate((element) => {
      const card = element.querySelector('[aria-label="Fixture card"]');
      const content = card.parentElement;
      const extra = -Number.parseFloat(content.style.bottom || "0");
      const maxTop = element.scrollHeight - element.clientHeight;
      const bounds = element.getBoundingClientRect();
      const rows = element.querySelectorAll("[data-message-id]");
      return {
        extra,
        maxTop,
        scrollTop: element.scrollTop,
        past: element.scrollTop - Math.max(0, maxTop - extra),
        cardTop: content.getBoundingClientRect().top - bounds.top,
        // From the latest mounted row's bottom down to the content's top.
        latestGap:
          content.getBoundingClientRect().top -
          (rows[rows.length - 1]?.getBoundingClientRect().bottom ?? 0),
        footerBottom: card.querySelector("footer").getBoundingClientRect()
          .bottom,
        historyBottom: bounds.bottom,
        composerTop: document
          .querySelector('[role="textbox"]')
          .getBoundingClientRect().top,
      };
    });
  const toggle = (region) =>
    region.getByRole("article", { name: "Fixture card" }).getByRole("button", {
      name: /brief/,
    });

  test("rests below the latest message and keeps the reader's place as it grows", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(region)).toHaveText("Full brief");
    await settle(page, region);
    const rest = await place(region);
    expect(Math.abs(rest.past)).toBeLessThanOrEqual(1);
    expect(rest.extra).toBeGreaterThan(1000);
    // The latest message sits above the card; its controls end the history.
    expect(rest.latestGap).toBeGreaterThanOrEqual(-1);
    expect(rest.footerBottom).toBeCloseTo(rest.historyBottom, 1);

    await region.hover();
    await wheel(page, 300, region);
    await settle(page, region);
    const growing = await place(region);
    expect(growing.past).toBeGreaterThan(100);
    expect(growing.past).toBeLessThan(growing.extra);
    await expect(toggle(region)).toHaveText("Hide brief");
    expect(growing.footerBottom).toBe(rest.footerBottom);
    expect(growing.composerTop).toBe(rest.composerTop);

    app.append(
      "primary",
      "alpha",
      "Arrived while reading the card",
      true,
      false,
    );
    await expect(
      region.getByRole("button", { name: "1 new message" }),
    ).toBeVisible();
    await settle(page, region);
    expect((await place(region)).past).toBeCloseTo(growing.past, 0);

    await page.setViewportSize({ width: 900, height: 560 });
    await settle(page, region);
    await page.setViewportSize({ width: 1200, height: 650 });
    await settle(page, region);
    expect((await place(region)).past).toBeCloseTo(growing.past, 0);

    await region.getByRole("button", { name: "1 new message" }).click();
    await expect
      .poll(async () => Math.abs((await place(region)).past))
      .toBeLessThanOrEqual(1);
    await settle(page, region);
    const latest = await place(region);
    expect(Math.abs(latest.past)).toBeLessThanOrEqual(1);
    await expect(
      region.getByText("Arrived while reading the card"),
    ).toBeInViewport();
    await expect(toggle(region)).toHaveText("Full brief");
  });

  test("a resize at rest keeps the reader at rest", async ({ page, app }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "short" });
    await expect(toggle(region)).toHaveText("Full brief");
    await settle(page, region);
    expect(Math.abs((await place(region)).past)).toBeLessThanOrEqual(1);
    // Rows rewrap both ways, and widening shortens the range under the reader.
    for (const width of [900, 1200]) {
      await page.setViewportSize({ width, height: 650 });
      await settle(page, region);
      const rest = await place(region);
      expect(
        Math.abs(rest.past),
        `at rest after resizing to ${width}`,
      ).toBeLessThanOrEqual(1);
      expect(rest.latestGap).toBeGreaterThanOrEqual(-1);
      await expect(toggle(region)).toHaveText("Full brief");
    }
  });

  test("a growing card keeps a follower's small scroll above the latest message", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(region)).toHaveText("Full brief");
    await settle(page, region);
    expect(Math.abs((await place(region)).past)).toBeLessThanOrEqual(1);
    // Within the follow threshold the reader still follows the latest message.
    await region.hover();
    await wheel(page, -40, region);
    await settle(page, region);
    const above = await place(region);
    expect(above.past).toBeLessThanOrEqual(-39);
    // The card grows below the fold: the latest message stays where it is,
    // so the follower's realignment keeps their scroll.
    await region
      .getByRole("article", { name: "Fixture card" })
      .evaluate((card) => {
        card.style.paddingBottom = "120px";
      });
    await expect
      .poll(async () => (await place(region)).extra)
      .toBeGreaterThan(above.extra);
    await settle(page, region);
    expect((await place(region)).past).toBeCloseTo(above.past, 0);
  });

  test("removing a grown card leaves no expanded state behind", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(region)).toHaveText("Full brief");
    await settle(page, region);
    await region.hover();
    await wheel(page, 300, region);
    await expect(toggle(region)).toHaveText("Hide brief");

    await region.getByRole("button", { name: "Approve" }).click();
    await expect(
      region.getByRole("article", { name: "Fixture card" }),
    ).toHaveCount(0);
    await settle(page, region);
    await readEarlier(page, region);
    await expect(
      region.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
  });

  test.describe(() => {
    // Without thread fixtures, the latest row is a top-level message.
    test.use({ threadUnread: false });

    test("a reveal of the latest message stops above the card", async ({
      page,
      app,
    }) => {
      await open(page, app);
      const region = history(page);
      await select(page, { channelId: "alpha", trailing: "long" });
      await expect(toggle(region)).toHaveText("Full brief");
      await settle(page, region);
      const messageId = await region.evaluate(
        (element) =>
          [...element.querySelectorAll("[data-message-id]")].at(-1).dataset
            .messageId,
      );
      await readEarlier(page, region);

      await select(page, { channelId: "alpha", trailing: "long", messageId });
      await expect(
        region.locator(`[data-message-id="${messageId}"]`),
      ).toBeInViewport();
      await settle(page, region);
      expect(Math.abs((await place(region)).past)).toBeLessThanOrEqual(1);
      await expect(toggle(region)).toHaveText("Full brief");
    });
  });

  for (const brief of ["long", "short"])
    test(`Full brief shows the ${brief} card's ${brief === "long" ? "top below 100px of history" : "end"}, and Hide brief returns`, async ({
      page,
      app,
    }) => {
      await open(page, app);
      const region = history(page);
      await select(page, { channelId: "alpha", trailing: brief });
      await expect(toggle(region)).toHaveText("Full brief");
      await settle(page, region);
      const rest = await place(region);
      expect(rest.extra).toBeGreaterThan(0);

      await toggle(region).press("Enter");
      await expect(toggle(region)).toHaveText("Hide brief");
      await expect(toggle(region)).toHaveAttribute("aria-expanded", "true");
      await settle(page, region);
      const shown = await place(region);
      if (brief === "long") {
        // 100px of history stays above the card's top.
        expect(Math.abs(shown.cardTop - 100)).toBeLessThanOrEqual(1);
        expect(shown.scrollTop).toBeLessThan(shown.maxTop);
      } else expect(shown.scrollTop).toBe(shown.maxTop);
      expect(shown.footerBottom).toBe(rest.footerBottom);
      expect(shown.composerTop).toBe(rest.composerTop);

      await toggle(region).press("Enter");
      await expect(toggle(region)).toHaveText("Full brief");
      await settle(page, region);
      expect(Math.abs((await place(region)).past)).toBeLessThanOrEqual(1);
    });

  test("the toggle jumps without animation under reduced motion", async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(region)).toHaveText("Full brief");
    await settle(page, region);
    // Read in the same task as the click: an instant scroll has landed.
    const landed = await region.evaluate((element) => {
      element
        .querySelector('[aria-label="Fixture card"] button[aria-expanded]')
        .click();
      const content = element.querySelector(
        '[aria-label="Fixture card"]',
      ).parentElement;
      return (
        content.getBoundingClientRect().top -
        element.getBoundingClientRect().top
      );
    });
    expect(Math.abs(landed - 100)).toBeLessThanOrEqual(1);
  });

  test("a short history narrows the gap above the card to a third of it", async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1200, height: 460 });
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(region)).toHaveText("Full brief");
    await settle(page, region);
    const view = await region.evaluate((element) => element.clientHeight);
    expect(view).toBeLessThan(300);
    await toggle(region).click();
    await expect(toggle(region)).toHaveText("Hide brief");
    expect(
      Math.abs((await place(region)).cardTop - view / 3),
    ).toBeLessThanOrEqual(1);
  });
});
