import { test, expect } from "./fixture.mjs";
import { openSettings, selectSettingsSection } from "./navigation.mjs";

// Browser-only contract: the real settings host fits the editor and rendered
// diff in both themes/widths, and keyboard editing persists across a reload.
// Save failures and the input matrix belong to BasePromptSettings.test.tsx.
test.use({ historyCounts: { alpha: 1, beta: 0 } });

test("advanced base prompt edits replace the default, with a persistent visual diff", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Agent setup");
  const disclosure = page.getByRole("button", {
    name: "Base prompt",
    exact: true,
  });
  await disclosure.click();
  const editor = page.getByRole("textbox", { name: "Base prompt replacement" });
  const original = page.getByRole("textbox", { name: "Bundled original" });
  const bundled = await original.inputValue();
  expect(bundled).toContain("Co-authored-by");
  const custom = bundled
    .split("\n")
    .filter((line) => !line.includes("Co-authored-by"))
    .join("\n");
  await editor.fill(custom);
  const diff = page.getByRole("region", { name: "Base prompt diff" });
  await expect(diff.locator(".diff-code-delete")).toBeVisible();
  await expect(original).toHaveValue(bundled);
  await page
    .getByRole("button", { name: "Save base prompt", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Custom base prompt saved" }),
  ).toBeVisible();
  await page.reload();
  // Settings and its section restore through addressable navigation history.
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(editor).toHaveValue(custom);
  await expect(diff.locator(".diff-code-delete")).toBeVisible();

  for (const mode of ["light", "dark"]) {
    for (const width of [1440, 480]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        ({ mode, width }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.fontSize =
            width === 480 ? "20px" : "16px";
        },
        { mode, width },
      );
      // Expansion and responsive reflow must finish before scrolling; an
      // initially clipped panel does not yet contribute to the host scrollport.
      await expect
        .poll(() =>
          diff.evaluate((node) => {
            const panel = node.closest(".buzz-accordion-panel");
            return (
              Math.abs(
                panel.getBoundingClientRect().height - panel.scrollHeight,
              ) < 2
            );
          }),
        )
        .toBe(true);
      await diff.scrollIntoViewIfNeeded();
      await expect(diff).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${mode}-${width}.png`),
      });
    }
  }
  await editor.focus();
  await expect(editor).toBeFocused();
  await page
    .getByRole("button", { name: "Restore bundled default", exact: true })
    .click();
  await expect(editor).toHaveValue(bundled);
  await expect(diff).toHaveText(/No changes from the bundled default/);
});
