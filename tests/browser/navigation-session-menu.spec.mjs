import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Real app composition: context-menu dismissal must hand focus to the newly
// mounted composer, not restore it to the row. No preference/read-write host
// support is enabled: session entry must not depend on those capabilities.
test.use({ historyCounts: { alpha: 1, beta: 1 } });

test("channel context menu opens and resumes a session draft without a row menu button", async ({
  page,
  app,
}) => {
  await open(page, app);
  // Base UI hides the background from accessibility while the menu is modal.
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
    includeHidden: true,
  });
  const beta = sidebar.locator('[data-channel-id="beta"]');
  const alpha = sidebar.locator('[data-channel-id="alpha"]');
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  const start = menu.getByRole("menuitem", {
    name: "New session",
    exact: true,
  });
  const composer = page.getByRole("textbox", {
    name: "Message this session",
    exact: true,
  });
  await beta.hover();
  // Message rows use page-owned context menus; section actions remain separate.
  await expect(
    sidebar.getByRole("button", { name: /More options for (Alpha|Beta)/ }),
  ).toHaveCount(0);
  await beta.click({ button: "right" });
  await expect(start).toBeVisible();
  // Session entry remains usable even when the independent lifecycle host is absent.
  await expect(menu.getByRole("menuitem")).toHaveText([
    "New session",
    "Channel actions unavailable on this connection",
  ]);
  await expect(
    menu.getByRole("menuitem", {
      name: "Channel actions unavailable on this connection",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(menu.getByRole("separator")).toHaveCount(1);
  await expect(alpha).toHaveAttribute("aria-current", "page");
  // CSS geometry needs a real layout engine. The session item retains the shared
  // full-round token in both themes, independent of viewport width or sibling actions.
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    for (const width of [720, 1000, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const radius = await start.evaluate((element) => {
        // The shared pill token is rem-based; computed corner values are pixels.
        const rem = Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--radius-pill"),
        );
        const rootSize = Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        );
        return `${rem * rootSize}px`;
      });
      for (const corner of [
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
      ]) {
        await expect(start).toHaveCSS(`border-${corner}-radius`, radius);
      }
    }
  }
  await start.click();
  await expect(menu).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(
    sidebar.getByRole("button", { name: "New session draft in Beta" }),
  ).toBeVisible();
  await composer.fill("Keep this draft");
  await alpha.click();
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(start).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText("Keep this draft");
});

// Representative app-wiring regression: a decoded preference update unmounts an
// open Base UI portal while ChannelsPage stays mounted. Transition permutations
// belong in useChannelRowMenu.test.tsx; this checks the actual page/portal seam.
test.describe("menu placement lifetime", () => {
  test.use({ productionBroker: true, savedSidebar: true });
  test("does not resurrect a menu after a preference refresh moves its row away and back", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
      includeHidden: true,
    });
    const work = sidebar
      .locator("[data-sidebar-section]")
      .filter({ has: page.locator("summary", { hasText: /^Work$/ }) });
    const starred = sidebar
      .locator("[data-sidebar-section]")
      .filter({ has: page.locator("summary", { hasText: /Starred$/ }) });
    const beta = sidebar.locator('[data-channel-id="beta"]');
    const menu = page.getByRole("menu", { name: "Actions for Beta" });
    await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await page.getByText("Diagnostics", { exact: true }).click();
    const refresh = page.getByRole("button", {
      name: "Refresh groups and stars",
      exact: true,
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested;
    const started = new Promise((resolve) => {
      requested = resolve;
    });
    let stars = ["alpha", "beta"];
    // Fake only the host decode response. No app hook or client state injection;
    // no account writes. The existing refresh/store subscription drives the UI.
    await page.route("**/sidebar-preferences", async (route) => {
      requested();
      await held;
      await route.fulfill({
        json: {
          sections: [{ id: "work", name: "Work", order: 0 }],
          assignments: { beta: "work" },
          starred: stars,
          muted: [],
        },
      });
    });
    try {
      await refresh.click();
      await started;
      await expect(refresh).toBeDisabled();
      await beta.click({ button: "right" });
      await expect(menu).toBeVisible();
      release();
      await expect(starred.locator('[data-channel-id="beta"]')).toBeVisible();
      await expect(menu).toHaveCount(0);
      stars = ["alpha"];
      await expect(refresh).toBeEnabled();
      await refresh.click();
      await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
      await expect(menu).toHaveCount(0);
      await beta.focus();
      await page.keyboard.press("Shift+F10");
      await expect(menu).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(beta).toBeFocused();
    } finally {
      release();
      await page.unroute("**/sidebar-preferences");
    }
  });
});
