import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 3, beta: 1 },
});

// Browser-only boundary: real composer -> signing broker -> live nested row;
// layout/focus at different panel widths, and routed reveal through collapsed DOM.
test("nested replies send, collapse, and reveal through links at readable panel widths", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const editor = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const parent = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  await editor.fill("Nested browser reply");
  await parent.hover();
  await parent.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(editor).toHaveText("Nested browser reply");
  let rejected;
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (!rejected && event.content === "Nested browser reply") {
      rejected = event;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: false,
          event_id: event.id,
          message: "Fixture rejection",
        }),
      });
    } else await route.continue();
  });
  await editor.press("Enter");
  const failed = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Nested browser reply" });
  await expect(
    failed.getByText("Couldn’t send this message.", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .poll(
      () =>
        app.report.publications.filter(
          ({ event }) => event?.content === "Nested browser reply",
        ).length,
    )
    .toBe(1);
  const nested = app.report.publications.find(
    ({ event }) => event?.content === "Nested browser reply",
  ).event;
  // Compare signed wire fields, not the verifier’s local symbol cache.
  expect(JSON.parse(JSON.stringify(nested))).toEqual(rejected);
  expect(nested.tags.filter(([key]) => key === "e")).toEqual([
    ["e", root.id, "", "root"],
    ["e", await parent.getAttribute("data-message-id"), "", "reply"],
  ]);
  const nestedRow = panel.locator(`[data-message-id="${nested.id}"]`);
  await expect(nestedRow).toBeInViewport();
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await nestedRow.hover();
  await nestedRow.getByRole("button", { name: "Reply", exact: true }).click();
  await editor.fill("Grandchild browser reply");
  await editor.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) => event?.content === "Grandchild browser reply",
      ),
    )
    .toBe(true);
  const grandchild = app.report.publications.find(
    ({ event }) => event?.content === "Grandchild browser reply",
  ).event;
  const grandchildRow = panel.locator(`[data-message-id="${grandchild.id}"]`);
  await expect(grandchildRow).toBeInViewport();
  await expect(editor).toBeFocused();
  await parent
    .locator("..")
    .getByRole("button", { name: "Hide replies", exact: true })
    .first()
    .click();
  await expect(nestedRow).toHaveCount(0);
  await parent
    .locator("..")
    .getByRole("button", { name: "1 reply loaded", exact: true })
    .click();
  await expect(nestedRow).toBeVisible();
  await expect(grandchildRow).toHaveCount(0);
  await nestedRow
    .locator("..")
    .getByRole("button", { name: "1 reply loaded", exact: true })
    .click();
  await expect(grandchildRow).toBeVisible();

  let deepest = grandchildRow;
  for (let depth = 0; depth < 6; depth++) {
    await deepest.hover();
    await deepest.getByRole("button", { name: "Reply", exact: true }).click();
    const content = `Deep reply ${depth}`;
    await editor.fill(content);
    await editor.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.some(({ event }) => event?.content === content),
      )
      .toBe(true);
    const event = app.report.publications.find(
      ({ event }) => event?.content === content,
    ).event;
    deepest = panel.locator(`[data-message-id="${event.id}"]`);
    await expect(deepest).toBeInViewport();
  }
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await deepest.scrollIntoViewIfNeeded();
    const geometry = await panel.evaluate((element) => {
      const history = element.querySelector('[aria-label="Thread messages"]');
      const rail = element.querySelector(
        'button[aria-label="Collapse replies"]',
      );
      return {
        width: history.clientWidth,
        scroll: history.scrollWidth,
        rail: rail.getBoundingClientRect().width,
      };
    });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.rail).toBeGreaterThanOrEqual(24);
    const deepestBox = await deepest.boundingBox();
    expect(deepestBox.width).toBeGreaterThan(140);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        theme,
      );
      await panel.screenshot({
        path: test.info().outputPath(`nested-${width}-${theme}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await panel
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  const linked = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${grandchild.id}>`,
  );
  const linkRow = page.locator(
    `[data-channel-timeline] [data-message-id="${linked.id}"]`,
  );
  await linkRow.getByRole("link", { name: "Alpha", exact: true }).click();
  await expect(grandchildRow).toBeInViewport();
  await expect(grandchildRow).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
  // A later live update must not undo an explicit collapse after revealing a link.
  await parent
    .locator("..")
    .getByRole("button", { name: "Hide replies", exact: true })
    .first()
    .click();
  app.reply(root.id);
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await expect(grandchildRow).toHaveCount(0);
});

test("an exact linked reply stays readable when its parent is outside loaded history", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  // Peer-authored rows never enter this viewer's persistent outbox. The bounded
  // history contains the child and root, but not the intermediate parent.
  const child = app.append(
    "primary",
    "alpha",
    "Exact orphan reply",
    false,
    false,
    root.id,
    "a".repeat(64),
  );
  const link = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${child.id}>`,
    false,
  );
  await open(page, app);
  await page
    .locator(`[data-channel-timeline] [data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Alpha", exact: true })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const orphan = panel.locator(`[data-message-id="${child.id}"]`);
  await expect(orphan).toBeFocused();
  await expect(orphan).toBeInViewport();
  await expect(
    panel.getByText("Earlier reply unavailable in loaded history.", {
      exact: true,
    }),
  ).toBeVisible();
});
