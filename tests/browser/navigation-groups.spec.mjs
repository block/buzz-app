import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true });

async function openMove(page, row) {
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const parent = page.getByRole("menuitem", {
    name: "Move channel",
    exact: true,
  });
  await expect(parent).toBeVisible();
  await parent.focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", { name: "Move channel", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}
const rowIn = (page, section) =>
  page.locator(`[data-sidebar-section="${section}"] [data-channel-id="beta"]`);
const sidebar = (page) =>
  page.getByRole("navigation", { name: "Subscribed channels" });
// No saving UI is a completion signal: wait for the final confirmed Star command
// of each move (including no-op Star writes), not merely relay publication.
const confirmations = new WeakMap();
test.beforeEach(async ({ page }) => {
  const state = { completed: 0, expected: 0 };
  confirmations.set(page, state);
  page.on("requestfinished", async (request) => {
    if (
      new URL(request.url()).pathname.endsWith("/sidebar-star") &&
      (await request.response())?.ok()
    )
      state.completed++;
  });
});
async function saved(page, app, publications, moves = 1) {
  const state = confirmations.get(page);
  state.expected += moves;
  await expect.poll(() => state.completed).toBe(state.expected);
  await expect
    .poll(() => app.report.sidebarPublications?.length ?? 0)
    .toBe(publications);
  await expect(
    page.getByText("Saving sidebar changes…", { exact: true }),
  ).toHaveCount(0);
}
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Browser-owned keyboard nesting, portal geometry, and exclusive row/focus relocation.
// Record ordering, concurrency, bounds and cancellation matrices stay in Vitest.
test("row menu moves and removes a channel optimistically, retaining keyboard navigation and confirmed reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await expect(beta).toBeVisible();
  await beta.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", { name: "Move channel", exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(
    menu.getByRole("menuitemradio", { name: "Work" }),
  ).toHaveAttribute("aria-checked", "true");
  // Checked state renders before Base UI transfers focus into the reopened
  // submenu. Establish keyboard ownership before sending its next command.
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Remove from Work" }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitemradio", { name: "Starred", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Work" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Create new…" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(beta).toHaveCount(0);
  await saved(page, app, 1);
  expect(app.report.sidebarPublications[0].blob.assignments).toEqual({});
  await openMove(page, rowIn(page, "channels"));
  await menu.getByRole("menuitemradio", { name: "Work" }).click();
  await expect(beta).toBeFocused();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await saved(page, app, 2);
  expect(app.report.sidebarPublications[1].blob.assignments).toEqual({
    beta: "work",
  });
  await page.reload();
  await expect(beta).toBeVisible();

  // Clicking the checked group is the same remove intent, including rollback.
  await openMove(page, beta);
  const selected = menu.getByRole("menuitemradio", {
    name: "Work",
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-checked", "true");
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarAssignmentFailures ??= [];
    app.report.sidebarAssignmentFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Group removal failed; retry" }),
    });
  });
  try {
    await selected.click();
    await expect(rowIn(page, "channels")).toBeFocused();
    await started.promise;
    await expect(menu).toHaveCount(0);
    await expect(beta).toHaveCount(0);
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(rowIn(page, "channels")).toHaveCount(0);
  await page.unroute("**/sidebar-assignment");
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(error).toHaveCount(0);
  await saved(page, app, 3);
  expect(app.report.sidebarPublications.at(-1).blob.assignments).toEqual({});
  await page.reload();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(beta).toHaveCount(0);
});

