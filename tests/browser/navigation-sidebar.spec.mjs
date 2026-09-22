import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({
  largeSidebar: true,
  historyCounts: { alpha: 1, beta: 1 },
});

const sessionParent = "11111111-1111-4111-8111-111111111111";
const sessionSidebar = test.extend({
  sessionChannels: ["alpha"],
  sessionParents: { alpha: sessionParent },
});

test("channel sidebar resizes from the full gutter and persists", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("complementary", {
    name: "Channel sidebar",
  });
  const handle = page.getByRole("separator", {
    name: "Resize channel sidebar",
  });
  const channelList = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const before = await sidebar.boundingBox();
  const grip = await handle.boundingBox();
  const listBox = await channelList.boundingBox();
  expect(before).not.toBeNull();
  expect(grip).not.toBeNull();
  expect(listBox).not.toBeNull();
  const geometry = await sidebar.evaluate((panel) => {
    const content = panel.firstElementChild;
    const row = panel.querySelector('[data-channel-id="alpha"]');
    if (!(content instanceof HTMLElement) || !(row instanceof HTMLElement))
      throw new Error("Channel sidebar geometry is unavailable");
    const panelStyle = getComputedStyle(panel);
    const boardStyle = getComputedStyle(panel.parentElement);
    const contentStyle = getComputedStyle(content);
    const rowStyle = getComputedStyle(row);
    return {
      panelRadius: Number.parseFloat(panelStyle.borderTopLeftRadius),
      panelGap: Number.parseFloat(boardStyle.gridTemplateColumns.split(" ")[1]),
      padding: [
        contentStyle.paddingTop,
        contentStyle.paddingRight,
        contentStyle.paddingBottom,
        contentStyle.paddingLeft,
      ].map(Number.parseFloat),
      rowRadius: Number.parseFloat(rowStyle.borderTopLeftRadius),
    };
  });
  expect(new Set(geometry.padding).size).toBe(1);
  expect(geometry.rowRadius).toBe(geometry.panelRadius - geometry.padding[0]);
  const conversation = await page
    .getByRole("article", { name: "Conversation" })
    .boundingBox();
  expect(conversation).not.toBeNull();
  expect(conversation.x - (before.x + before.width)).toBeCloseTo(
    geometry.panelGap,
    0,
  );
  expect(grip.width).toBeGreaterThanOrEqual(16);
  expect(grip.height).toBeGreaterThan(500);
  expect(before.x + before.width - (listBox.x + listBox.width)).toBeCloseTo(
    1,
    0,
  );
  await expect(handle).not.toHaveAttribute("title");
  await expect(button(page, "Alpha")).not.toHaveAttribute("title");
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
    .toBe("col-resize");
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeGreaterThan(keyboardWidth + 100);
  const resized = await sidebar.boundingBox();
  await button(page, "Home").first().click();
  await button(page, "Messages").first().click();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(resized.width, 0);

  await handle.dblclick();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(260, 0);

  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  const wideViewport = page.viewportSize();
  await page.setViewportSize({ width: 800, height: wideViewport.height });
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
  await page.setViewportSize({ width: 800, height: wideViewport.height });
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

sessionSidebar(
  "parent disclosures and child sessions share the channel icon and label columns",
  async ({ page, app }) => {
    await page.goto(app.origin);
    await button(page, "Messages").first().click();
    const parent = page.locator(`[data-channel-id="${sessionParent}"]`);
    const child = page.locator('[data-channel-id="alpha"]');
    const regular = page.locator('[data-channel-id="beta"]');
    const disclosure = page.getByRole("button", { name: /sessions in/ });
    const x = async (locator) => (await locator.boundingBox())?.x;
    const label = (row) => row.locator(".navigation-item-label");

    await expect(parent).toBeVisible();
    await expect(child).toBeVisible();
    await expect(regular).toBeVisible();
    const regularIconX = await x(regular.locator("svg").first());
    const parentIconX = await x(disclosure.locator("svg:visible"));
    expect(parentIconX).toBeCloseTo(regularIconX, 0);

    await parent.hover();
    const chevronX = await x(disclosure.locator("svg:visible"));
    expect(chevronX).toBeCloseTo(regularIconX, 0);
    expect(await x(label(parent))).toBeCloseTo(await x(label(regular)), 0);
    expect(await x(label(child))).toBeCloseTo(await x(label(regular)), 0);

    const parentSurface = parent.locator(
      "xpath=ancestor::*[@data-channel-sidebar-row]",
    );
    const more = page.getByRole("button", { name: /More options for/ }).first();
    expect(
      await more.evaluate(
        (action, row) => row.contains(action),
        await parentSurface.elementHandle(),
      ),
    ).toBe(true);
    expect(
      await parent.evaluate((row) => getComputedStyle(row).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      await parentSurface.evaluate(
        (row) => getComputedStyle(row).backgroundColor,
      ),
    ).not.toBe("rgba(0, 0, 0, 0)");

    await more.click();
    await page.getByRole("menuitem", { name: "New session" }).click();
    const draft = page.getByRole("button", { name: /New session draft in/ });
    await expect(draft).toBeVisible();
    expect(await x(label(draft))).toBeCloseTo(await x(label(regular)), 0);
  },
);

test("session actions follow the Sessions plugin availability", async ({
  page,
  app,
}) => {
  await open(page, app);
  await button(page, "Alpha").hover();
  await expect(
    page.getByRole("button", { name: "More options for Alpha" }),
  ).toBeVisible();

  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  const plugins = page.getByRole("region", { name: "Plugins", exact: true });
  const sessions = plugins.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Sessions", exact: true }),
  });
  const toggle = sessions.getByRole("switch", { name: "Enable Sessions" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await button(page, "Messages").first().click();
  await button(page, "Alpha").hover();
  await expect(
    page.getByRole("button", { name: "More options for Alpha" }),
  ).toHaveCount(0);
});

test("channel navigation preserves sidebar DOM, group state and scroll", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const node = await sidebar.elementHandle();
  await expect(
    page.getByRole("searchbox", { name: "Search channels" }),
  ).toHaveCount(0);
  await button(page, "Beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  const scroll = await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scroll).toBeGreaterThan(100);
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(group).not.toHaveAttribute("open");
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(
    scroll,
    0,
  );
  await button(page, "Go forward").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(group).not.toHaveAttribute("open");
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBeCloseTo(
    scroll,
    0,
  );
});

for (const destination of ["Home", "Projects", "Settings", "Back/Forward"]) {
  test(`sidebar state survives Messages → ${destination} → Messages`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const group = sidebar
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
    const leave = async () => {
      if (destination === "Settings") {
        await button(page, "Your profile").click();
        await button(page, "Settings").click();
        await expect(
          page.getByRole("heading", { name: "Settings", exact: true }),
        ).toBeVisible();
      } else {
        await button(
          page,
          destination === "Back/Forward" ? "Home" : destination,
        )
          .first()
          .click();
      }
      await expect(sidebar).toHaveCount(0);
      await button(
        page,
        destination === "Back/Forward" ? "Go back" : "Messages",
      )
        .first()
        .click();
    };
    await group.locator("summary").click();
    await expect(group).not.toHaveAttribute("open");
    const scroll = await sidebar.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scroll).toBeGreaterThan(100);
    await leave();
    await expect(group).not.toHaveAttribute("open");
    await expect
      .poll(() => sidebar.evaluate((element) => element.scrollTop))
      .toBeCloseTo(scroll, 0);
    if (destination === "Back/Forward") {
      await button(page, "Go forward").click();
      await expect(sidebar).toHaveCount(0);
      await button(page, "Go back").click();
      await expect(group).not.toHaveAttribute("open");
      await expect
        .poll(() => sidebar.evaluate((element) => element.scrollTop))
        .toBeCloseTo(scroll, 0);
    }
  });
}

test("sidebar view state does not leak across communities", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await button(page, "Switch community").click();
  await button(page, "Switch to Secondary").click();
  await expect(button(page, "Switch community")).toHaveAttribute(
    "title",
    "Secondary",
  );
  await expect(group).toHaveAttribute("open");
  await button(page, "Switch community").click();
  await button(page, "Switch to Primary").click();
  await expect(group).not.toHaveAttribute("open");
});

test("legacy filters are ignored and invalid saved sidebar fields fall back", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const group = sidebar.locator("details").first();
  await group.locator("summary").click();
  await button(page, "Home").first().click();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.includes('"channel-sidebar"'),
    );
    if (!key)
      throw new Error("Sidebar state was not saved on leaving Messages");
    localStorage.setItem(
      key,
      JSON.stringify({
        search: "missing-channel",
        collapsed: [null, 42],
        scrollTop: -100,
        width: "wide",
      }),
    );
  });
  await button(page, "Messages").first().click();
  await expect(
    page.getByRole("searchbox", { name: "Search channels" }),
  ).toHaveCount(0);
  await expect(button(page, "Beta")).toBeVisible();
  await expect(sidebar.locator("details").first()).toHaveAttribute("open");
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});
