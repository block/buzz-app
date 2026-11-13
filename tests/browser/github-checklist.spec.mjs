import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";
import { apcaContrast, wcagRatio } from "../../scripts/design-system/apca.mjs";

function computedHex(color) {
  const match = /^rgb\(\s*(\d+)(?:,\s*|\s+)(\d+)(?:,\s*|\s+)(\d+)\s*\)$/.exec(
    color,
  );
  if (!match) throw new Error(`Expected an opaque computed color: ${color}`);
  return `#${match
    .slice(1)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

const punctuatedLabel = "area: checkout / release automation";
const longLabel = "long-unbroken-label-without-word-breaks-0123456789abcdef";
const renderedNames = [
  "documentation",
  "ready for review",
  punctuatedLabel,
  longLabel,
  "maintenance",
];
const publicLabels = [
  {
    node_id: "LA_documentation",
    name: "documentation",
    color: "0969da",
  },
  {
    node_id: "LA_review",
    name: "ready for review",
    color: "0e8a16",
  },
  {
    node_id: "LA_area",
    name: punctuatedLabel,
    color: "d4c5f9",
  },
  {
    node_id: "LA_long",
    name: longLabel,
    color: "f9e2d0",
  },
  {
    node_id: "LA_neutral",
    name: "maintenance",
    color: null,
  },
];

test.use({ historyCounts: { alpha: 1, beta: 0 } });
// Real browser layout: the public checklist row with linked failing checks
// wraps inside a narrow pane. gh-backed rows and actions stay in Vitest.
test("a PR opens on its checklist, with failing checks linked and wrapping in a narrow pane", async ({
  page,
  app,
}, testInfo) => {
  const target = "https://github.com/sample/project/pull/1";
  const requests = [];
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      return route.fulfill({
        json: path.endsWith("/check-runs")
          ? {
              total_count: 2,
              check_runs: [
                {
                  name: `Browser journeys / ${"long-check-name-".repeat(6)}`,
                  status: "completed",
                  conclusion: "failure",
                  details_url:
                    "https://github.com/sample/project/actions/runs/1",
                },
                {
                  name: "Unit tests",
                  status: "completed",
                  conclusion: "success",
                },
              ],
            }
          : path.endsWith("/status")
            ? { total_count: 0, statuses: [] }
            : {
                title: "First PR",
                state: "open",
                body: "Main description\n\n## Details",
                body_html: "<p>Main description</p><h2>Details</h2>",
                head: { sha: "head-sha" },
                labels: publicLabels,
              },
      });
    },
  );
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", target);
  const link = page.locator(`[data-message-id] a[href="${target}"]`);
  // The inline link reads its state once before the panel opens.
  await expect(link).toHaveAccessibleDescription("Pull request, open");
  await end(page);
  await link.click();
  // Opening the panel reflows the timeline under the resting pointer, and the
  // viewer's avatar crosses it before the panel covers that point. A slow
  // runner can hold it there past the hover delay, and the opened profile
  // preview then covers the checklist. The next step moves the pointer anyway.
  await page.mouse.move(0, 0);
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const checklist = panel.getByRole("list", {
    name: "Pull request checklist",
  });
  const labelHeading = panel.getByText("Labels", { exact: true });
  const labelsRow = labelHeading.locator("..");
  const labelList = checklist.getByRole("list", {
    name: "Labels",
    exact: true,
  });
  const labelItems = labelList.getByRole("listitem");
  await expect(labelItems).toHaveText(renderedNames);
  await expect(labelsRow.getByRole("button")).toHaveCount(0);
  expect(
    await checklist
      .locator(":scope > li")
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelector(":scope > span")?.textContent),
      ),
  ).toEqual(["Checks", "Labels"]);
  const checks = checklist
    .getByRole("listitem")
    .filter({ has: page.getByText("Checks", { exact: true }) });
  await expect(checks).toHaveText(/1 failed · 1 passed/);
  await expect(
    checks.getByRole("link", { name: /^Browser journeys/ }),
  ).toHaveCount(0);
  await checks.getByRole("button", { name: "1 failed · 1 passed" }).click();
  await expect(checks).toHaveAttribute("data-tone", "failure");
  await expect(
    checks.getByRole("link", { name: /^Browser journeys/ }),
  ).toHaveAttribute("href", "https://github.com/sample/project/actions/runs/1");
  await expect
    .poll(() =>
      checklist.evaluate((node) => node.scrollWidth <= node.clientWidth),
    )
    .toBe(true);
  // The description is readable alongside the checklist without expanding it.
  await expect(panel.getByRole("heading", { name: "Details" })).toBeVisible();
  // The pull request is read for the inline link's state and for the panel.
  expect([...requests].sort()).toEqual([
    "/repos/sample/project/commits/head-sha/check-runs",
    "/repos/sample/project/commits/head-sha/status",
    "/repos/sample/project/pulls/1",
    "/repos/sample/project/pulls/1",
  ]);
  await page.evaluate(() => document.fonts.ready);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await panel.screenshot({
      path: testInfo.outputPath(`github-checklist-${mode}.png`),
    });
  }
});

test("public labels wrap in both host themes and preserve partial data with a usable PR link", async ({
  page,
  app,
}, testInfo) => {
  const target = "https://github.com/sample/project/pull/1";
  await page.context().route(target, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>External destination</title>",
    }),
  );
  await page.route(
    "https://api.github.com/repos/sample/project/pulls/1",
    (route) =>
      route.fulfill({
        json: {
          title: "Partial labels",
          state: "open",
          labels: [
            ...publicLabels,
            { node_id: null, name: "cannot be identified", color: "0e8a16" },
          ],
        },
      }),
  );
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", target);
  const messageLink = page.locator(`[data-message-id] a[href="${target}"]`);
  await expect(messageLink).toHaveAccessibleDescription("Pull request, open");
  await end(page);
  await messageLink.click();
  await page.mouse.move(0, 0);
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const checklist = panel.getByRole("list", {
    name: "Pull request checklist",
  });
  const labels = panel.getByRole("list", { name: "Labels", exact: true });
  const labelItems = labels.getByRole("listitem");
  await expect(labelItems).toHaveText(renderedNames);
  await expect(panel.getByText(/Not all labels loaded/)).toBeVisible();
  const labelsRow = panel.getByText("Labels", { exact: true }).locator("..");
  await page.evaluate(() => document.fonts.ready);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1100, 760, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          checklist.evaluate((node) => node.scrollWidth <= node.clientWidth),
        )
        .toBe(true);
      for (const item of await labelItems.all()) {
        await expect
          .poll(() =>
            item.evaluate((node) => node.scrollWidth <= node.clientWidth),
          )
          .toBe(true);
        const { name, ink, fill } = await item.evaluate((node) => {
          const computed = getComputedStyle(node);
          return {
            name: node.textContent,
            ink: computed.color,
            fill: computed.backgroundColor,
          };
        });
        const ratio = wcagRatio(computedHex(ink), computedHex(fill));
        const apca = Math.abs(
          apcaContrast(computedHex(ink), computedHex(fill)),
        );
        expect(
          ratio,
          `${mode}/${width}px: ${name} WCAG`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(apca, `${mode}/${width}px: ${name} APCA`).toBeGreaterThanOrEqual(
          45,
        );
      }
      if (width === 320) {
        await expect
          .poll(() =>
            labelsRow.evaluate((row) => {
              const heading = row.querySelector(":scope > span");
              const content = row.querySelector(":scope > div");
              return (
                heading &&
                content &&
                content.getBoundingClientRect().top >=
                  heading.getBoundingClientRect().bottom
              );
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            labelItems.nth(3).evaluate((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              return range.getClientRects().length;
            }),
          )
          .toBeGreaterThan(1);
      }
      await panel.screenshot({
        path: testInfo.outputPath(`github-checklist-${mode}-${width}.png`),
      });
    }
  }
  const external = panel.getByRole("link", {
    name: "View all labels on GitHub",
    exact: true,
  });
  await page.setViewportSize({ width: 900, height: 900 });
  const openExternal = async (activate) => {
    const opened = page.waitForEvent("popup");
    await activate();
    const destination = await opened;
    await destination.waitForLoadState();
    expect(destination.url()).toBe(target);
    expect(await destination.evaluate(() => window.opener === null)).toBe(true);
    await destination.close();
  };
  await openExternal(() => external.click());
  await external.focus();
  await expect(external).toBeFocused();
  await openExternal(() => external.press("Enter"));
  await expect(panel).toBeVisible();
});