test("optimistic Star moves close the menu before the write, roll back with visible retry, and remove to Channels after reload", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const beta = rowIn(page, "group:work");
  const starred = rowIn(page, "starred");
  await expect(beta).toBeVisible();
  await page.locator('[data-sidebar-section="starred"] summary').click();
  const menu = await openMove(page, beta);
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("menu", { name: "Actions for Beta", exact: true }),
  ).toHaveCSS("opacity", "1");
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: testInfo.outputPath("move-channel-menu.png"),
    clip: { x: 10, y: 50, width: 470, height: 470 },
  });
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("menuitem", { name: "Move channel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await page.keyboard.press("ContextMenu");
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-star", async (route) => {
    started.resolve();
    await held.promise;
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  try {
    await menu
      .getByRole("menuitemradio", { name: "Starred", exact: true })
      .click();
    await started.promise;
    await expect(menu).toHaveCount(0);
    await expect(starred).toBeFocused();
    await expect(beta).toHaveCount(0);
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(beta).toBeVisible();
  await expect(starred).toHaveCount(0);
  await page.unroute("**/sidebar-star");
  // Failures live in the session, not in a menu or mounted Messages page.
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await error.getByRole("button", { name: "Retry move" }).click();
  await expect(starred).toBeFocused();
  await expect(error).toHaveCount(0);
  await saved(page, app, 1);
  await openMove(page, starred);
  await menu
    .getByRole("menuitem", { name: "Remove from Starred", exact: true })
    .click();
  await expect(rowIn(page, "channels")).toBeFocused();
  await saved(page, app, 3);
  expect(
    app.report.sidebarPublications.slice(1).map(({ coordinate }) => coordinate),
  ).toEqual(["channel-sections", "channel-stars"]);
  await page.reload();
  await expect(
    page.locator('[data-sidebar-section="starred"] [data-channel-id="alpha"]'),
  ).toBeVisible();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(beta).toHaveCount(0);
  await openMove(page, rowIn(page, "channels"));
  await menu
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(starred).toBeFocused();
  await saved(page, app, 4);
  await openMove(page, starred);
  await menu.getByRole("menuitemradio", { name: "Work", exact: true }).click();
  await expect(beta).toBeFocused();
  await saved(page, app, 6);
  expect(app.report.sidebarPublications.at(-2)).toMatchObject({
    coordinate: "channel-sections",
    blob: { assignments: { beta: "work" } },
  });
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: false } } },
  });
  await openMove(page, beta);
  await menu
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(starred).toBeFocused();
  await saved(page, app, 7);
  await openMove(page, starred);
  const selected = menu.getByRole("menuitemradio", {
    name: "Starred",
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-checked", "true");
  await selected.focus();
  await page.keyboard.press("Enter");
  await expect(rowIn(page, "channels")).toBeFocused();
  await expect(menu).toHaveCount(0);
  await expect(starred).toHaveCount(0);
  await saved(page, app, 9);
  expect(app.report.sidebarPublications.at(-2)).toMatchObject({
    coordinate: "channel-sections",
    blob: { assignments: {} },
  });
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { beta: { starred: false } } },
  });
  await page.reload();
  await expect(rowIn(page, "channels")).toBeVisible();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await expect(beta).toHaveCount(0); // Never restore the remembered Work assignment.
});

// Menu → native dialog → optimistic new-section focus must be checked in browsers.
test("Create new supports cancel, moves before publication, and retries the same section after partial failure", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const beta = rowIn(page, "group:work");
  await expect(beta).toBeVisible();
  await openMove(page, beta);
  await page.getByRole("menuitem", { name: "Create new…" }).click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(dialog.locator("p")).toHaveText("Move Beta into a new section.");
  await expect(dialog.locator("label")).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Create and move" }),
  ).toBeDisabled();
  await field.fill("Cancelled");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(beta).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await openMove(page, beta);
  await page
    .getByRole("menuitemradio", { name: "Starred", exact: true })
    .click();
  await expect(rowIn(page, "starred")).toBeFocused();
  await saved(page, app, 1);
  await openMove(page, rowIn(page, "starred"));
  await page.getByRole("menuitem", { name: "Create new…" }).click();
  await expect(field).toBeFocused();
  await field.fill("Launch");
  await dialog.screenshot({ path: testInfo.outputPath("create-section.png") });
  const held = gate(),
    started = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    started.resolve();
    await held.promise;
    await route.continue();
  });
  await page.route("**/sidebar-star", async (route) => {
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  let sectionId;
  try {
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await started.promise;
    await expect(dialog).toHaveCount(0);
    const createdGroup = sidebar(page)
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Launch$/ }) });
    await expect(
      createdGroup.locator('[data-channel-id="beta"]'),
    ).toBeFocused();
    sectionId = (await createdGroup.getAttribute("data-sidebar-section")).slice(
      "group:".length,
    );
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    expect(app.report.sidebarPublications).toHaveLength(1); // No section write yet.
    await expect(rowIn(page, "starred")).toHaveCount(0);
  } finally {
    held.resolve();
  }
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Couldn’t save the move for Beta" });
  await expect(error).toContainText("Relay request failed (502)");
  await expect(rowIn(page, "starred")).toBeVisible();
  await expect(rowIn(page, `group:${sectionId}`)).toHaveCount(0);
  await page.unroute("**/sidebar-star");
  await page.unroute("**/sidebar-assignment");
  await error.getByRole("button", { name: "Retry move" }).click();
  const destination = rowIn(page, `group:${sectionId}`);
  await expect(destination).toBeFocused();
  await saved(page, app, 3);
  expect(
    app.report.sidebarPublications.filter(
      ({ coordinate }) => coordinate === "channel-sections",
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(destination).toBeVisible();
  await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
    1,
  );
  await sidebar(page).screenshot({
    path: testInfo.outputPath("created-section-reloaded.png"),
  });

  // A saved-group row can create another group directly; while that save is
  // held, the moved row can immediately move again to a different saved group.
  const nextHeld = gate(),
    nextStarted = gate();
  await page.route("**/sidebar-assignment", async (route) => {
    nextStarted.resolve();
    await nextHeld.promise;
    await route.continue();
  });
  let followup;
  try {
    await openMove(page, destination);
    await page.getByRole("menuitem", { name: "Create new…" }).click();
    await field.fill("Follow-up");
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await nextStarted.promise;
    const nextGroup = sidebar(page)
      .locator("details")
      .filter({
        has: page.locator("summary", { hasText: /^Follow-up$/ }),
      });
    followup = rowIn(
      page,
      await nextGroup.getAttribute("data-sidebar-section"),
    );
    await expect(followup).toBeFocused();
    await expect(destination).toHaveCount(0);
    await expect(page.getByText(/Saving(?: sidebar changes)?…/)).toHaveCount(0);
    const moving = await openMove(page, followup);
    await moving
      .getByRole("menuitemradio", { name: "Work", exact: true })
      .click();
    await expect(beta).toBeFocused();
    await expect(followup).toHaveCount(0);
    await expect(sidebar(page).locator('[data-channel-id="beta"]')).toHaveCount(
      1,
    );
    expect(app.report.sidebarPublications).toHaveLength(3);
  } finally {
    nextHeld.resolve();
  }
  await saved(page, app, 5, 2);
  await page.unroute("**/sidebar-assignment");
  await page.reload();
  await expect(beta).toBeVisible();
  // Existing group → another existing group needs no intermediate removal.
  const moving = await openMove(page, beta);
  await moving
    .getByRole("menuitemradio", { name: "Follow-up", exact: true })
    .click();
  await expect(followup).toBeFocused();
  await saved(page, app, 6);
  await page.reload();
  await expect(followup).toBeVisible();
  await expect(beta).toHaveCount(0);
});

