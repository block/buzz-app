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
      if (!(row instanceof HTMLElement) || !(viewport instanceof HTMLElement))
        throw new Error("Missing sidebar row geometry");
      const fillStyle = getComputedStyle(row, "::before");
      const rowStyle = getComputedStyle(row);
      const rowRect = row.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
      const contentRight = viewportRect.right - scrollbarWidth;
      return {
        fillInset:
          contentRight - (rowRect.right - Number.parseFloat(fillStyle.right)),
        leftContentInset: rowRect.left - viewportRect.left,
        rightContentInset: contentRight - rowRect.right,
        radius: fillStyle.borderTopRightRadius,
        overflow: rowStyle.overflow,
        clientWidth: viewport.clientWidth,
        offsetWidth: viewport.offsetWidth,
        scrollbarWidth,
      };
    });
    expect(visual.scrollbarWidth).toBe(visual.offsetWidth - visual.clientWidth);
    expect(visual.leftContentInset).toBe(0);
    expect(visual.rightContentInset).toBe(0);
    expect(visual.fillInset).toBe(5);
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
    .getByRole("button", { name: "Agents", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
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
  await page
    .getByRole("button", { name: "Personal space", exact: true })
    .click();
  for (const name of ["Inbox", "Bestie"]) {
    const button = page
      .getByRole("complementary", { name: "Channel sidebar", exact: true })
      .getByRole("button", { name, exact: true });
    await expect(button).toBeDisabled();
    await button.hover();
    await expect(button).toHaveCSS("cursor", "default");
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const unavailable = await button.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-unavailable)";
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(button).toHaveCSS("color", unavailable);
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
  const section = summary.locator("xpath=ancestor::*[@data-sidebar-section]");
  const contentId = await summary.getAttribute("aria-controls");
  expect(contentId).toBeTruthy();
  const content = section.locator(`[id="${contentId}"]`);
  const details = section.locator(":scope > div:first-child > details");
  const expanded = await section.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  for (const opening of [false, true]) {
    await summary.click();
    if (opening) await expect(details).toHaveAttribute("open", "");
    else await expect(details).not.toHaveAttribute("open");
    if (opening) await expect(content).not.toHaveAttribute("inert");
    else await expect(content).toHaveAttribute("inert", "");
    await expect
      .poll(() => section.evaluate((el) => el.getBoundingClientRect().height))
      .toBe(opening ? expanded : 28);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await summary.click();
  await expect(details).not.toHaveAttribute("open");
  const durations = await section.evaluate((el) => {
    const content = el.querySelector(":scope > div:last-child");
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

// The shell owns sidebar visibility while the mounted sidebar owns route and width state.
test("shell toggle restores the shared sidebar for Channels and Agents", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", { name: "Communities" });
  const shellNavigation = page.locator("#shell-navigation");
  const sidebar = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const sidebarNode = await sidebar.elementHandle();
  const expandedWidth = (await sidebar.boundingBox()).width;
  const track = await shellNavigation.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      width: node.getBoundingClientRect().width,
      property: style.transitionProperty,
      duration: style.transitionDuration,
    };
  });
  expect(track.width).toBe(expandedWidth);
  expect(track.property).toContain("width");
  expect(track.property).toContain("margin-right");
  expect(parseFloat(track.duration)).toBeGreaterThan(0);
  const openGap = await page.evaluate(() => {
    const nav = document.querySelector("#shell-navigation");
    const main = document.querySelector("#main-content");
    if (!(nav instanceof HTMLElement) || !(main instanceof HTMLElement))
      throw new Error("Missing shell panels");
    return {
      actual:
        main.getBoundingClientRect().left - nav.getBoundingClientRect().right,
      token: Number.parseFloat(getComputedStyle(nav).marginRight),
    };
  });
  expect(openGap.actual).toBe(openGap.token);
  expect(openGap.actual).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      shellNavigation.evaluate(
        (node) => getComputedStyle(node).transitionDuration,
      ),
    )
    .toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.getByRole("button", { name: "Hide Channel sidebar" }).click();
  await page.getByRole("button", { name: "Show Channel sidebar" }).click();
  await expect
    .poll(() =>
      shellNavigation.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(expandedWidth);

  await page.getByRole("button", { name: "Hide Channel sidebar" }).click();
  await expect(shellNavigation).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nav = document.querySelector("#shell-navigation");
        const main = document.querySelector("#main-content");
        if (!(nav instanceof HTMLElement) || !(main instanceof HTMLElement))
          throw new Error("Missing shell panels");
        return (
          main.getBoundingClientRect().left - nav.getBoundingClientRect().right
        );
      }),
    )
    .toBe(0);
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show Channel sidebar" }).click();
  await expect(shellNavigation).not.toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  expect((await sidebar.boundingBox()).width).toBe(expandedWidth);

  await sidebar.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide Channel sidebar" }).click();
  await expect(sidebar).not.toBeVisible();
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show Channel sidebar" }).click();
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  expect((await sidebar.boundingBox()).width).toBe(expandedWidth);
  await expect(
    sidebar.getByRole("button", { name: "Agents", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

// A real grid/overlay measurement is needed: DOM presence misses implicit columns.
test("placeholder destinations retain companion layout across navigation and resize", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const launcher = page.locator('.shell-header button[aria-label="Bestie"]');
  const companion = page.getByRole("complementary", {
    name: "Bestie",
    exact: true,
  });
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const checkGeometry = async (overlay) => {
    await expect(companion).toBeVisible();
    await expect
      .poll(async () => {
        const card = await companion.boundingBox();
        const body = await conversation.boundingBox();
        if (!card || !body) return false;
        return overlay
          ? Math.abs(card.x + card.width - body.x - body.width) < 2 &&
              card.x < body.x + body.width
          : card.x >= body.x + body.width;
      })
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(page.viewportSize().width);
  };
  for (const width of [1440, 900, 600]) {
    await page.setViewportSize({ width, height: 950 });
    await sidebar.getByRole("button", { name: "Inbox", exact: true }).click();
    await launcher.click();
    await checkGeometry(width <= 1000);
    await sidebar.getByRole("button", { name: "Bestie", exact: true }).click();
    await expect(
      conversation.getByRole("heading", { name: "Bestie", exact: true }),
    ).toBeVisible();
    await checkGeometry(width <= 1000);
    await launcher.click();
    await expect(companion).not.toBeVisible();
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await launcher.click();
    await sidebar.getByRole("button", { name: "Inbox", exact: true }).click();
    await checkGeometry(width <= 1000);
    await launcher.click();
  }
});

// Real text layout: a rename changes scrollWidth without resizing the label box.
test("channel name fades follow renames without resizing the sidebar", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.locator('button[data-channel-id="alpha"]');
  const label = alpha.getByText("Alpha", { exact: true });
  const labelNode = await label.elementHandle();
  const originalWidth = await label.evaluate((element) => element.clientWidth);
  const sidebarWidth = (await sidebar.boundingBox()).width;
  await expect(label).not.toHaveAttribute("data-overflowing");
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await settings.getByText("Diagnostics", { exact: true }).click();
  for (const [name, overflow] of [
    [
      "A very long renamed channel that cannot possibly fit in this fixed width sidebar",
      true,
    ],
    ["Alpha", false],
  ]) {
    app.renameChannel("alpha", name);
    await settings
      .getByRole("button", { name: "Refresh channels", exact: true })
      .click();
    const renamed = alpha.getByText(name, { exact: true });
    await expect(renamed).toBeVisible();
    expect(await labelNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(await renamed.evaluate((element) => element.clientWidth)).toBe(
      originalWidth,
    );
    expect((await sidebar.boundingBox()).width).toBe(sidebarWidth);
    expect(
      await renamed.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(overflow);
    if (overflow)
      await expect(renamed).toHaveAttribute("data-overflowing", "true");
    else await expect(renamed).not.toHaveAttribute("data-overflowing");
  }
});
