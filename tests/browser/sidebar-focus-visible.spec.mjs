import { test, expect } from "./fixture.mjs";
import { rail } from "./navigation.mjs";
import { showChannels } from "./rail-helpers.mjs";

test.use({ productionBroker: true, savedSidebar: true, sidebarIcons: true });

// The fixture groups use custom-emoji icons; serve every one as a plain image.
test.beforeEach(({ page }) =>
  page.route("**/media?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    }),
  ),
);

// Why the focused element can't be seen, or "" when it can: every ancestor's
// opacity multiplies, and a point at its center has to land on it, which
// catches clipping, zero size and anything covering it.
function unseen(element) {
  if (!element || element === document.body) return "nothing focused";
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return "no size";
  if (getComputedStyle(element).visibility !== "visible") return "hidden";
  let opacity = 1;
  for (let node = element; node; node = node.parentElement)
    opacity *= parseFloat(getComputedStyle(node).opacity);
  if (opacity < 1) return `opacity ${opacity}`;
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  return hit && element.contains(hit) ? "" : "covered or clipped";
}

// Anything focusable has to be visible while it has focus. Tabbing through
// the rail and Team's list reaches every control, whichever component draws
// it and however it hides at rest, so a control revealed by a rule that can't
// match fails here.
test("every control Tab reaches in the rail and Team's list is visible while focused", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  await page.mouse.move(0, 0);
  // Start at the rail's first control, then establish keyboard modality there.
  await rail(page).evaluate((nav) =>
    nav
      .querySelector('button, a[href], input, [tabindex]:not([tabindex="-1"])')
      .focus(),
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const seen = new Set();
  let quiet = 0;
  for (let stop = 0; stop < 400; stop += 1) {
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      const owner = element?.closest(
        'nav[aria-label="Apps"], [data-activity-sidebar]',
      );
      if (!owner) return null;
      return {
        key: [...document.querySelectorAll("*")].indexOf(element),
        label:
          element.getAttribute("aria-label") ||
          element.textContent.trim().slice(0, 40),
        // A section's grabber hides at rest until keyboard focus reaches it.
        quiet: /^Move .+ section$/.test(element.getAttribute("aria-label")),
      };
    });
    // Focus left the rail and list, or wrapped back to where it started.
    if (!focus || seen.has(focus.key)) break;
    seen.add(focus.key);
    if (focus.quiet) quiet += 1;
    await expect
      .poll(() => page.locator(":focus").evaluate(unseen), {
        message: `focused "${focus.label}" can't be seen`,
      })
      .toBe("");
    await page.keyboard.press("Tab");
  }
  expect(seen.size).toBeGreaterThan(5);
  // Section grabbers that hide at rest were among the stops.
  expect(quiet).toBeGreaterThan(0);
});
