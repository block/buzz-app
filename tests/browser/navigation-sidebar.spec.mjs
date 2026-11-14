import {
  channelRow,
  conversationList,
  openCommunityPicker,
  openPage,
  pageChoice,
  rail,
  selectCommunity,
} from "./navigation.mjs";
import { checkDurationConsumer } from "./duration-layout.mjs";
import { showChannels } from "./rail-helpers.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { createServer } from "./vite-server.mjs";
import { animationsSettled } from "./animations.mjs";
const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({
  enabledPlugins: ["buzz.workflows"],
  largeSidebar: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// Selection motion and cancellation during window resize need real CSS layout
// and animation timelines, which a DOM emulator cannot exercise.
test("segmented selections slide but window resizing follows the selected tab immediately", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/design-system.html#/design/components/tabs`,
    );
    for (const label of [
      "Segmented filters",
      "Small segmented filters",
      "Icon segmented filters",
    ]) {
      await page.setViewportSize({ width: 1280, height: 900 });
      const list = page.getByRole("tablist", { name: label, exact: true });
      await list.getByRole("tab").first().click();
      await animationsSettled(list.locator(".buzz-tabs-indicator"));
      const capture = await list.evaluateHandle((list) => {
        const indicator = list.querySelector(".buzz-tabs-indicator");
        if (!indicator) throw new Error("Missing segmented indicator");
        const start = indicator.getBoundingClientRect().left;
        const state = {
          progress: undefined,
          resizeError: undefined,
        };
        let targetWidth;
        const observer = new MutationObserver(() => {
          const selected = list
            .querySelector('[aria-selected="true"]')
            ?.getBoundingClientRect();
          if (!selected) throw new Error("Missing selected tab");
          if (state.progress === undefined) {
            const animation = indicator
              .getAnimations()
              .find(
                (animation) =>
                  animation instanceof CSSTransition &&
                  animation.transitionProperty === "transform",
              );
            if (!animation?.effect || selected.left === start) return;
            // Hold an actual intermediate frame, independent of runner speed.
            animation.pause();
            animation.currentTime =
              Number(animation.effect.getTiming().duration) / 2;
            state.progress =
              (indicator.getBoundingClientRect().left - start) /
              (selected.left - start);
            targetWidth = selected.width;
          } else if (Math.abs(selected.width - targetWidth) > 1) {
            const pill = indicator.getBoundingClientRect();
            state.resizeError = Math.max(
              Math.abs(pill.left - selected.left),
              Math.abs(pill.right - selected.right),
            );
          }
        });
        observer.observe(indicator, {
          attributes: true,
          attributeFilter: ["style"],
        });
        return {
          state,
          dispose() {
            observer.disconnect();
            indicator.getAnimations().forEach((animation) => {
              animation.finish();
            });
          },
        };
      });
      try {
        await list.getByRole("tab").last().click();
        await expect
          .poll(() => capture.evaluate(({ state }) => state.progress))
          .toBeDefined();
        const progress = await capture.evaluate(({ state }) => state.progress);
        expect(
          progress,
          `${label} travels from its previous selection`,
        ).toBeGreaterThan(0);
        expect(
          progress,
          `${label} has not jumped to its destination`,
        ).toBeLessThan(1);
        // Window resizing must also cancel a slide already in progress.
        await page.setViewportSize({ width: 640, height: 900 });
        await expect
          .poll(() => capture.evaluate(({ state }) => state.resizeError))
          .toBeDefined();
        expect(
          await capture.evaluate(({ state }) => state.resizeError),
          label,
        ).toBeLessThan(1);
      } finally {
        await capture.evaluate(({ dispose }) => dispose());
        await capture.dispose();
      }
    }
  } finally {
    await server.close();
  }
});

