import { test, expect } from "./source-fixture.mjs";

// Real layout and pointer hit-testing: jsdom action tests cannot catch the
// trigger losing its trailing alignment when the menu mounts portal helpers.
test("PR action menu keeps its trigger in place while opening and closing", async ({
  page,
}) => {
  for (const state of ["", "?ready"]) {
    await page.goto(`/tests/fixtures/github-actions.html${state}`);
    const trigger = page.getByRole("button", {
      name: "More pull request actions",
    });
    await expect(trigger).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const [width, scale] of [
      [1000, 1],
      [480, 2],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          ({ theme, scale }) => {
            document.documentElement.dataset.colorMode = theme;
            document.documentElement.style.fontSize = `${16 * scale}px`;
          },
          { theme, scale },
        );
        await trigger.scrollIntoViewIfNeeded();
        const before = await trigger.boundingBox();
        await trigger.click();
        const item = page.getByRole("menuitem", { name: "Convert to draft" });
        await expect(item).toBeVisible();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(await trigger.boundingBox()).toEqual(before);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(await trigger.boundingBox()).toEqual(before);
        await trigger.press("ArrowDown");
        await expect(page.getByRole("menuitem").first()).toBeFocused();
        expect(await trigger.boundingBox()).toEqual(before);
        await trigger.click();
        await expect(page.getByRole("menu")).toHaveCount(0);
        expect(await trigger.boundingBox()).toEqual(before);
      }
    }
  }
});
