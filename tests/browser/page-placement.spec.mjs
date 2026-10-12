import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Browser-only boundaries: measured overflow/simulated native insets, keyboard focus on
// resize, and real App wiring between Messages and Me. Contract matrices stay in RTL.
test.use({ pluginFixtures: true });

test("Me replaces the sidebar while Messages preserves its draft and history", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  const topbar = page.getByRole("navigation", { name: "Topbar pages" });
  await expect(topbar.getByRole("tab")).toHaveText(["Me", "Messages"]);
  await topbar.getByRole("tab", { name: "Me", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Me sidebar" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  await expect(
    topbar.getByRole("tab", { name: "Me", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Hide Me sidebar" }).click();
  await expect(page.locator("#shell-navigation")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.getByRole("button", { name: "Show Me sidebar" }).click();
  const me = topbar.getByRole("tab", { name: "Me", exact: true });
  const messages = topbar.getByRole("tab", { name: "Messages", exact: true });
  await me.focus();
  await me.press("ArrowRight");
  await expect(messages).toBeFocused();
  await expect(me).toHaveAttribute("aria-selected", "true");
  await messages.press("Enter");
  await expect(messages).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "Messages", exact: true }),
  ).toBeVisible();
  const indicator = topbar.locator(".buzz-tabs-indicator");
  await expect
    .poll(async () => {
      const tab = await messages.boundingBox();
      const pill = await indicator.boundingBox();
      return tab && pill
        ? Math.abs(tab.x - pill.x) + Math.abs(tab.width - pill.width)
        : Infinity;
    })
    .toBeLessThan(1);
  await expect(composer).toHaveText("Keep this draft");
  // Enter the page through normal keyboard traversal, not programmatic panel focus.
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    for (const activation of ["Enter", "Space"]) {
      await messages.focus();
      await messages.press("ArrowLeft");
      await expect(me).toBeFocused();
      await me.press(activation);
      const newComposer = page.getByRole("textbox", {
        name: "Message your agents",
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
      await expect(me).toHaveAttribute("aria-selected", "true");
      await expect(me).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(messages).toBeFocused();
      await expect(me).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press(activation);
      await expect(messages).toHaveAttribute("aria-selected", "true");
      await expect(composer).toHaveText("Keep this draft");
    }
    await me.click();
    const newComposer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    await expect(newComposer).toBeVisible();
    await newComposer.evaluate(
      (element) =>
        new Promise((resolve) => {
          requestAnimationFrame(() => resolve(element.isConnected));
        }),
    );
    await expect(me).toBeFocused();
    await page
      .getByRole("complementary", { name: "Me sidebar" })
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await expect(newComposer).toBeFocused();
    for (const name of ["Me", "Messages"]) {
      await topbar.getByRole("tab", { name, exact: true }).click();
      const panel = page.getByRole("tabpanel", { name, exact: true });
      await page.locator("#main-content").focus();
      await page.keyboard.press("Tab");
      await expect(panel).toBeFocused();
      await expect(panel).toHaveCSS("outline-style", "solid");
      await expect(panel).toHaveCSS("outline-width", "2px");
      const focus = await panel.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const frame = element.parentElement.getBoundingClientRect();
        return {
          offset: Number.parseFloat(style.outlineOffset),
          width: Number.parseFloat(style.outlineWidth),
          color: style.outlineColor,
          insideFrame:
            box.left >= frame.left &&
            box.right <= frame.right &&
            box.top >= frame.top &&
            box.bottom <= frame.bottom,
        };
      });
      expect(focus.insideFrame).toBe(true);
      expect(focus.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(focus.offset + focus.width).toBeLessThanOrEqual(0);
      const screenshot = await page.screenshot({
        scale: "css",
        path: test.info().outputPath(`panel-focus-${name}-${mode}.png`),
      });
      const edgeColors = await panel.evaluate(async (element, imageBase64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${imageBase64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const box = element.getBoundingClientRect();
        return [
          [box.left + 1, box.top + box.height / 2],
          [box.right - 1, box.top + box.height / 2],
          [box.left + box.width / 2, box.top + 1],
          [box.left + box.width / 2, box.bottom - 1],
        ].map(([x, y]) => {
          const [r, g, b] = context.getImageData(
            Math.floor(x),
            Math.floor(y),
            1,
            1,
          ).data;
          return `rgb(${r}, ${g}, ${b})`;
        });
      }, screenshot.toString("base64"));
      expect(edgeColors).toEqual(Array(4).fill(focus.color));
      await page.keyboard.press("Tab");
      await expect(panel).not.toBeFocused();
      await expect(panel).toHaveCSS("outline-style", "none");
      await topbar.getByRole("tab", { name, exact: true }).click();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-keyboard-navigation",
      );
    }
  }
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).toBeVisible();
  await openPage(page, "Settings");
  await expect(topbar.locator('[aria-selected="true"]')).toHaveCount(0);
});

