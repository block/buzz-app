import { test, expect } from "./fixture.mjs";
import {
  newChat,
  openPage,
  pageChoice,
  selectCommunity,
  selectPage,
  settleShellToggle,
} from "./navigation.mjs";

// Browser-only boundaries: painted focus, native insets, resize geometry, and
// real App wiring between Messages, Solo chats and the pages listed in its
// sidebar. Contract matrices stay in RTL.
test.use({ pluginFixtures: true, enabledPlugins: ["buzz.drafts-and-sent"] });

test("shared navigation preserves drafts and history across Solo and header pages", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 3,
        enabled: { "buzz.reminders": true, "buzz.workflows": true },
      }),
    );
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  // Every page is a row in the Messages sidebar's Plugins card.
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const row = (name) => pages.getByRole("button", { name, exact: true });
  await expect(
    pages.getByRole("button", { name: /^(Reminders|Agents|Workflows)$/ }),
  ).toHaveText(["Reminders", "Agents", "Workflows"]);
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const sidebarNode = await sidebar.elementHandle();
  await newChat(page);
  await expect(
    page.getByRole("textbox", { name: "Message your agents", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(composer).toHaveCount(0);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(page.locator("#shell-navigation")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await newChat(page);
  await expect(
    page.getByRole("textbox", { name: "Message your agents", exact: true }),
  ).toBeFocused();
  // Pick the original conversation from the shared sidebar to restore its draft.
  const alpha = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true });
  await alpha.click();
  await expect(composer).toHaveText("Keep this draft");
  const reminders = row("Reminders");
  // Activate the page rows through the keyboard, as well as the pointer.
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    for (const activation of ["Enter", "Space"]) {
      await reminders.focus();
      await reminders.press(activation);
      const newComposer = page.getByRole("heading", {
        name: "Reminders",
        exact: true,
      });
      await expect(newComposer).toBeVisible();
      // The real destination and its mount effects must settle before checking focus.
      await newComposer.evaluate(
        (element) =>
          new Promise((resolve) => {
            requestAnimationFrame(() => resolve(element.isConnected));
          }),
      );
      await expect(reminders).toHaveAttribute("aria-current", "page");
      await expect(sidebar).toBeVisible();
      await alpha.focus();
      await alpha.press(activation);
      await expect(reminders).not.toHaveAttribute("aria-current");
      await expect(composer).toHaveText("Keep this draft");
    }
    await reminders.click();
    await expect(
      page.getByRole("heading", { name: "Reminders", exact: true }),
    ).toBeVisible();
    await expect(reminders).toHaveAttribute("aria-current", "page");
    await alpha.click();
    await expect(composer).toHaveText("Keep this draft");
  }
  await expect(sidebar).toBeVisible();
  const workflows = row("Workflows");
  await workflows.click();
  await expect(workflows).toHaveAttribute("aria-current", "page");
  await expect(reminders).not.toHaveAttribute("aria-current");
  await page.reload();
  await expect(workflows).toHaveAttribute("aria-current", "page");
  await reminders.click();
  await expect(reminders).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(workflows).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(reminders).toHaveAttribute("aria-current", "page");
  await alpha.click();
  await expect(composer).toHaveText("Keep this draft");
  await openPage(page, "Settings");
  await expect(pages.locator('[aria-current="page"]')).toHaveCount(0);
});

test("a page listed in the Messages sidebar keeps Messages and the conversation sidebar", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 2,
        enabled: { "fixture.page-placement": true },
      }),
    );
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const destination = sidebar
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Listed destination", exact: true });
  await destination.click();
  await expect(
    page.getByRole("heading", { name: "Listed destination", exact: true }),
  ).toBeVisible();

  // Messages stays the owner: its sidebar is still shown, with the row current.
  await expect(sidebar).toBeVisible();
  await expect(destination).toHaveAttribute("aria-current", "page");

  await sidebar
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(composer).toBeVisible();
  await expect(destination).not.toHaveAttribute("aria-current");
});