// The list column beside the reader resizes from its gutter.
test("conversation list resizes from the full gutter and persists", async ({
  page,
  app,
}) => {
  await open(page, app);
  const handle = page.getByRole("separator", {
    name: "Resize sidebar",
  });
  const sidebar = handle.locator("xpath=preceding-sibling::div[1]");
  await expect(sidebar.locator("[data-activity-sidebar]")).toBeVisible();
  const before = await sidebar.boundingBox();
  const grip = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(grip).not.toBeNull();
  // The resize target begins at the seam, outside list action targets.
  expect(grip.x).toBeCloseTo(before.x + before.width, 0);
  expect(grip.width).toBe(8);
  expect(grip.height).toBeGreaterThan(500);
  await expect(handle).not.toHaveAttribute("title");
  await expect(channelRow(page, "alpha")).not.toHaveAttribute("title");
  await expect(handle).toHaveAttribute(
    "data-tooltip",
    "Drag to resize · Double-click to reset",
  );
  const tooltip = () =>
    handle.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return {
        delay: style.transitionDelay,
        opacity: style.opacity,
        visibility: style.visibility,
      };
    });
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  // Hover must resolve to the resize target across the grip and both gutter edges.
  expect(
    await handle.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [1, bounds.width / 2, bounds.width - 1].map((offset) => {
        const hit = document.elementFromPoint(
          bounds.left + offset,
          bounds.top + bounds.height / 2,
        );
        return hit === element && getComputedStyle(hit).cursor === "ew-resize";
      });
    }),
  ).toEqual([true, true, true]);
  await expect.poll(async () => (await tooltip()).delay).toBe("0.6s");
  await expect.poll(tooltip).toMatchObject({
    opacity: "1",
    visibility: "visible",
  });

  await handle.press("ArrowRight");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeGreaterThan(before.width);
  const keyboardWidth = (await sidebar.boundingBox()).width;
  const movedGrip = await handle.boundingBox();
  await page.mouse.move(
    movedGrip.x + movedGrip.width / 2,
    movedGrip.y + movedGrip.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    movedGrip.x + movedGrip.width / 2 + 120,
    movedGrip.y + movedGrip.height / 2,
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hovered = document.querySelector(":hover");
        return hovered ? getComputedStyle(hovered).cursor : undefined;
      }),
    )
    .toBe("ew-resize");
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeGreaterThan(keyboardWidth + 100);
  const resized = await sidebar.boundingBox();
  await openPage(page, "Workflows");
  await openPage(page, "Team");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(resized.width, 0);

  // Team's list is comfortable at 352px by default.
  await handle.dblclick();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(352, 0);

  await handle.press("Home");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(220, 0);
  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  // A window too small for the widest list, yet wide enough to keep it beside
  // the reader, leaves the reader its room.
  const wideViewport = page.viewportSize();
  await page.setViewportSize({ width: 1100, height: wideViewport.height });
  const constrained = await sidebar.boundingBox();
  expect(constrained.width).toBeLessThan(520);
  await expect(handle).toHaveAttribute(
    "aria-valuenow",
    String(Math.round(constrained.width)),
  );

  await page.setViewportSize(wideViewport);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  await page.setViewportSize({ width: 1100, height: wideViewport.height });
  await handle.press("ArrowLeft");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeLessThan(constrained.width - 8);
  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(constrained.width, 0);
  const constrainedGrip = await handle.boundingBox();
  await page.mouse.move(
    constrainedGrip.x + constrainedGrip.width / 2,
    constrainedGrip.y + constrainedGrip.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    constrainedGrip.x + constrainedGrip.width / 2 - 32,
    constrainedGrip.y + constrainedGrip.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeLessThan(constrained.width - 24);
  const explicitlyResized = await sidebar.boundingBox();
  await page.setViewportSize(wideViewport);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(explicitlyResized.width, 0);
});

