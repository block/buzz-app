import { test, expect } from "./fixture.mjs";
import { openPage, settleShellToggle } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
const url = "https://github.com/example/project/pull/7";
test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "guest",
  channelWriteKinds: [9, 9007, 40100],
  historyCounts: { alpha: 0, beta: 0 },
});

// Real public plugin contribution wiring and persistence in a read-only
// conversation cannot be established by jsdom. Permission/identity matrices
// and announcement races stay in the plugin's unit tests.
test("personal PR in a read-only channel persists without publishing or changing membership", async ({
  page,
  app,
}, info) => {
  await page.route(
    "https://api.github.com/repos/example/project/pulls/7",
    (route) =>
      route.fulfill({
        json: {
          state: "open",
          title: "Release notes",
          draft: false,
          body: "A small improvement.",
          head: {
            sha: "a".repeat(40),
            ref: "feature",
            label: "example:feature",
          },
          base: { ref: "main", label: "example:main" },
          user: { login: "developer" },
        },
      }),
  );
  await page.route(
    /https:\/\/api\.github\.com\/repos\/.*\/(?:comments|reviews)\?/,
    (route) => route.fulfill({ json: [] }),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const row = page.locator(`button[data-channel-id="${channel}"]`);
  await row.click();
  await expect(
    page.getByRole("region", { name: "Read-only channel" }),
  ).toBeVisible();
  await settle(page);
  app.append("primary", channel, `Reference ${url}`, true, false);
  await end(page);
  const link = page.locator(`a[href="${url}"]`).first();
  await link.click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const show = panel.getByRole("button", { name: "Show for me", exact: true });
  await expect(show).toBeVisible();
  const before = [...(app.report.lifecyclePublications ?? [])];
  await show.click();
  await expect(
    panel.getByRole("button", { name: "Hide for me", exact: true }),
  ).toBeVisible();
  const strip = page.getByRole("img", {
    name: /Pull request, open; Checks unknown; Review unknown/,
  });
  await expect(strip).toBeVisible();
  await page.reload();
  await expect(strip).toBeVisible();
  for (const [width, mode, scale] of [
    [1440, "light", 1],
    [390, "dark", 2],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ mode, scale }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.fontSize = `${16 * scale}px`;
      },
      { mode, scale },
    );
    await settleShellToggle(page);
    const toggle = page.locator("[data-shell-sidebar-toggle]");
    if ((await toggle.getAttribute("aria-label"))?.startsWith("Show"))
      await toggle.click();
    await expect(strip).toBeVisible();
    await expect
      .poll(() =>
        strip.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const wrapper = node.parentElement.getBoundingClientRect();
          const native =
            node.parentElement.firstElementChild.getBoundingClientRect();
          return (
            (bounds.left >= native.right || bounds.top >= native.bottom) &&
            bounds.right <= wrapper.right
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`personal-channel-${width}-${mode}.png`),
    });
    await row.focus();
    await row.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row).toBeFocused();
  }
  // Return to the open conversation/panel without changing its read-only role.
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "16px";
  });
  await row.click();
  await page
    .getByRole("button", {
      name: "Open linked pull request, open",
      exact: true,
    })
    .click();
  await panel.getByRole("button", { name: "Hide for me", exact: true }).click();
  await expect(strip).toHaveCount(0);
  expect(app.report.lifecyclePublications ?? []).toEqual(before);
  await expect(
    page.getByRole("region", { name: "Read-only channel" }),
  ).toBeVisible();
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
});
