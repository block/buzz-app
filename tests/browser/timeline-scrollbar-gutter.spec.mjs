import { test, expect } from "./fixture.mjs";
import { open, upper } from "./timeline.mjs";

// The vendored Virtua patch flips the feed to `overflow-y: hidden !important`
// on every nonzero size correction on Mac WebKit. With classic scrollbars that
// removes the scrollbar for a frame, widens the content box, re-wraps rows
// above the viewport, and their new heights feed the next correction. The feed
// must keep the same inline size in both overflow states.
//
// Chromium never runs interruptMomentum (its MacIntel/Apple vendor predicate is
// false there), so this spec does not exercise the loop. It proves the CSS
// invariant the fix depends on by replaying the patch's exact inline toggle and
// restore. Headless Chromium hides scrollbars by default, so drop that flag to
// get platform scrollbars that take space. Playwright's WebKit uses overlay
// scrollbars on macOS; the width case skips there and WebKit only runs the
// toHaveCSS guard. The native manual check on a legacy-scrollbar Mac remains
// the definitive one for the loop itself.
test.use({
  historyCounts: { alpha: 640, beta: 20 },
  // A plain object here would replace the config's launchOptions; merge them.
  launchOptions: async ({ launchOptions }, use) => {
    await use({ ...launchOptions, ignoreDefaultArgs: ["--hide-scrollbars"] });
  },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

test("feed reserves a stable scrollbar gutter", async ({ page, app }) => {
  await open(page, app);
  await expect(history(page)).toHaveCSS("scrollbar-gutter", "stable");
});

test("feed width survives the Virtua overflow toggle", async ({
  page,
  app,
}) => {
  await open(page, app);
  // 640 rows already overflow at the bottom, so decide the skip before paying
  // for the wheel-gesture detach.
  const space = await history(page).evaluate(
    (element) => element.offsetWidth - element.clientWidth,
  );
  test.skip(space === 0, "scrollbar takes no space here (overlay scrollbars)");
  await upper(page);
  const readings = await history(page).evaluate((element) => {
    // Pick the measured paragraph once so all three reads compare the same
    // node even if a state re-wraps enough to change which paragraph fits.
    const bounds = element.getBoundingClientRect();
    const paragraph = Array.from(
      element.querySelectorAll("[data-message-id] p"),
    ).find((p) => {
      const rect = p.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    });
    if (!paragraph) throw new Error("No fully visible message paragraph");
    const read = () => ({
      clientWidth: element.clientWidth,
      paragraphWidth: paragraph.getBoundingClientRect().width,
    });
    const before = read();
    // Mirror patches/virtua@0.51.0.patch interruptMomentum() and its restore.
    const style = element.style;
    const property = "overflow-y";
    const value = style.getPropertyValue(property);
    const priority = style.getPropertyPriority(property);
    style.setProperty(property, "hidden", "important");
    const hidden = read(); // clientWidth forces layout in the hidden state.
    if (value) style.setProperty(property, value, priority);
    else style.removeProperty(property);
    const restored = read();
    return { before, hidden, restored };
  });
  expect(readings.hidden, "hidden overflow keeps the feed width").toEqual(
    readings.before,
  );
  expect(readings.restored, "restored overflow keeps the feed width").toEqual(
    readings.before,
  );
});
