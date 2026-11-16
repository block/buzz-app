import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { open } from "./timeline.mjs";
import { animationsSettled } from "./animations.mjs";

test.use({ historyCounts: { alpha: 3, beta: 0 } });

// Browser-only: prove selected-tab wiring reaches the virtualized row and that
// its painted fill matches hover in both density/theme recipes.
for (const density of ["default", "compact"]) {
  for (const theme of ["light", "dark"]) {
    test(`side thread keeps the ${density} ${theme} hover treatment on its original`, async ({
      page,
      app,
    }, testInfo) => {
      await page.addInitScript(
        ({ density, theme }) => {
          localStorage.setItem("buzz-message-density.v1", density);
          localStorage.setItem("buzz-appearance.v1", theme);
        },
        { density, theme },
      );
      await open(page, app);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        theme,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-message-density",
        density,
      );
      const events = [
        app.append(
          "primary",
          "alpha",
          "Can we keep the original message highlighted while its thread is open?",
          true,
          true,
        ),
        app.append(
          "primary",
          "alpha",
          "Yes — the highlight follows the thread you are reading.",
          true,
          false,
        ),
      ];
      const row = (event) =>
        page.locator(`[data-channel-timeline] [data-message-id="${event.id}"]`);
      const surface = (event) =>
        row(event).locator("[data-highlight-surface]").first();
      const fill = (event) =>
        row(event).evaluate((item, density) => {
          const surface = item.querySelector("[data-highlight-surface]");
          const style =
            density === "compact"
              ? getComputedStyle(surface, "::before")
              : getComputedStyle(
                  surface.querySelector("[data-message-action-anchor]"),
                );
          return [style.backgroundColor, style.opacity];
        }, density);
      const resting = [];
      for (const event of events) {
        await expect(surface(event)).toBeVisible();
        resting.push(await fill(event));
        await hoverMessage(row(event));
        await expect(surface(event)).toHaveAttribute("data-actions-revealed");
        const hovered = await fill(event);
        expect(hovered).not.toEqual(resting.at(-1));
        const reply = row(event).getByRole("button", {
          name: "Reply",
          exact: true,
        });
        await reply.focus();
        await reply.press("Enter");
        await expect(
          page.getByRole("textbox", { name: "Reply to thread", exact: true }),
        ).toBeFocused();
        await page.mouse.move(0, 0);
        await expect(surface(event)).toHaveAttribute("data-thread-open");
        await expect.poll(() => fill(event)).toEqual(hovered);
      }
      await expect(surface(events[0])).not.toHaveAttribute("data-thread-open");
      await expect(surface(events[1])).toHaveAttribute("data-thread-open");
      await expect.poll(() => fill(events[0])).toEqual(resting[0]);
      // Selecting a retained thread with the pointer moves the marker too.
      const tab = (event) =>
        page.locator(`[role="tab"][data-tab-value="thread:alpha:${event.id}"]`);
      await tab(events[0]).click();
      await expect(surface(events[0])).toHaveAttribute("data-thread-open");
      await expect(surface(events[1])).not.toHaveAttribute("data-thread-open");
      await tab(events[1]).click();
      await page.mouse.move(0, 0);
      await animationsSettled(page.locator("body"), { subtree: true });
      await page.screenshot({
        path: testInfo.outputPath("thread-highlight.png"),
      });
    });
  }
}
