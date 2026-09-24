import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Real layout, pointer hover and portaled-menu geometry cannot be proven in jsdom.
// Keep this fixture small; the existing sidebar-unread journeys own overflow scale.
test("compact sidenav keeps its geometry across persistent page navigation", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.getByRole("button", { name: "Alpha", exact: true });
  const before = await alpha.boundingBox();
  expect(before.height).toBe(28);
  const viewportBox = await sidebar.boundingBox();
  const alphaBox = await alpha.boundingBox();
  const overflow = await sidebar.evaluate((viewport) => ({
    clientWidth: viewport.clientWidth,
    scrollWidth: viewport.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  expect(alphaBox.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(alphaBox.x + alphaBox.width).toBeLessThanOrEqual(
    viewportBox.x + viewportBox.width,
  );
  const assertRowFillRounded = async () => {
    const visual = await alpha.evaluate((button) => {
      const row = button.closest("[data-channel-sidebar-row]");
      const viewport = button.closest("nav");
      const panel = viewport.closest("aside");
      if (
        !(row instanceof HTMLElement) ||
        !(viewport instanceof HTMLElement) ||
        !(panel instanceof HTMLElement)
      )
        throw new Error("Missing sidebar row geometry");
      const fillStyle = getComputedStyle(row, "::before");
      const rowStyle = getComputedStyle(row);
      const rowRect = row.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const borderLeft = Number.parseFloat(
        getComputedStyle(panel).borderLeftWidth,
      );
      const borderRight = Number.parseFloat(
        getComputedStyle(panel).borderRightWidth,
      );
      return {
        fillRight: rowRect.right - Number.parseFloat(fillStyle.right),
        panelContentRight: viewportRect.left + viewport.clientWidth,
        leftInset: rowRect.left - (panelRect.left + borderLeft),
        rightInset: panelRect.right - borderRight - rowRect.right,
        radius: fillStyle.borderTopRightRadius,
        overflow: rowStyle.overflow,
        clientWidth: viewport.clientWidth,
        offsetWidth: viewport.offsetWidth,
      };
    });
    expect(visual.offsetWidth).toBeGreaterThanOrEqual(visual.clientWidth);
    expect(visual.fillRight).toBeLessThanOrEqual(visual.panelContentRight);
    expect(visual.leftInset - visual.rightInset).toBe(4);
    expect(Number.parseFloat(visual.radius)).toBeGreaterThan(0);
    expect(visual.overflow).toBe("visible");
  };
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "124px";
  });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (viewport) => viewport.scrollWidth - viewport.clientWidth,
      ),
    )
    .toBe(0);
  const narrowViewport = await sidebar.boundingBox();
  const narrowAlpha = await alpha.boundingBox();
  expect(narrowAlpha.x + narrowAlpha.width).toBeLessThanOrEqual(
    narrowViewport.x + narrowViewport.width,
  );
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "260px";
  });
  await expect
    .poll(() => alpha.evaluate((row) => row.getBoundingClientRect().width))
    .toBe(before.width);
  await alpha.hover();
  await expect(
    sidebar.getByRole("button", { name: "More options for Alpha" }),
  ).toHaveCount(0);
  const afterHover = await alpha.boundingBox();
  expect(afterHover.height).toBe(before.height);
  expect(afterHover.width).toBe(before.width);
  await alpha.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(alpha).toBeFocused();
  const node = await sidebar.elementHandle();
  await page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(alpha).toBeVisible();
  await alpha.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    await sidebar.screenshot({ path: info.outputPath(`sidenav-${mode}.png`) });
  }
});

// Browser layout and native disclosure behavior are not represented in jsdom.
test("section disclosure toggles content and honors reduced motion", async ({
  page,
  app,
}) => {
  await open(page, app);
  const summary = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator("summary")
    .filter({ hasText: /^Channels$/ });
  const section = summary.locator("..");
  const content = section.locator(":scope > div");
  const expanded = await section.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  for (const opening of [false, true]) {
    await summary.click();
    if (opening) await expect(section).toHaveAttribute("open", "");
    else await expect(section).not.toHaveAttribute("open");
    if (opening) await expect(content).not.toHaveAttribute("inert");
    else await expect(content).toHaveAttribute("inert", "");
    await expect
      .poll(() => section.evaluate((el) => el.getBoundingClientRect().height))
      .toBe(opening ? expanded : 28);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await summary.click();
  await expect(section).not.toHaveAttribute("open");
  const durations = await section.evaluate((el) => {
    const content = el.querySelector(":scope > div");
    const chevron = el.querySelector("summary > span:last-child");
    return [content, chevron].map(
      (element) => getComputedStyle(element).transitionDuration,
    );
  });
  expect(durations).toEqual(["0s", "0s"]);
  expect(
    await section.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(28);
});
