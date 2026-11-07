import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { anchor, expectAnchor, settle, wheel, edge } from "./timeline.mjs";

// Real layout/virtualizer measurements are needed: history is inserted after
// a retained opening row, and the identified reader must keep its viewport Y.
let server;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});

async function open(page) {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/history-prefix.html`,
  );
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  await settle(page);
}
async function prepend(page, start) {
  await page.evaluate(() => window.prependHistory());
  await expect(page.locator("[data-history-start]")).toHaveAttribute(
    "data-history-start",
    String(start),
  );
  await settle(page);
}

test("older pages behind a retained first row preserve reading and are not new arrivals", async ({
  page,
}) => {
  await open(page);
  await page.locator("[data-message-scroller]").hover();
  await wheel(page, -300);
  const reading = await anchor(page);
  for (const start of [61, 41, 21]) {
    await prepend(page, start);
    await expectAnchor(page, reading);
    await expect(
      page.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
  }
  // A reader on the unchanged prefix must not be shifted past newly added rows.
  await edge(page, -1);
  const opening = await anchor(page);
  await prepend(page, 1);
  await expectAnchor(page, opening);
});

test("older pages behind a retained first row preserve bottom following", async ({
  page,
}) => {
  await open(page);
  const reading = await anchor(page);
  await prepend(page, 61);
  await expectAnchor(page, reading);
  await expect
    .poll(() =>
      page
        .locator("[data-message-scroller]")
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(2);
});

// Both ends change in one commit at the cap. Real Virtua/browser geometry must
// preserve a reader when rows disappear from the opposite end of the window.
test("a bounded history window reloads newer rows without skipping the reader", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/history-prefix.html?sliding`,
  );
  const snapshot = page.locator("[data-oldest]");
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(snapshot).toHaveAttribute("data-newest", "1700000139");
  for (let step = 0; step < 6; step++) {
    await page.evaluate(() => window.loadSlidingOlder());
    await expect(snapshot).toHaveAttribute("data-loading", "false");
  }
  await expect(snapshot).toHaveAttribute("data-oldest", "1700000000");
  await expect(snapshot).toHaveAttribute("data-count", "60");
  await settle(page);
  const column = await history.locator(":scope > ol").boundingBox();
  const newer = await page
    .getByRole("button", { name: "Load newer messages", exact: true })
    .boundingBox();
  expect(column).not.toBeNull();
  expect(newer).not.toBeNull();
  expect(
    Math.abs(newer.x + newer.width / 2 - column.x - column.width / 2),
  ).toBeLessThan(4);
  await history.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 1200;
  });
  await settle(page);
  await page.evaluate(() => window.holdSlidingPage());
  try {
    await history.hover();
    await wheel(page, 600);
    await expect(snapshot).toHaveAttribute("data-loading", "true");
    const reading = await anchor(page);
    await page.evaluate(() => window.releaseSlidingPage());
    await expect(snapshot).toHaveAttribute("data-loading", "false");
    await expectAnchor(page, reading);
    await expect(snapshot).toHaveAttribute("data-count", "60");
    await expect(
      page.getByText("History window limit reached", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Jump to latest", exact: true })
      .click();
    await expect(snapshot).toHaveAttribute("data-newest", "1700000139");
    await expect(
      page.getByRole("button", { name: "Load newer messages", exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.releaseSlidingPage());
  }
});

test("older sliding pages preserve the visible paragraph while evicting the tail", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/history-prefix.html?sliding`,
  );
  const snapshot = page.locator("[data-oldest]");
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(snapshot).toHaveAttribute("data-newest", "1700000139");
  for (let step = 0; step < 2; step++) {
    await page.evaluate(() => window.loadSlidingOlder());
    await expect(snapshot).toHaveAttribute("data-loading", "false");
  }
  await expect(snapshot).toHaveAttribute("data-count", "60");
  await page.evaluate(() => window.holdSlidingPage());
  try {
    await history.hover();
    await wheel(page, -300);
    await history.evaluate((element) => {
      element.scrollTop = 100;
    });
    await settle(page);
    await page.evaluate(() => window.loadSlidingOlder());
    await expect(snapshot).toHaveAttribute("data-loading", "true");
    const reading = await anchor(page);
    const paragraph = page
      .locator(`[data-message-id="${reading.id}"] p`)
      .first();
    const paragraphY = (await paragraph.boundingBox()).y;
    for (const oldest of [60, 40]) {
      await page.evaluate(() => window.releaseSlidingPage(true));
      await expect(snapshot).toHaveAttribute(
        "data-oldest",
        String(1700000000 + oldest),
      );
      await expectAnchor(page, reading);
      await expect
        .poll(async () =>
          Math.abs((await paragraph.boundingBox()).y - paragraphY),
        )
        .toBeLessThan(4);
      await page.evaluate(() => window.loadSlidingOlder());
      await expect(snapshot).toHaveAttribute("data-loading", "true");
    }
  } finally {
    await page.evaluate(() => window.releaseSlidingPage());
  }
});

test("newer-page scroll correction does not request an older page", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/history-prefix.html?sliding&compact`,
  );
  const snapshot = page.locator("[data-oldest]");
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(snapshot).toHaveAttribute("data-newest", "1700000139");
  for (let step = 0; step < 6; step++) {
    await page.evaluate(() => window.loadSlidingOlder());
    await expect(snapshot).toHaveAttribute("data-loading", "false");
  }
  await expect(snapshot).toHaveAttribute("data-oldest", "1700000000");
  await history.hover();
  await wheel(page, -100);
  await history.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - 1000;
  });
  await settle(page);
  await page.evaluate(() => window.holdSlidingPage());
  try {
    await history.hover();
    await wheel(page, 600);
    await expect(snapshot).toHaveAttribute("data-loading", "true");
    await page.evaluate(() => window.releaseSlidingPage(true, 1700000059));
    await expect
      .poll(async () => Number(await snapshot.getAttribute("data-oldest")))
      .toBeGreaterThan(1700000000);
    await settle(page);
    await expect(snapshot).toHaveAttribute("data-loading", "false");
    expect(await page.evaluate(() => window.slidingHeldReads)).toBe(0);
  } finally {
    await page.evaluate(() => window.releaseSlidingPage());
  }
});