test("a page sidebar uses the shell slot, generic toggle, theme, and narrow drawer", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "system");
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 2,
        enabled: {
          "fixture.page-placement": true,
          "buzz.reminders": true,
          "buzz.workflows": true,
          "buzz.drafts-and-sent": true,
        },
      }),
    );
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const pages = page.getByRole("navigation", { name: "Pages" });
  const destination = pages.getByRole("button", {
    name: "Sidebar playground",
    exact: true,
  });
  await expect(destination).toBeVisible();
  await destination.focus();
  await destination.press("Enter");

  const sidebar = page.getByRole("complementary", { name: "Fixture sidebar" });
  await expect(sidebar).toContainText("Target: sidebar");
  const drafts = sidebar
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Drafts & sent", exact: true });
  await expect(drafts).toHaveCount(1);
  // The page's own sidebar replaces the Messages sidebar it is listed in, and
  // Messages stays selected.
  await expect(
    page.getByRole("complementary", { name: "Sidebar", exact: true }),
  ).toHaveCount(0);
  // The replacement sidebar's own Pages list marks the page as current.
  await expect(destination).toHaveAttribute("aria-current", "page");
  const wideSize = await sidebar.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(wideSize).toBeGreaterThan(220);
  const resizeHandle = page.getByRole("separator", {
    name: "Resize sidebar",
  });
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "260");
  await page.screenshot({
    path: test.info().outputPath("page-sidebar-before-resize.png"),
  });
  const handleBounds = await resizeHandle.boundingBox();
  if (!handleBounds) throw new Error("Page sidebar resize handle has no box");
  const handleX = handleBounds.x + handleBounds.width / 2;
  const handleY = handleBounds.y + handleBounds.height / 2;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + 80, handleY, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() =>
      resizeHandle.evaluate(
        (element) =>
          element.previousElementSibling.getBoundingClientRect().width,
      ),
    )
    .toBe(340);
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(340);
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "340");
  await page.screenshot({
    path: test.info().outputPath("page-sidebar-after-resize.png"),
  });

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const shellNavigation = page.locator("#shell-navigation");
  const action = sidebar.getByRole("button", {
    name: "Fixture sidebar action",
  });
  const sidebarColors = [];
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(drafts).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`drafts-sidebar-${mode}.png`),
    });
    const geometryAndColors = await sidebar.evaluate((element) => {
      const slot = element.parentElement.getBoundingClientRect();
      const action = element.querySelector("button").getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        slot: {
          left: slot.left,
          right: slot.right,
          top: slot.top,
          bottom: slot.bottom,
        },
        action: {
          left: action.left,
          right: action.right,
          top: action.top,
          bottom: action.bottom,
        },
        background: style.backgroundColor,
        color: style.color,
      };
    });
    sidebarColors.push({
      background: geometryAndColors.background,
      color: geometryAndColors.color,
    });
    expect(geometryAndColors.action.left).toBeGreaterThanOrEqual(
      geometryAndColors.slot.left,
    );
    expect(geometryAndColors.action.right).toBeLessThanOrEqual(
      geometryAndColors.slot.right,
    );
    expect(geometryAndColors.action.top).toBeGreaterThanOrEqual(
      geometryAndColors.slot.top,
    );
    expect(geometryAndColors.action.bottom).toBeLessThanOrEqual(
      geometryAndColors.slot.bottom,
    );
    // The header's account controls come before the sidebar in tab order.
    await page.getByRole("button", { name: /^Community switcher:/ }).focus();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Your profile", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(shellNavigation).toHaveAttribute("aria-hidden", "true");
    await expect(shellNavigation).toHaveAttribute("inert");
    await expect
      .poll(() =>
        shellNavigation.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      )
      .toBe(0);
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(shellNavigation).toHaveAttribute("aria-hidden", "false");
    await expect
      .poll(() =>
        shellNavigation.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      )
      .toBeGreaterThan(220);
  }
  expect(sidebarColors[0].background).not.toBe(sidebarColors[1].background);
  expect(sidebarColors[0].color).not.toBe(sidebarColors[1].color);

  await page.setViewportSize({ width: 390, height: 844 });
  const showNavigation = page.getByRole("button", { name: "Show navigation" });
  await expect(showNavigation).toBeVisible();
  await showNavigation.click();
  await expect(sidebar).toBeVisible();
  const narrowGeometry = await sidebar.evaluate((element) => {
    const slot = element.parentElement.getBoundingClientRect();
    const action = element.querySelector("button").getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      slot: { left: slot.left, right: slot.right, width: slot.width },
      action: { left: action.left, right: action.right },
    };
  });
  expect(narrowGeometry.slot.width).toBeGreaterThan(0);
  expect(narrowGeometry.slot.width).toBeLessThanOrEqual(
    narrowGeometry.viewportWidth,
  );
  expect(narrowGeometry.slot.left).toBeGreaterThanOrEqual(0);
  expect(narrowGeometry.slot.right).toBeLessThanOrEqual(
    narrowGeometry.viewportWidth,
  );
  expect(narrowGeometry.action.left).toBeGreaterThanOrEqual(
    narrowGeometry.slot.left,
  );
  expect(narrowGeometry.action.right).toBeLessThanOrEqual(
    narrowGeometry.slot.right,
  );
  await action.focus();
  await page.keyboard.press("Escape");
  await expect(shellNavigation).toHaveAttribute("aria-hidden", "true");
  await expect(showNavigation).toBeFocused();
  await page.keyboard.press("Tab");
  expect(
    await shellNavigation.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(false);
  // Native focus and drawer handoff across a contributed sidebar cannot be
  // established by the mounted App's route/slot coverage.
  await selectCommunity(page, "Personal space");
  await openPage(page, "Sidebar playground");
  await showNavigation.click();
  await drafts.focus();
  await expect(drafts).toBeInViewport();
  await drafts.press("Enter");
  const draftsPage = page.getByRole("region", {
    name: "Drafts & sent",
    exact: true,
  });
  await expect(draftsPage).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(shellNavigation).toHaveAttribute("aria-hidden", "true");
  await showNavigation.click();
  const coreDrafts = pages.getByRole("button", {
    name: "Drafts & sent",
    exact: true,
  });
  await expect(coreDrafts).toHaveCount(1);
  await expect(coreDrafts).toHaveAttribute("aria-current", "page");
  await destination.click();
  await expect(
    page.getByRole("heading", { name: "Sidebar playground", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const input = search.getByRole("combobox", { name: "Search Buzz" });
  await input.fill("drafts");
  await expect(pageChoice(search, "Drafts & sent")).toHaveCount(1);
  await selectPage(page, "Drafts & sent");
  await expect(search).toHaveCount(0);
  await expect(draftsPage).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(
    page.getByRole("button", {
      name: "Community switcher: Personal space",
      exact: true,
    }),
  ).toBeVisible();
});

test.describe("failed page sidebar recovery", () => {
  test.use({ expectedPageFailure: true, historyCounts: { alpha: 1, beta: 0 } });

  // A DOM emulator cannot prove that the bounded shell fallback admits real scrolling.
  test("recovery navigation scrolls at short heights and enlarged text", async ({
    page,
    app,
  }) => {
    await page.addInitScript(() => {
      window.fixtureSidebarRecovery = true;
      localStorage.setItem("buzz-appearance.v1", "system");
      localStorage.setItem(
        "buzzodz.plugins.v1",
        JSON.stringify({
          version: 2,
          enabled: {
            "fixture.page-placement": true,
            "buzz.reminders": true,
            "buzz.workflows": true,
          },
        }),
      );
    });
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const [width, height, theme] of [
      [1440, 500, "light"],
      [390, 844, "dark"],
    ]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height });
      await page.evaluate(() => {
        window.fixtureSidebarRecovery = true;
      });
      await openPage(page, "Sidebar playground");
      if (width === 390)
        await page.getByRole("button", { name: "Show navigation" }).click();
      const fallback = page.getByRole("complementary", {
        name: "Sidebar playground sidebar",
      });
      await expect(fallback.getByRole("alert")).toHaveText(
        "This page’s sidebar is unavailable.",
      );
      await expect(
        page.getByRole("heading", { name: "Sidebar playground", exact: true }),
      ).toBeVisible();
      const retry = fallback.getByRole("button", {
        name: "Sidebar playground",
        exact: true,
      });
      const scrollMetrics = () =>
        retry.evaluate((element) => {
          for (
            let parent = element.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            if (
              !/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY) ||
              parent.scrollHeight <= parent.clientHeight
            )
              continue;
            const region = parent.getBoundingClientRect();
            const row = element.getBoundingClientRect();
            return {
              top: parent.scrollTop,
              reachable: row.top >= region.top && row.bottom <= region.bottom,
            };
          }
          return null;
        });
      await expect.poll(scrollMetrics).not.toBeNull();
      await fallback.hover();
      await page.mouse.wheel(0, 2000);
      await expect.poll(scrollMetrics).toMatchObject({ reachable: true });
      expect((await scrollMetrics()).top).toBeGreaterThan(0);
      await retry.focus();
      await expect(retry).toBeFocused();
      await page.evaluate(() => {
        window.fixtureSidebarRecovery = false;
      });
      await retry.press("Enter");
      await expect(fallback).toHaveCount(0);
      if (width === 390)
        await page.getByRole("button", { name: "Show navigation" }).click();
      await expect(
        page.getByRole("button", { name: "Fixture sidebar action" }),
      ).toBeVisible();
    }
  });
});

