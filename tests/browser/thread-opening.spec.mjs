import { test, expect } from "./fixture.mjs";
import {
  openSettings,
  selectSettingsSection,
  closeSettings,
} from "./navigation.mjs";
import { open } from "./timeline.mjs";

// Real scroll geometry and the first painted frame cannot be proven in jsdom.
test.use({
  pluginFixtures: true,
  exactMessages: true,
  historyCounts: { alpha: 103, beta: 0 },
});
test("ordinary thread reveals its first content already positioned at the bottom", async ({
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
  await page.route("**/api/relay/**/query", async (route) => {
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
    await page.evaluate(() => {
      const sample = () => {
        const el = document.querySelector('[aria-label="Thread messages"]');
        if (el && !el.hasAttribute("data-positioning")) {
          window.firstThreadFrame = {
            top: el.scrollTop,
            gap: el.scrollHeight - el.clientHeight - el.scrollTop,
          };
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
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
  const first = await page.evaluate(() => window.firstThreadFrame);
  expect(first.top).toBeGreaterThan(0);
  expect(Math.abs(first.gap)).toBeLessThanOrEqual(1);
});

// Real geometry proves the saved preference survives the shell focus handoff
// and exposes the root in a long, paginated thread rather than just setting state.
test("Appearance can open a long thread at its first message", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  const choice = page.getByRole("combobox", {
    name: "Open threads at",
    exact: true,
  });
  await choice.click();
  await page
    .getByRole("option", { name: "First message", exact: true })
    .click();
  await expect(choice).toHaveText("First message");
  await closeSettings(page);
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
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
    },
  );
  const history = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(history).not.toHaveAttribute("data-positioning");
  await expect(history.locator("[data-message-id]")).toHaveCount(81);
  await expect(
    history.locator(`[data-message-id="${app.exact.root.id}"]`),
  ).toBeInViewport();
  await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(
    history.getByRole("button", { name: "Jump to latest", exact: true }),
  ).toBeVisible();
  await history
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await expect
    .poll(() =>
      history.evaluate((el) =>
        Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
      ),
    )
    .toBeLessThanOrEqual(1);
});
