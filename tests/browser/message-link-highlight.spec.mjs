import { test, expect } from "./fixture.mjs";
import { open, virtuaIdle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser coverage owns real virtual-row placement and the painted pseudo-element.
// Request lifecycle and cancellation permutations stay in the reveal-hook tests.
for (const destination of ["thread", "channel"]) {
  for (const mode of ["light", "dark"]) {
    test(`message links highlight the ${destination} target in ${mode}`, async ({
      page,
      app,
    }, testInfo) => {
      await page.setViewportSize({
        width: mode === "dark" ? 600 : 1280,
        height: 720,
      });
      await page.emulateMedia({
        reducedMotion: mode === "dark" ? "reduce" : "no-preference",
      });
      await page.addInitScript((mode) => {
        localStorage.setItem("buzz-appearance.v1", mode);
        localStorage.setItem("buzz-font-scale.v1", "1.3");
      }, mode);
      await open(page, app);
      const target =
        destination === "thread"
          ? app.histories
              .get("primary/alpha")
              .find((event) => event.content === "Broadcast reply")
          : app.histories.get("primary/beta")[0];
      const channel = destination === "thread" ? "alpha" : "beta";
      const message = app.append(
        "primary",
        "alpha",
        `Open <buzz://message?channel=${channel}&id=${target.id}>.`,
      );
      const link = page
        .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
        .getByRole("link");
      await expect(link).toBeVisible();
      await page.evaluate(
        ({ id, capture }) => {
          window.targetCues = [];
          document.addEventListener("animationstart", (event) => {
            if (
              event.pseudoElement !== "::after" ||
              event.target.closest("[data-message-id]")?.dataset.messageId !==
                id
            )
              return;
            const style = getComputedStyle(event.target, "::after");
            window.targetCues.push({
              background: style.backgroundColor,
              opacity: style.opacity,
            });
            if (capture)
              for (const animation of event.target.getAnimations())
                animation.pause();
          });
        },
        { id: target.id, capture: !!process.env.BUZZ_CAPTURE_HIGHLIGHT },
      );
      await virtuaIdle(page);
      if (mode === "dark") await link.click();
      else await link.press("Enter");
      const reader =
        destination === "thread"
          ? page.getByRole("complementary", { name: "Thread", exact: true })
          : page.locator("[data-channel-timeline=beta]");
      const row = reader.locator(`[data-message-id="${target.id}"]`);
      await expect(row).toBeInViewport();
      await expect
        .poll(() => page.evaluate(() => window.targetCues.length))
        .toBe(1);
      const [cue] = await page.evaluate(() => window.targetCues);
      expect(cue.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(Number(cue.opacity)).toBeGreaterThan(0);
      if (process.env.BUZZ_CAPTURE_HIGHLIGHT) {
        await page.screenshot({
          path: testInfo.outputPath(`highlight-${destination}-${mode}.png`),
        });
        await row.evaluate((element) => {
          for (const animation of element.getAnimations({ subtree: true }))
            animation.play();
        });
      }
      await expect
        .poll(() =>
          row
            .locator(":scope > [data-layout]")
            .evaluate(
              (element) => getComputedStyle(element, "::after").animationName,
            ),
        )
        .toBe("none");
    });
  }
}
