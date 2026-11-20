import { test, expect } from "./fixture.mjs";

// Twenty Solo chats: Solo lists its newest seven, then steps by ten.
const chats = Array.from(
  { length: 20 },
  (_, index) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
);
test.use({
  productionBroker: true,
  channelIds: [...chats, "beta"],
  channelNames: {
    ...Object.fromEntries(chats.map((id, index) => [id, `Chat ${index}`])),
    beta: "Beta",
  },
  soloChannels: chats,
  ownSoloChannels: chats,
});

// Real paint geometry: both actions start at the row titles, share a line
// when it fits and stack at the same edge at the minimum sidebar width.
test("Show more and Show fewer start at the row titles and stack at the minimum width", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 1400 });
  await page.goto(app.origin);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const section = sidebar.locator('[data-sidebar-section="solo"]');
  const more = (count) =>
    section.getByRole("button", { name: `Show ${count} more in Solo` });
  const fewer = section.getByRole("button", { name: "Show fewer in Solo" });
  await expect(more(10)).toBeVisible();
  await expect(fewer).toHaveCount(0);
  const geometry = () =>
    section.evaluate((root) => {
      const title = [...root.querySelectorAll("[data-channel-id]")]
        .find((row) => row.getClientRects().length)
        ?.querySelector(".navigation-item-label")
        ?.getBoundingClientRect();
      const actions = [
        ...root.querySelectorAll(
          "[data-section-show-more] .navigation-item-label",
        ),
      ].map((label) => {
        const rect = label.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          clipped: label.scrollWidth > label.clientWidth + 0.5,
          inside: rect.right <= root.getBoundingClientRect().right + 0.5,
        };
      });
      return { title: title?.left, actions };
    });
  const aligned = async (count) => {
    const { title, actions } = await geometry();
    expect(actions).toHaveLength(count);
    for (const action of actions) {
      // Each line of actions starts at the row titles.
      if (action === actions[0] || action.top > actions[0].top + 1)
        expect(Math.abs(action.left - title)).toBeLessThan(1);
      expect(action.clipped).toBe(false);
      expect(action.inside).toBe(true);
    }
    return actions;
  };
  await aligned(1);

  await more(10).click();
  await expect(more(3)).toBeVisible();
  await expect(fewer).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const width = () =>
    sidebar.evaluate((aside) => aside.getBoundingClientRect().width);
  // A wide sidebar fits both actions on one line, Show more first.
  await handle.focus();
  await handle.press("End");
  await expect.poll(width).toBeGreaterThan(500);
  await page.mouse.move(600, 600);
  const [wideMore, wideFewer] = await aligned(2);
  expect(Math.abs(wideMore.top - wideFewer.top)).toBeLessThan(1);
  expect(wideFewer.left).toBeGreaterThan(wideMore.left);

  await handle.focus();
  await handle.press("Home");
  await expect.poll(width).toBeLessThanOrEqual(221);
  await page.mouse.move(600, 600);
  const [narrowMore, narrowFewer] = await aligned(2);
  expect(narrowFewer.top).toBeGreaterThan(narrowMore.top);
  await section.locator("[data-section-show-more]").scrollIntoViewIfNeeded();
  const shot = testInfo.outputPath("show-more-220.png");
  await sidebar.screenshot({ path: shot });
  await testInfo.attach("show-more-220", {
    path: shot,
    contentType: "image/png",
  });

  await more(3).click();
  await expect(fewer).toBeFocused();
  await aligned(1);
  await fewer.click();
  await expect(more(10)).toBeFocused();
  await aligned(1);
});
