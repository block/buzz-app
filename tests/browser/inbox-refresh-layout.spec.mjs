import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real layout and header truncation cannot be inferred from jsdom. Hold the
// addressed refresh while ordinary unread catch-up completes so only the loading
// indicator (not the separate stale/error notices) can change row geometry.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const width of [1280, 280]) {
  test(`Inbox refresh status preserves layout at ${width}px`, async ({
    page,
    app,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(app.origin);
    await openPage(page, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    const status = inbox.getByText("Checking recent activity…", {
      exact: true,
    });
    const list = inbox.getByRole("list", { name: "Activity", exact: true });
    const rows = list.getByRole("listitem");
    const show = inbox.getByRole("tablist", { name: "Show", exact: true });
    await expect(rows).toHaveCount(3);
    await expect(status).toHaveCount(0);
    let gate;
    await page.route("**/api/relay/primary/query", async (route) => {
      const pending = gate;
      if (
        !pending ||
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter["#p"] && filter.kinds?.includes(9))
      )
        return route.continue();
      pending.started = true;
      await pending.promise;
      await route.continue();
    });
    // The list's toolbar, not the page's tab strip above it.
    const toolbar = inbox.locator("header").filter({
      has: page.getByRole("tablist", { name: "Show", exact: true }),
    });
    await expect(toolbar).toHaveCount(1);
    const geometry = () =>
      inbox.evaluate((element) => {
        const header = element
          .querySelector('header [role="tablist"][aria-label="Show"]')
          .closest("header");
        const box = (node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          rows: [
            ...element.querySelectorAll('[aria-label="Activity"] > li'),
          ].map((row) => ({ ...box(row), text: row.textContent })),
          header: box(header),
          show: box(
            element.querySelector('header [role="tablist"][aria-label="Show"]'),
          ),
          unread: box(element.querySelector('header [role="switch"]')),
          groups: box(
            element.querySelector(
              '[role="tablist"][aria-label="Activity groups"]',
            ),
          ),
        };
      });
    const measurements = [];
    await expect(show).toBeVisible();
    const before = await geometry();
    gate = { ...Promise.withResolvers(), started: false };
    try {
      app.relay.disconnect("primary");
      await expect.poll(() => gate.started).toBe(true);
      await expect(status).toBeVisible();
      await expect(inbox.getByText("Showing retained activity.")).toHaveCount(
        0,
      );
      await expect.poll(geometry).toEqual(before);
      await expect(
        toolbar.getByText("Checking recent activity…"),
      ).toBeVisible();
      const textStyle = await status.evaluate((element) => ({
        whiteSpace: getComputedStyle(element).whiteSpace,
        overflow: getComputedStyle(element).overflow,
        textOverflow: getComputedStyle(element).textOverflow,
        width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
      }));
      expect(textStyle).toMatchObject({
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      // The pane width that truncated beside the former 48px community rail.
      if (width === 280)
        expect(textStyle.scrollWidth).toBeGreaterThan(textStyle.width);
      const during = await geometry();
      measurements.push({ width, before, during, textStyle });
    } finally {
      gate.resolve();
      gate = undefined;
    }
    await expect(status).toHaveCount(0);
    await expect.poll(geometry).toEqual(before);
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    await expect(show.getByRole("tab", { selected: true })).toHaveAttribute(
      "title",
      "All",
    );
    await testInfo.attach("refresh-geometry", {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
  });
}

// Only a browser can prove that the sibling Mark as read control leaves readable
// label space when the host's interface size doubles at a narrow width.
test("narrow enlarged-text rows overlay Mark as read without erasing their labels", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await expect(list).toHaveAttribute("aria-busy", "false");
  const row = rows.first();
  const open = row.getByRole("button", { name: /^Open / });
  const check = row.getByRole("button", { name: /^Mark as read / });
  const geometry = () =>
    row.evaluate((element) => {
      const open = element.querySelector(".navigation-item");
      const label = open.querySelector(".navigation-item-label");
      const action = open.nextElementSibling;
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        row: box(element),
        open: box(open),
        label: box(label),
        action: box(action),
      };
    });
  const measured = await geometry();
  // NavigationItem truncates long labels at enlarged text sizes; this checks
  // that Mark as read reserves no additional inline space, not full visual acceptance.
  expect(measured.label.width).toBeGreaterThanOrEqual(2 * measured.root);
  expect(measured.open.x + measured.open.width).toBe(
    measured.row.x + measured.row.width,
  );
  expect(measured.action.y).toBeGreaterThanOrEqual(measured.open.y);
  expect(measured.action.y + measured.action.height).toBeLessThanOrEqual(
    measured.open.y + measured.open.height,
  );
  await open.focus();
  // Keyboard focus turns the unread dot into the ✓; the date stays.
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "1");
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCSS(
    "opacity",
    "0",
  );
  await expect(row.locator("[data-inbox-date]")).toHaveCSS("opacity", "1");
  await check.click();
  // With Unread off the row stays, read: its ✓ goes and its date remains.
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(check).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await expect(row.locator("[data-inbox-date]")).toHaveCSS("opacity", "1");
  // Row actions never open a conversation tab.
  await expect(
    inbox.getByRole("region", { name: /^Conversation in / }),
  ).toHaveCount(0);
  const show = inbox.getByRole("tablist", { name: "Show", exact: true });
  const unread = inbox.getByRole("switch", { name: "Unread", exact: true });
  await show.getByRole("tab", { name: "Mentions", exact: true }).click();
  await expect(
    show.getByRole("tab", { name: "Mentions", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // The quick filters stay on screen at the narrow width and doubled text size.
  for (const control of [show, unread])
    await expect
      .poll(() =>
        control.evaluate((element) => element.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(390);
});
