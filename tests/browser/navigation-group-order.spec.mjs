import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Pointer hit testing, drop-edge geometry and header click suppression need a
// layout engine. Record edits and store supersession stay in Vitest.
test.use({ productionBroker: true, savedSidebar: true, sidebarIcons: true });

const groups = (page) =>
  page
    .locator('[data-sidebar-section^="group:"]')
    .evaluateAll((sections) =>
      sections.map((section) => section.dataset.sidebarSection),
    );
const header = (page, id) =>
  page.locator(`[data-sidebar-section="group:${id}"] summary`);
const orders = (app) => {
  const { blob } = app.report.sidebarPublications.at(-1);
  return Object.fromEntries(
    Object.entries(blob.meta.s).map(([id, node]) => [id, node.order[2]]),
  );
};
// Hold a real pointer drag over another group's header; the caller releases it.
async function pull(page, from, to) {
  const start = await header(page, from).boundingBox();
  const end = await header(page, to).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 8,
  });
}

test("dragging a group header moves the whole group, keeps its state, and persists", async ({
  page,
  app,
}) => {
  // The fixture groups use custom-emoji icons; serve every one as a plain image.
  await page.route("**/media?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    }),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect
    .poll(() => groups(page))
    .toEqual(["group:work", "group:missing", "group:laptop"]);
  const work = page.locator('[data-sidebar-section="group:work"]');
  const laptop = page.locator('[data-sidebar-section="group:laptop"]');
  await header(page, "laptop").click();
  await expect(laptop.locator("details")).not.toHaveAttribute("open");

  // A cancelled drag shows its landing edge, then leaves everything unchanged.
  await pull(page, "laptop", "work");
  await expect(laptop).toHaveAttribute("data-section-dragging");
  await expect(work).toHaveAttribute("data-drop-edge", "before");
  await expect(work).not.toHaveAttribute("data-drop-target");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-drop-edge]")).toHaveCount(0);
  await expect(page.locator("[data-section-dragging]")).toHaveCount(0);
  // Dropping a group on itself is not a move, and its header click is not a toggle.
  const own = await header(page, "laptop").boundingBox();
  const x = own.x + own.width / 2;
  const y = own.y + own.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 40, { steps: 4 });
  await expect(laptop).toHaveAttribute("data-section-dragging");
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("[data-section-dragging]")).toHaveCount(0);
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);

  // Collapsed last group upward to first.
  await pull(page, "laptop", "work");
  await page.mouse.up();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:work", "group:missing"]);
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  expect(orders(app)).toEqual({ laptop: 0, work: 1, missing: 2 });

  // Expanded group with its channel downward to last.
  await pull(page, "work", "missing");
  await expect(
    page.locator('[data-sidebar-section="group:missing"]'),
  ).toHaveAttribute("data-drop-edge", "after");
  await page.mouse.up();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:missing", "group:work"]);
  await expect(work.locator("details")).toHaveAttribute("open");
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  expect(orders(app)).toEqual({ laptop: 0, missing: 1, work: 2 });

  // The section menu is the single-pointer and keyboard path.
  await page.getByRole("button", { name: "More actions for Work" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Move down", exact: true }),
  ).toBeDisabled();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:work", "group:missing"]);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(3);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.reload();
  await openPage(page, "Messages");
  await expect
    .poll(() => groups(page))
    .toEqual(["group:laptop", "group:work", "group:missing"]);
  await expect(laptop.locator("details")).not.toHaveAttribute("open");
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
});