test("a page sidebar uses the shell slot, title toggle, theme, and narrow drawer", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "system");
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
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).toHaveCount(0);
  const wideSize = await sidebar.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(wideSize).toBeGreaterThan(220);

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
    await destination.focus();
    const tabStopCount = await page
      .locator(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )
      .count();
    for (let index = 0; index <= tabStopCount; index += 1) {
      if (
        await action.evaluate((element) => element === document.activeElement)
      )
        break;
      await page.keyboard.press("Tab");
    }
    await expect(action).toBeFocused();
    await page
      .getByRole("button", { name: "Hide Sidebar playground sidebar" })
      .click();
    await expect(shellNavigation).toHaveAttribute("aria-hidden", "true");
    await expect(shellNavigation).toHaveAttribute("inert");
    await expect
      .poll(() =>
        shellNavigation.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      )
      .toBe(0);
    await page
      .getByRole("button", { name: "Show Sidebar playground sidebar" })
      .click();
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
          enabled: { "fixture.page-placement": true },
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

test("header pages remain reachable without overlap through scale and resize", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "system");
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
  const topbar = page.getByRole("navigation", { name: "Topbar pages" });
  const toolbar = page.getByRole("navigation", { name: "Toolbar pages" });
  const more = page.getByRole("button", { name: "More pages", exact: true });
  const me = topbar.getByRole("tab", { name: "Me", exact: true });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect(topbar).toBeVisible();
    const geometry = await page.locator(".shell-header").evaluate((header) => {
      const rect = (selector) =>
        header.querySelector(selector).getBoundingClientRect();
      return {
        left: rect(".shell-communities").right,
        center: rect(".shell-topbar-pages").toJSON(),
        right: rect(".shell-actions").left,
        width: header.clientWidth,
      };
    });
    expect(geometry.center.x).toBeGreaterThan(geometry.left);
    expect(geometry.center.right).toBeLessThan(geometry.right);
    expect(
      Math.abs(
        geometry.center.x + geometry.center.width / 2 - geometry.width / 2,
      ),
    ).toBeLessThan(1);
    await toolbar.getByRole("button", { name: "Toolbar destination" }).click();
    await expect(
      page.getByRole("heading", { name: "Toolbar destination" }),
    ).toBeVisible();
    await expect(toolbar.getByRole("button")).toHaveAttribute(
      "aria-current",
      "page",
    );
    // 800px exercises measured overflow, not only the <=650px CSS fallback.
    for (const width of [800, 650, 390]) {
      await me.focus();
      await page.setViewportSize({ width, height: 950 });
      await expect(more).toBeFocused();
      await expect(topbar).not.toBeVisible();
      await expect(toolbar).not.toBeVisible();
      await more.press("Enter");
      const choices = page.getByRole("navigation", { name: "Header pages" });
      await expect(choices.getByRole("button")).toHaveText([
        "Me",
        "Messages",
        "A deliberately long topbar destination",
        "Toolbar destination",
      ]);
      await page.keyboard.press("Escape");
      await expect(choices).toHaveCount(0);
      await expect(more).toBeFocused();
      await more.press("Enter");
      await choices.getByRole("button", { name: "Me", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "New conversation", exact: true }),
      ).toBeVisible();
      await expect(more).not.toHaveAttribute("aria-expanded", "true");
      // Widen with focus inside the open overflow, not only on its trigger.
      await more.click();
      await choices
        .getByRole("button", { name: "Messages", exact: true })
        .focus();
      await page.setViewportSize({ width: 1600, height: 950 });
      await expect(choices).toHaveCount(0);
      await expect(me).toBeFocused();
    }
  }
  // Simulate the native reserve and 200% interface text size, not native drag behavior.
  await page
    .locator(".shell-header")
    .evaluate((header) => header.classList.add("shell-header-mac"));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(more).toBeVisible();
  await more.click();
  await expect(
    page
      .getByRole("navigation", { name: "Header pages" })
      .getByRole("button", { name: "Messages", exact: true }),
  ).toBeVisible();
});
