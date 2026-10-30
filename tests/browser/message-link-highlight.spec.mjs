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
for (const destination of ["thread", "channel", "agents"]) {
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
          : destination === "agents"
            ? app.append(
                "primary",
                "alpha",
                "Agent coordination target",
                true,
                false,
                undefined,
                undefined,
                [["audience", "agents"]],
              )
            : app.histories.get("primary/beta")[0];
      const channel = destination === "channel" ? "beta" : "alpha";
      const message = app.append(
        "primary",
        "alpha",
        `Open <buzz://message?channel=${channel}&id=${target.id}>.`,
      );
      const link = page
        .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
        .getByRole("link");
      await expect(link).toBeVisible();
      await page.clock.install();
      await virtuaIdle(page);
      if (mode === "dark") await link.click();
      else await link.press("Enter");
      const reader =
        destination === "thread"
          ? page.getByRole("complementary", { name: "Thread", exact: true })
          : page.locator(`[data-channel-timeline=${channel}]`);
      const row = reader.locator(`[data-message-id="${target.id}"]`);
      await expect(row).toBeInViewport();
      await expect(row).toBeFocused();
      const messageBody =
        destination === "agents" ? row : row.locator(":scope > [data-layout]");
      const paint = () =>
        messageBody.evaluate((element) => {
          const style = getComputedStyle(element, "::after");
          return {
            background: style.backgroundColor,
            outline: style.outlineStyle,
            width: style.outlineWidth,
            animation: style.animationName,
            content: style.content,
          };
        });
      await expect.poll(paint).toMatchObject({
        outline: "solid",
        width: "2px",
        animation: "none",
      });
      const cue = await paint();
      expect(
        await row.evaluate((element) => getComputedStyle(element).outlineStyle),
      ).toBe("none");
      expect(cue.background).not.toBe("rgba(0, 0, 0, 0)");
      await page.clock.fastForward(5000);
      expect(await paint()).toEqual(cue);
      if (process.env.BUZZ_CAPTURE_HIGHLIGHT)
        await page.screenshot({
          path: testInfo.outputPath(`highlight-${destination}-${mode}.png`),
        });
      await page.keyboard.press("Escape");
      await expect(page.locator('[class*="linkedHighlight"]')).toHaveCount(0);
      const reopen = async () => {
        if (destination === "channel") await page.goBack();
        await link.press("Enter");
        await expect(row).toBeFocused();
        await expect.poll(paint).toEqual(cue);
      };
      await reopen();
      await page.mouse.click(5, 5);
      await expect.poll(paint).toMatchObject({ content: "none" });
      if (destination === "agents") {
        await row.getByRole("button").click();
        await expect(
          row.getByText("Agent coordination target", { exact: true }),
        ).toBeVisible();
      }
      await reopen();
      await page.goBack();
      await expect(page.locator('[class*="linkedHighlight"]')).toHaveCount(0);
    });
  }
}