// Channel creation needs a connection that can write 9007.
const creationSidebar = test.extend({ channelWriteKinds: [9, 9007, 30315] });
creationSidebar(
  "the Create menu opens the shared channel creation dialog",
  async ({ page, app }, testInfo) => {
    await page.goto(app.origin);
    await showChannels(page);
    const create = rail(page).getByRole("button", {
      name: "Create",
      exact: true,
    });
    await create.click();
    await page
      .getByRole("menu", { name: "New", exact: true })
      .getByRole("menuitem", { name: /^New channel/ })
      .click();

    const dialog = page.getByRole("dialog", { name: "Create a channel" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
    await dialog.getByRole("radio", { name: /Temporary/ }).click();
    await checkDurationConsumer(page, dialog, "create-duration", testInfo);
    await expect(
      dialog.getByRole("radio", { name: /Temporary/ }),
    ).toBeChecked();
    await dialog
      .getByRole("button", { name: "Close channel creation" })
      .click();
    await page
      .getByRole("dialog", { name: "Discard changes?" })
      .getByRole("button", { name: "Discard changes" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(create).toBeFocused();
  },
);

test("hovering a list row marks only that row, not its siblings", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  // Buzzin' light is where hover differs most from resting navigation.
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
    document.documentElement.dataset.colorLevel = "high";
  });
  const row = channelRow(page, "beta");
  const sibling = channelRow(page, "alpha");
  const paint = (element) =>
    element.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
  // Rows transition into the new level's colors; settle before hovering.
  await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const rest = await paint(row);
  const siblingRest = await paint(sibling);
  await row.hover();
  await expect
    .poll(async () => (await paint(row)).background)
    .not.toBe(rest.background);
  expect(await paint(sibling)).toEqual(siblingRest);
});

test("channel navigation preserves the list's DOM", async ({ page, app }) => {
  await open(page, app);
  const list = conversationList(page);
  const node = await list.elementHandle();
  await channelRow(page, "beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await button(page, "Go forward").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
});

test("community picker stays available across pages and restores focus after joining", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", {
    name: "Communities",
    exact: true,
  });
  await expect(
    rail.getByRole("button", {
      name: "Community switcher: Primary",
      exact: true,
    }),
  ).toBeVisible();
  await selectCommunity(page, "Secondary");
  await openPage(page, "Workflows");
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Switch community", exact: true }),
  ).toHaveCount(0);
  await selectCommunity(page, "Personal space");
  await (await openCommunityPicker(page))
    .getByRole("button", { name: "Join a community", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Join a community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    rail.getByRole("button", {
      name: "Community switcher: Personal space",
      exact: true,
    }),
  ).toBeFocused();
});

test("Team's list view does not leak across communities", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  // The rail marks the list's view; each community keeps its own.
  const view = (name) => rail(page).locator(`[data-rail-team-view="${name}"]`);
  await expect(view("channels")).toHaveAttribute("aria-current", "page");
  await selectCommunity(page, "Secondary");
  await expect(button(page, "Community switcher: Secondary")).toBeVisible();
  await expect(view("all")).toHaveAttribute("aria-current", "page");
  await selectCommunity(page, "Primary");
  await expect(view("channels")).toHaveAttribute("aria-current", "page");
});

test("an invalid saved list width falls back", async ({ page, app }) => {
  await open(page, app);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const sidebar = handle.locator("xpath=preceding-sibling::div[1]");
  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  await selectCommunity(page, "Secondary");
  await expect(button(page, "Community switcher: Secondary")).toBeVisible();
  await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) =>
      key.includes('"channel-sidebar"'),
    );
    if (keys.length !== 1)
      throw new Error("The list width was not saved for its workspace");
    localStorage.setItem(keys[0], JSON.stringify({ width: "wide" }));
  });
  await selectCommunity(page, "Primary");
  await expect(button(page, "Community switcher: Primary")).toBeVisible();
  await showChannels(page);
  await expect(channelRow(page, "beta")).toBeVisible();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(352, 0);
});

test("rail loads relay-owned image icons for inactive communities without acquiring sessions", async ({
  page,
  app,
}) => {
  const rasterIcon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y79d4sAAAAASUVORK5CYII=";
  const emojiSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#ffe75c"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🐝</text></svg>';
  const emojiIcon = `data:image/svg+xml,${encodeURIComponent(emojiSvg)}`;
  const infoRequests = [];
  await page.route("**/api/relay/*/icon-info", (route) => {
    infoRequests.push(route.request().url());
    const icon = route.request().url().includes("primary")
      ? rasterIcon
      : emojiIcon;
    return route.fulfill({ json: { icon } });
  });
  await open(page, app);
  const rail = await openCommunityPicker(page);
  for (const [name, icon] of [
    ["Primary", rasterIcon],
    ["Secondary", emojiIcon],
  ]) {
    const image = rail
      .getByRole("button", { name: `Switch to ${name}` })
      .locator("img");
    await expect(image).toHaveAttribute("src", icon);
    await expect(image).toHaveAttribute("data-loaded", "true");
  }
  expect(infoRequests).toHaveLength(2);
  expect(app.report.sessions).toEqual(["primary"]);
});

// Team's page choice opens its list in place; keyboard page search focuses main.
test("Team from page search shows its list and focuses main", async ({
  page,
  app,
}) => {
  await open(page, app);
  await channelRow(page, "beta").click();
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await button(page, "Search Buzz").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const search = dialog.getByRole("combobox", { name: "Search Buzz" });
  await expect(search).toBeFocused();
  await search.pressSequentially("Team");
  await expect(pageChoice(dialog, "Team")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  await search.press("Enter");
  await expect(channelRow(page, "beta")).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
});
