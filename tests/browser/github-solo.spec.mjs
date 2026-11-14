import { test, expect } from "./fixture.mjs";
import { newChat, settleShellToggle } from "./navigation.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
const url = "https://github.com/example/project/pull/7";
test.use({
  productionBroker: true,
  channelIds: [chat],
  channelNames: { [chat]: "Keep the release notes readable" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  historyCounts: { [chat]: 0 },
});

// Real host contribution wiring, row/menu hit targets and focusable tooltips
// cannot be established by jsdom. Status combinations stay in the unit tests.
test("linked Solo keeps native row interactions and honest public-only status", async ({
  page,
  app,
}, info) => {
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    const filter = filters.find(
      (filter) => filter.kinds?.includes(45010) && filter["#h"]?.includes(chat),
    );
    if (!filter) return route.continue();
    return route.fulfill({
      json: [
        app.sign({
          kind: 45010,
          created_at: 1,
          content: JSON.stringify({ version: 1, url }),
          tags: [
            ["ar", "1"],
            ["d", filter["#d"][0]],
            ["h", chat],
            ["type", "buzz.solo.pr"],
            ["title", "Pull request"],
            ["op", "create"],
          ],
        }),
      ],
    });
  });
  await page.route(
    "https://api.github.com/repos/example/project/pulls/7",
    (route) =>
      route.fulfill({
        json: {
          state: "open",
          title: "Release notes",
          draft: false,
        },
      }),
  );
  await page.goto(app.origin);
  await newChat(page);
  const row = page.locator(`[data-solo-channel-id="${chat}"]`);
  const strip = page.getByRole("img", {
    name: /Checks unknown; Review unknown; Discussion unknown; Merge readiness unknown/,
  });
  await expect(strip).toBeVisible();
  await expect(row).toContainText("Pull request, open");
  await row.focus();
  await row.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Rename", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  for (const [width, mode, scale] of [
    [1440, "light", "1"],
    [390, "dark", "2"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ mode, scale }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.fontSize = `${16 * Number(scale)}px`;
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
            bounds.right <= wrapper.right &&
            wrapper.width > 0
          );
        }),
      )
      .toBe(true);
    await strip.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(strip).toBeFocused();
    await expect(page.getByRole("tooltip")).toContainText(
      "does not replace your workflow",
    );
    await page.screenshot({
      path: info.outputPath(`linked-solo-${width}-${mode}.png`),
    });
    await page.keyboard.press("Escape");
    await row.hover();
    await expect
      .poll(() =>
        row.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return (
            document
              .elementFromPoint(
                bounds.left + bounds.width / 2,
                bounds.top + bounds.height / 2,
              )
              ?.closest("[data-solo-channel-id]") === node
          );
        }),
      )
      .toBe(true);
    await page
      .getByRole("button", {
        name: "Actions for Keep the release notes readable",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Rename", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
