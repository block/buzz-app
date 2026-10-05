import { test, expect } from "./fixture.mjs";
import {
  chooseColorMode,
  selectSettingsSection,
  settleShellToggle,
} from "./navigation.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 0, beta: 0 },
});

// Browser contract: modal headers, disclosed controls, and wrapping actions stay
// reachable across themes/widths. Save, failure, and disclosure state use RTL.
test("template dialogs keep headers and optional setup contained across layouts", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  await page
    .getByRole("switch", { name: "Enable Templates & teams", exact: true })
    .check();
  for (const mode of ["light", "dark"]) {
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await settleShellToggle(page);
      const showNavigation = page.getByRole("button", {
        name: "Show navigation",
        exact: true,
      });
      if (await showNavigation.isVisible()) await showNavigation.click();
      await page
        .getByRole("complementary", { name: "Settings sidebar" })
        .getByRole("button", { name: "Templates & teams", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Templates and teams settings" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "No templates or teams yet" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Manage templates & teams", exact: true })
        .click();
      const library = page.getByRole("dialog", {
        name: "Templates & teams",
        exact: true,
      });
      await expect(library).toHaveAccessibleDescription(
        /Private to you in this community/,
      );
      await expect(
        library.getByText("No templates yet", { exact: true }),
      ).toBeVisible();
      await contained(library);
      await expect(library).toHaveCSS("backdrop-filter", "blur(8px)");
      await expect(library).toHaveCSS(
        "background-color",
        mode === "light" ? "rgba(255, 255, 255, 0.9)" : "rgba(40, 40, 40, 0.9)",
      );
      if (width === 1440)
        await library.screenshot({
          path: info.outputPath(`library-${mode}.png`),
        });
      await library
        .getByRole("button", { name: "New template", exact: true })
        .click();
      const editor = page.getByRole("dialog", {
        name: "New template",
        exact: true,
      });
      const name = editor.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toBeFocused();
      await expect(
        editor.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
      ).toHaveCount(0);
      await contained(editor);
      if (width === 1440)
        await editor.screenshot({
          path: info.outputPath(`new-template-${mode}.png`),
        });
      await editor
        .getByRole("button", { name: "Teams & agents", exact: true })
        .click();
      await editor
        .getByRole("button", { name: "Starting Canvas", exact: true })
        .click();
      const canvas = editor.getByRole("textbox", {
        name: "Starting Canvas (Markdown)",
      });
      await canvas.fill("# A draft that survives disclosure");
      await editor
        .getByRole("button", { name: "Starting Canvas · Added" })
        .press("Enter");
      await expect(canvas).not.toBeVisible();
      await editor
        .getByRole("button", { name: "Starting Canvas · Added" })
        .press("Enter");
      await expect(canvas).toHaveValue("# A draft that survives disclosure");
      await contained(editor);
      if (width === 390)
        await editor.screenshot({
          path: info.outputPath(`expanded-template-${mode}-narrow.png`),
        });
      await editor
        .getByRole("button", { name: "Back to library", exact: true })
        .click();
      await expect(
        library.getByRole("button", { name: "New template", exact: true }),
      ).toBeFocused();
      await library.getByRole("tab", { name: "Teams", exact: true }).click();
      await expect(
        library.getByRole("heading", { name: "No teams yet" }),
      ).toBeVisible();
      await library
        .getByRole("button", { name: "New team", exact: true })
        .click();
      const team = page.getByRole("dialog", { name: "New team", exact: true });
      await expect(team).toHaveAccessibleDescription(/Choose agents/);
      await expect(
        team.getByRole("textbox", { name: "Name", exact: true }),
      ).toBeFocused();
      await contained(team);
      await team
        .getByRole("button", { name: "Close templates", exact: true })
        .click();
      await expect(team).toHaveCount(0);
    }
  }
});

async function contained(dialog) {
  await dialog.evaluate(async (node) => {
    await document.fonts.ready;
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await expect
    .poll(() =>
      dialog.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const failures = [];
        if (
          box.left < 0 ||
          box.right > innerWidth ||
          box.top < 0 ||
          box.bottom > innerHeight
        )
          failures.push("dialog outside viewport");
        for (const control of node.querySelectorAll(
          "button, input, textarea",
        )) {
          if (!control.checkVisibility()) continue;
          const bounds = control.getBoundingClientRect();
          if (bounds.left < box.left || bounds.right > box.right)
            failures.push(
              control.textContent || control.getAttribute("aria-label"),
            );
        }
        return failures;
      }),
    )
    .toEqual([]);
}
