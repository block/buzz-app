import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
// Real browser wiring: shared keyboard tabs, retained rendered description and
// outcome disclosures, hover/focus menus and narrow reflow, plugin navigation/reset.
// Clipboard results and source/URL matrices stay in Vitest.
test("standalone PR checks load on activation, retain disclosures, and reset without changing other objects", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.copiedCheckLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (url) => window.copiedCheckLinks.push(url) },
    });
  });
  const requests = [];
  const targets = [
    "https://github.com/sample/project/pull/1",
    "https://github.com/sample/project/pull/2",
    "https://github.com/sample/project/issues/3",
  ];
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      return route.fulfill({
        json: path.endsWith("/check-runs")
          ? {
              total_count: 1,
              check_runs: [
                {
                  name: path.includes("head-sha-long")
                    ? `Unit tests / ${"long-check-name-".repeat(12)}`
                    : "Unit tests",
                  status: "completed",
                  conclusion: "success",
                  details_url:
                    "https://github.com/sample/project/actions/runs/1",
                  output: { title: "All tests passed" },
                },
              ],
            }
          : path.endsWith("/status")
            ? {
                total_count: 1,
                statuses: [
                  {
                    context: "Build",
                    state: "failure",
                    description: "Compilation failed",
                  },
                ],
              }
            : {
                title: path.endsWith("/1")
                  ? "First PR"
                  : path.endsWith("/2")
                    ? "Second PR"
                    : "Existing issue",
                body: "Main description\n\n## Details",
                body_html: "<p>Main description</p><h2>Details</h2>",
                head: {
                  sha: path.endsWith("/2") ? "head-sha-long" : "head-sha",
                },
                comments: 2,
              },
      });
    },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", targets.join(" "));
  const link = (url) => page.locator(`a[href="${url}"]`);
  await expect(link(targets[0])).toBeAttached();
  await end(page);
  await link(targets[0]).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const discussion = panel.getByRole("tab", {
    name: "Discussion",
    exact: true,
  });
  const checksTab = panel.getByRole("tab", { name: "Checks", exact: true });
  const description = panel.getByRole("tabpanel", {
    name: "Discussion",
    exact: true,
  });
  await expect(
    description.getByRole("heading", { name: "Details" }),
  ).toBeVisible();
  await expect(discussion).toHaveAttribute("aria-selected", "true");
  await settle(page); // description/details mount is the completed loading boundary
  expect(requests).toEqual(["/repos/sample/project/pulls/1"]);
  const details = await description
    .getByRole("heading", { name: "Details" })
    .elementHandle();
  await discussion.focus();
  await page.keyboard.press("ArrowRight");
  await expect(checksTab).toBeFocused();
  await expect(checksTab).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(checksTab).toHaveAttribute("aria-selected", "true");
  const checks = panel.getByRole("tabpanel", { name: "Checks", exact: true });
  await expect(checks).toContainText("Some checks were not successful");
  await expect(checks.getByRole("listitem")).toHaveCount(2);
  const spacing = await panel.locator('[class*="pullTabs"]').evaluate((n) => {
    const tabs = n.querySelector('[role="tablist"]').getBoundingClientRect();
    const previous = n.previousElementSibling.getBoundingClientRect();
    const card = n.parentElement
      .querySelector('[class*="checksCard"]')
      .getBoundingClientRect();
    return {
      before: tabs.top - previous.bottom,
      after: card.top - tabs.bottom,
    };
  });
  expect(spacing.before).toBe(20);
  expect(spacing.after).toBe(20);
  const row = checks.getByRole("listitem").filter({ hasText: "Unit tests" });
  const actions = row.getByRole("button", { name: "Actions for Unit tests" });
  const actionSlot = actions.locator("..");
  const rowLink = row.getByRole("link", { name: "Unit tests", exact: true });
  await page.mouse.move(0, 0);
  await expect(actionSlot).toHaveCSS("opacity", "0");
  const before = await rowLink.boundingBox();
  await row.hover();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  expect(await rowLink.boundingBox()).toEqual(before);
  await actions.click();
  const item = page.getByRole("menuitem", { name: "Copy link", exact: true });
  await expect(item).toBeVisible();
  await expect(page.getByRole("menu")).toHaveAttribute("data-size", "default");
  await page.mouse.move(0, 0);
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(actions).toBeFocused();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Link copied", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.copiedCheckLinks)).toEqual([
    "https://github.com/sample/project/actions/runs/1",
  ]);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(
    checks.getByRole("button", { name: "1 successful check", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    checks.getByRole("button", { name: "Actions for Build" }),
  ).toHaveCount(0);

  // A long unbroken name plus 200% interface text must leave the menu reachable.
  // Change the fixture response on the next PR rather than mutating rendered content.
  const successful = checks.getByRole("button", {
    name: "1 successful check",
    exact: true,
  });
  await successful.click();
  await expect(successful).toHaveAttribute("aria-expanded", "false");
  await checksTab.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(description).toBeVisible();
  expect(await details.evaluate((node) => node.isConnected)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(successful).toHaveAttribute("aria-expanded", "false");
  await settle(page);
  expect(requests).toHaveLength(3);
  await successful.click();
  await expect(
    checks.getByRole("link", { name: "Unit tests" }),
  ).toHaveAttribute("href", "https://github.com/sample/project/actions/runs/1");
  await link(targets[1]).click();
  await expect(
    panel.getByRole("heading", { name: "Second PR", exact: true }),
  ).toBeVisible();
  await expect(discussion).toHaveAttribute("aria-selected", "true");
  await settle(page);
  expect(requests).toHaveLength(4);
  await checksTab.click();
  await expect(checks.getByRole("listitem")).toHaveCount(2);
  await expect(successful).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await page.setViewportSize({ width: 480, height: 950 });
  const longRow = checks
    .getByRole("listitem")
    .filter({ hasText: "long-check-name-" });
  const longAction = longRow.getByRole("button", {
    name: /^Actions for Unit tests/,
  });
  await longAction.scrollIntoViewIfNeeded();
  await longAction.focus();
  await expect(longAction.locator("..")).toHaveCSS("opacity", "1");
  const bounds = await longRow.boundingBox();
  const buttonBounds = await longAction.boundingBox();
  expect(buttonBounds.x).toBeGreaterThanOrEqual(bounds.x);
  expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(
    bounds.x + bounds.width + 1,
  );
  expect(
    await longRow.evaluate((n) => n.scrollWidth - n.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.keyboard.press("Enter");
  await expect(item).toBeVisible();
  const menuBounds = await page.getByRole("menu").boundingBox();
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(480);
  await page.keyboard.press("Escape");
  await expect(longAction).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "1");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await link(targets[2]).click();
  await expect(
    panel.getByRole("heading", { name: "Existing issue", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Details" })).toBeVisible();
  await settle(page);
  expect(requests).toHaveLength(7);
  await expect(panel.getByRole("tablist")).toHaveCount(0);
  await expect(panel.getByText("Comments", { exact: true })).toBeVisible();
});
