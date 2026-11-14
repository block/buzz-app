import { test as appTest } from "./fixture.mjs";
import { test, expect } from "./playwright-test.mjs";
import {
  closeSettings,
  openSettings,
  rail,
  selectSettingsSection,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import { showRail } from "./rail-helpers.mjs";

appTest.use({ pluginFixtures: true });

// A plugin's sidebar section is a card in the rail beside Team and Solo.
const workspace = (page) =>
  rail(page)
    .locator("[data-rail-section]")
    .filter({
      has: page.getByRole("button", { name: "Workspace", exact: true }),
    });
const grabber = (page) =>
  rail(page).getByRole("button", { name: "Move Workspace section" });

// A pointer drag from the section's grabber, past the 6px activation distance.
async function startDrag(page) {
  const bounds = await grabber(page).boundingBox();
  if (!bounds) throw new Error("Workspace grabber is unavailable");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y + 12, { steps: 3 });
}

test.describe("plugin sidebar contributions", () => {
  appTest(
    "stay inside the rail beside Solo and Team",
    async ({ page, app }, testInfo) => {
      await page.goto(app.origin);
      const title = "Sidebar section fixture";
      const section = workspace(page);

      for (const [width, mode, fontSize] of [
        [1440, "light", "16px"],
        [1440, "dark", "20px"],
        [390, "light", "20px"],
        [390, "dark", "16px"],
      ]) {
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(
          ({ mode, fontSize }) => {
            document.documentElement.setAttribute("data-color-mode", mode);
            document.documentElement.style.fontSize = fontSize;
          },
          { mode, fontSize },
        );
        await showRail(page);
        await expect(
          rail(page).locator('[data-rail-section="solo"]'),
        ).toBeVisible();

        await openSettings(page);
        await selectSettingsSection(page, "Manage plugins");
        await setPluginEnabled(page, title, false);
        await closeSettings(page);
        await showRail(page);
        await expect(section).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(
            `sidebar-contribution-before-${width}-${mode}-${fontSize}-${testInfo.project.name}.png`,
          ),
        });

        await openSettings(page);
        await selectSettingsSection(page, "Manage plugins");
        await setPluginEnabled(page, title, true);
        await closeSettings(page);
        await showRail(page);
        await expect(section).toBeVisible();
        const queue = section.getByRole("button", { name: "Queue" });
        await expect(queue).toBeVisible();
        if (width === 390) {
          const label = queue.locator(".navigation-item-label");
          await expect
            .poll(() =>
              label.evaluate(
                (element) => element.scrollWidth <= element.clientWidth,
              ),
            )
            .toBe(true);
        }
        await expect(
          rail(page).locator('[data-rail-section="solo"]'),
        ).toBeVisible();
        await expect(
          rail(page).locator('[data-rail-team-view="channels"]'),
        ).toBeVisible();

        const geometry = await rail(page).evaluate((nav) => {
          const group = [...nav.querySelectorAll("[data-rail-section]")].find(
            (card) => card.textContent.includes("Workspace"),
          );
          if (!(group instanceof HTMLElement))
            throw new Error("Rail contribution geometry is unavailable");
          const navBox = nav.getBoundingClientRect();
          const groupBox = group.getBoundingClientRect();
          return {
            noHorizontalOverflow: nav.scrollWidth <= nav.clientWidth,
            contained:
              groupBox.left >= navBox.left && groupBox.right <= navBox.right,
          };
        });
        expect(geometry).toEqual({
          noHorizontalOverflow: true,
          contained: true,
        });
        await page.screenshot({
          path: testInfo.outputPath(
            `sidebar-contribution-after-${width}-${mode}-${fontSize}-${testInfo.project.name}.png`,
          ),
        });
      }
    },
  );

  appTest(
    "shows a drag preview for contributed sections",
    async ({ page, app }) => {
      await page.goto(app.origin);
      await showRail(page);
      const section = workspace(page);
      await expect(section).toBeVisible();
      await startDrag(page);

      await expect(section).toHaveAttribute("data-dragging", "true");
      await expect(page.getByText("Workspace", { exact: true })).toHaveCount(2);

      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(rail(page).locator("[data-dragging]")).toHaveCount(0);
    },
  );

  appTest.describe("failed section icon recovery", () => {
    appTest.use({ expectedSidebarIconFailure: true });

    // The section's fallback replaces its whole card, so it has no grabber.
    appTest(
      "contains a failed contributed icon to its section's fallback",
      async ({ page, app }) => {
        await page.addInitScript(() => {
          window.fixtureSidebarWorkIconThrows = true;
        });
        await page.goto(app.origin);
        await showRail(page);

        await expect(
          rail(page)
            .getByRole("alert")
            .filter({ hasText: "Workspace is unavailable." }),
        ).toBeVisible();
        await expect(grabber(page)).toHaveCount(0);
        await expect(
          rail(page).locator('[data-rail-section="solo"]'),
        ).toBeVisible();
        await expect(
          rail(page).locator('[data-rail-team-view="channels"]'),
        ).toBeVisible();
        await expect(
          page.getByText("Conversations couldn’t open."),
        ).toHaveCount(0);
        expect(
          app.report.consoleErrors.filter((message) =>
            message.includes("Fixture sidebar icon failure"),
          ).length,
        ).toBeGreaterThan(0);
      },
    );
  });
});