test("sidebar page rows and titlebar controls remain reachable through scale and resize", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "system");
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 2,
        enabled: {
          "fixture.page-placement": true,
          "buzz.reminders": true,
          "buzz.workflows": true,
        },
      }),
    );
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  // Every page is a row in the sidebar's Plugins card.
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const toolbar = pages.getByRole("button", {
    name: "Toolbar destination",
    exact: true,
  });
  await toolbar.click();
  await expect(
    page.getByRole("heading", { name: "Toolbar destination" }),
  ).toBeVisible();
  await expect(toolbar).toHaveAttribute("aria-current", "page");
  await openPage(page, "Messages");
  // Simulate the native control reserve; native dragging itself needs desktop testing.
  await page
    .locator(".shell-header")
    .evaluate((header) => header.classList.add("shell-header-mac"));
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const scale of [1, 2]) {
      await page.evaluate((scale) => {
        document.documentElement.style.fontSize = `${scale * 100}%`;
      }, scale);
      for (const width of [1600, 1024, 800, 650, 480, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await settleShellToggle(page);
        // A narrow window keeps the sidebar in a drawer.
        const showNavigation = page.getByRole("button", {
          name: "Show navigation",
          exact: true,
        });
        const drawer = await showNavigation.isVisible();
        if (drawer) await showNavigation.click();
        await expect(pages).toBeVisible();
        const search = page.getByRole("button", {
          name: "Search Buzz",
          exact: true,
        });
        await expect(search).toBeInViewport({ ratio: 1 });
        if (width >= 480 * scale) {
          await expect
            .poll(() =>
              page.locator(".shell-header").evaluate((header) => {
                const search = header
                  .querySelector(".shell-menu-search")
                  .getBoundingClientRect();
                const history = header
                  .querySelector(".shell-history")
                  .getBoundingClientRect();
                const actions = header
                  .querySelector(".shell-actions")
                  .getBoundingClientRect();
                return (
                  Math.abs(
                    search.y +
                      search.height / 2 -
                      history.y -
                      history.height / 2,
                  ) < 1 &&
                  Math.abs(
                    search.y +
                      search.height / 2 -
                      actions.y -
                      actions.height / 2,
                  ) < 1
                );
              }),
            )
            .toBe(true);
        }

        await expect
          .poll(async () => {
            const box = await search.boundingBox();
            const history = await page.locator(".shell-history").boundingBox();
            const actions = await page.locator(".shell-actions").boundingBox();
            const sameRow =
              Math.abs(
                box.y + box.height / 2 - history.y - history.height / 2,
              ) < 1;
            if (width < 1024 * scale && sameRow) {
              // Compact Search fills the available track, retaining the requested 24pt gaps.
              return Math.max(
                Math.abs(box.x - history.x - history.width - 24 * scale),
                Math.abs(actions.x - box.x - box.width - 24 * scale),
              );
            }
            return Math.abs(box.x + box.width / 2 - width / 2);
          })
          .toBeLessThan(1);
        await expect
          .poll(() =>
            page.locator(".shell-header").evaluate((header) => {
              const search = header
                .querySelector(".shell-menu-search")
                .getBoundingClientRect();
              const others = [
                ...header.querySelectorAll(
                  ".shell-history button, .shell-actions button",
                ),
              ];
              return others.every((button) => {
                const box = button.getBoundingClientRect();
                return (
                  box.right <= search.left ||
                  box.left >= search.right ||
                  box.bottom <= search.top ||
                  box.top >= search.bottom
                );
              });
            }),
          )
          .toBe(true);
        // The last page row stays reachable inside the sidebar at every size.
        await toolbar.scrollIntoViewIfNeeded();
        await toolbar.focus();
        await expect(toolbar).toBeInViewport({ ratio: 1 });
        // Messages is open, so no page row is current.
        await expect(toolbar).not.toHaveAttribute("aria-current");
        if (drawer) {
          await page.keyboard.press("Escape");
          await expect(page.locator("#shell-navigation")).toHaveAttribute(
            "aria-hidden",
            "true",
          );
        }
        await search.click();
        const dialog = page.getByRole("dialog", {
          name: "Search Buzz",
          exact: true,
        });
        await expect(
          dialog.getByRole("combobox", { name: "Search Buzz" }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(search).toBeFocused();
        await page.screenshot({
          path: test.info().outputPath(`dock-${mode}-${scale}-${width}.png`),
        });
      }
    }
  }
});
