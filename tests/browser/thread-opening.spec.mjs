import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Real scroll geometry and the first painted frame cannot be proven in jsdom.
test.use({
  pluginFixtures: true,
  exactMessages: true,
  historyCounts: { alpha: 103, beta: 0 },
});
test("ordinary read thread reveals its first content already positioned at its root", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.locator('button[data-channel-id="beta"]').click();
  let release, intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  await page.route("**/api/relay/primary/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    )
      return route.continue();
    intercepted();
    await held;
    await route.continue().catch(() => {});
  });
  const history = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  try {
    await page.evaluate(
      (value) => {
        void window.fixtureNavigation.open(value);
      },
      {
        version: 1,
        kind: "conversation",
        channelId: "alpha",
        messageId: app.exact.root.id,
        threadRootId: app.exact.root.id,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      },
    );
    await seen;
    await expect(
      page.locator(
        '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
      ),
    ).toBeFocused();
    await expect(history).toHaveAttribute("data-positioning");
    await expect(history.getByRole("status")).toHaveText("Loading thread…");
    await expect(history.getByRole("status")).toBeInViewport();
    await expect(history.locator("[data-thread-rows]")).toHaveAttribute(
      "inert",
    );
    await expect(history.locator("[data-thread-rows]")).toHaveCSS(
      "opacity",
      "0",
    );
    await page.evaluate((rootId) => {
      const sample = () => {
        const el = document.querySelector('[aria-label="Thread messages"]');
        const root = el?.querySelector(`[data-message-id="${rootId}"]`);
        if (el && root && !el.hasAttribute("data-positioning")) {
          window.firstThreadFrame = {
            rootTop:
              root.getBoundingClientRect().top - el.getBoundingClientRect().top,
          };
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, app.exact.root.id);
  } finally {
    release();
  }
  await expect(history).not.toHaveAttribute("data-positioning");
  await expect(history.locator("[data-thread-rows]")).not.toHaveAttribute(
    "inert",
  );
  await expect(history.locator("[data-message-id]")).toHaveCount(81);
  await expect
    .poll(() => page.evaluate(() => window.firstThreadFrame))
    .toBeTruthy();
  // Nothing is unread and this device left no place, so it opens at the root.
  const first = await page.evaluate(() => window.firstThreadFrame);
  expect(Math.abs(first.rootTop)).toBeLessThanOrEqual(1);
});