for (const compact of [false, true]) {
  test(`byte-bounded same-second history keeps advancing after handing off its anchor (compact: ${compact})`, async ({
    page,
  }) => {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/history-prefix.html?sliding&dense${compact ? "&compact" : ""}`,
    );
    const snapshot = page.locator("[data-oldest]");
    await expect(snapshot).toHaveAttribute("data-count", "60");
    const ids = () => snapshot.getAttribute("data-ids");
    const before = await ids();
    const seen = new Set(before.split(","));
    await settle(page);
    await page.evaluate(() => window.holdSlidingPage());
    if (!compact) {
      expect((await anchor(page)).id).toBe(
        await snapshot.getAttribute("data-anchor"),
      );
    }
    await edge(page, -1);
    await expect
      .poll(() => page.evaluate(() => window.slidingHeldReads))
      .toBe(1);
    if (!compact) {
      expect((await anchor(page)).id).toBe(
        await snapshot.getAttribute("data-anchor"),
      );
    }
    if (!compact) {
      expect(await page.evaluate(() => window.lastSlidingAnchor)).toBe(
        await snapshot.getAttribute("data-anchor"),
      );
    }
    await page.evaluate(() => window.releaseSlidingPage());
    await expect(snapshot).toHaveAttribute("data-loading", "false");
    await expect.poll(ids).not.toBe(before);
    for (const id of (await ids()).split(",")) seen.add(id);
    await expect(snapshot).toHaveAttribute("data-has-more", "false");
    expect(seen.size).toBe(80);
    for (
      let step = 0;
      (await snapshot.getAttribute("data-has-newer")) === "true" &&
      step < (compact ? 20 : 5);
      step++
    ) {
      const history = page.getByRole("region", {
        name: "Channel message history",
      });
      await history.hover();
      await page.mouse.wheel(
        0,
        await history.evaluate((element) => element.scrollHeight),
      );
      await settle(page);
      await expect(snapshot).toHaveAttribute("data-loading", "false");
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    await expect(snapshot).toHaveAttribute("data-has-newer", "false");
  });
}
