import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({
  largeSidebar: true,
  historyCounts: { alpha: 1, beta: 1 },
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
      }),
    );
  });
  await button(page, "Messages").first().click();
  await expect(
    page.getByRole("searchbox", { name: "Search channels" }),
  ).toHaveCount(0);
  await expect(button(page, "Beta")).toBeVisible();
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect(sidebar.locator("details").first()).toHaveAttribute("open");
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});
