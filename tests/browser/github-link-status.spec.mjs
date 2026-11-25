import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 30, beta: 0 } });

// A pull request link gains its title when its status arrives, which can wrap
// its message onto another line. A reader at the latest message keeps the rows
// below it where they are, in every painted frame.
test("rows below a PR link stay put when its status arrives", async ({
  page,
  app,
}) => {
  const status = Promise.withResolvers();
  await page.route(
    "https://api.github.com/repos/sample/project/pulls/7",
    async (route) => {
      await status.promise;
      await route.fulfill({
        json: {
          number: 7,
          state: "open",
          title: `Keep the reader in place ${"while a long title wraps ".repeat(4)}`,
          user: { login: "sample-author" },
        },
      });
    },
  );
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  const pull = app.append(
    "primary",
    "alpha",
    "Ready: https://github.com/sample/project/pull/7",
  );
  const later = ["One", "Two", "Three"].map((word) =>
    app.append("primary", "alpha", `${word} after the link`),
  );
  const row = (event) => page.locator(`[data-message-id="${event.id}"]`);
  await expect(row(later.at(-1))).toBeVisible();
  await settle(page);
  const before = await row(pull).evaluate((node) => node.offsetHeight);
  // Sample the rows below the link every frame until well after its status shows.
  const frames = page.evaluate(
    (ids) =>
      new Promise((resolve) => {
        const tops = [];
        let shownAt;
        const tick = () => {
          tops.push(
            ids.map((id) =>
              document
                .querySelector(`[data-message-id="${id}"]`)
                ?.getBoundingClientRect().top,
            ),
          );
          const shown = document.querySelector(
            '[data-channel-timeline] [data-pr-state="open"]',
          );
          shownAt ??= shown ? tops.length : undefined;
          if (shownAt && tops.length > shownAt + 10) resolve(tops);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    later.map((event) => event.id),
  );
  status.resolve();
  const tops = await frames;
  expect(
    await row(pull).evaluate((node) => node.offsetHeight),
  ).toBeGreaterThan(before);
  // Fractional row heights and scroll offsets round to under a pixel.
  const moved = tops.flatMap((frame) =>
    frame.map((top, i) => Math.abs(top - tops[0][i])),
  );
  expect(Math.max(...moved)).toBeLessThan(1);
});
