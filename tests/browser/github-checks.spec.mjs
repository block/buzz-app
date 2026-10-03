import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
// Real browser wiring: shared keyboard tabs, retained rendered description and
// outcome disclosures, plugin navigation/reset. Result matrices stay in Vitest.
test("standalone PR checks load on activation, retain disclosures, and reset without changing other objects", async ({
  page,
  app,
}) => {
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
                  name: "Unit tests",
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
                head: { sha: "head-sha" },
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