test.use({
  productionBroker: true,
  savedSidebar: true,
  largeSidebar: true,
  developmentReact: true,
  historyCounts: { alpha: 1, beta: 1 },
});
test("Home → Messages keeps saved groups, selected channel, and scroll on every visible frame without re-decoding", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  await expect(sidebar.locator("summary", { hasText: /^Work$/ })).toBeVisible();
  await expect(
    sidebar.locator("summary", { hasText: /Starred$/ }),
  ).toBeVisible();
  await sidebar.locator('button[data-channel-id="beta"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  const scroll = await sidebar.evaluate((element) => {
    element.scrollTop = 1000;
    return element.scrollTop;
  });
  expect(scroll).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await expect(sidebar).toHaveCount(0);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let decodes = 0;
  await page.route("**/sidebar-preferences", async (route) => {
    decodes++;
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    window.sidebarFrames = [];
    window.captureSidebar = true;
    const frame = () => {
      const list = document.querySelector(
        'nav[aria-label="Subscribed channels"]',
      );
      if (list)
        window.sidebarFrames.push({
          top: list.scrollTop,
          groups: Array.from(list.querySelectorAll("summary"), (el) =>
            el.textContent.replace("★", "").trim(),
          ),
        });
      if (window.captureSidebar) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  try {
    await page
      .getByRole("button", { name: "Messages", exact: true })
      .first()
      .click();
    await expect(sidebar).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(300); // Keep the decode path held for the full interval.
    // Wall time does not guarantee RAF callbacks on a busy runner. Wait for
    // samples, not correct samples: every earlier frame stays in the assertion.
    await page.waitForFunction(() => window.sidebarFrames.length > 3);
    const frames = await page.evaluate(() => {
      window.captureSidebar = false;
      return window.sidebarFrames;
    });
    expect(frames.length).toBeGreaterThan(3);
    expect(
      frames.filter(
        (frame) =>
          !frame.groups.includes("Work") ||
          !frame.groups.includes("Starred") ||
          Math.abs(frame.top - scroll) > 1,
      ),
      "No fallback grouping or top-of-list frame on warm return",
    ).toEqual([]);
    expect(
      decodes,
      "Remount must reuse the engine snapshot, not fetch/decode again",
    ).toBe(0);
  } finally {
    release();
    await page.unroute("**/sidebar-preferences");
  }
});
