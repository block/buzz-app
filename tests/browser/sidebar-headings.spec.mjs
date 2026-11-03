import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({ dmLabels: true, historyCounts: { alpha: 1, beta: 1 } });

// Text clipping, reflow, hit targets and native summary focus need real layout.
test("sidebar headings and actions remain readable at enlarged interface sizes", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await page.setViewportSize({ width: 1440, height: 1400 });
  await openPage(page, "Messages");
  const sidebar = page.locator(".shell-sidebar");
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  const summaries = ["Channels", "Direct messages"].map((title) =>
    sidebar.locator("summary").filter({ hasText: title }),
  );
  for (const summary of summaries) await expect(summary).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  for (const mode of ["light", "dark"]) {
    for (const scale of [1, 1.2, 1.5, 1.8, 2]) {
      await resize.press("Home");
      // Use the appearance service's live preference restoration, including a
      // size change after a narrow width has already been saved.
      await page.evaluate(
        ({ mode, scale }) => {
          localStorage.setItem("buzz-appearance.v1", mode);
          localStorage.setItem("buzz-font-scale.v1", String(scale));
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: null,
              storageArea: localStorage,
            }),
          );
        },
        { mode, scale },
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      await expect
        .poll(() =>
          page
            .locator("html")
            .evaluate((root) =>
              Number.parseFloat(getComputedStyle(root).fontSize),
            ),
        )
        .toBeCloseTo(16 * scale, 5);
      for (const width of [220, 260, 520]) {
        if (width === 260) await resize.dblclick();
        else await resize.press(width === 220 ? "Home" : "End");
        await expect(resize).toHaveAttribute("aria-valuenow", String(width));
        for (const summary of summaries) {
          await summary.scrollIntoViewIfNeeded();
          await expect
            .poll(() =>
              summary.evaluate((element) => {
                const label = element.querySelector("[data-overflowing]");
                const title = element.firstElementChild.lastElementChild;
                const header = element.parentElement.parentElement;
                const frame = header.getBoundingClientRect();
                const text = title.getBoundingClientRect();
                const actions = header.lastElementChild.getBoundingClientRect();
                const disclosure = element.getBoundingClientRect();
                return {
                  readable:
                    title.clientWidth > 0 &&
                    title.scrollWidth <= title.clientWidth + 1,
                  faded: !!label,
                  contained:
                    text.left >= frame.left &&
                    text.right <= frame.right + 1 &&
                    actions.left >= frame.left &&
                    actions.right <= frame.right + 1,
                  separate:
                    disclosure.right <= actions.left + 1 ||
                    disclosure.bottom <= actions.top + 1,
                };
              }),
            )
            .toEqual({
              readable: true,
              faded: false,
              contained: true,
              separate: true,
            });
        }
      }
    }
  }

  await resize.press("Home");
  const channels = summaries[0];
  await channels.focus();
  await page.keyboard.press("Tab");
  const more = sidebar.getByRole("button", {
    name: "More actions for Channels",
    exact: true,
  });
  await expect(more).toBeFocused();
  await expect(more.locator("..")).toHaveCSS("opacity", "1");
  await more.press("Enter");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).toBeVisible();
  await expect(channels.locator("..")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(channels.locator("..")).toHaveAttribute("open", "");
  await channels.press("Enter");
  await expect(channels.locator("..")).not.toHaveAttribute("open");
  await channels.press("Enter");
  await expect(channels.locator("..")).toHaveAttribute("open", "");
  await channels.scrollIntoViewIfNeeded();
  await summaries[1].hover();
  await page.screenshot({ path: info.outputPath("sidebar-200-percent.png") });
});

const savedSections = test.extend({
  productionBroker: true,
  savedSidebar: true,
});
savedSections(
  "a long custom heading reflows without clipping its title or actions",
  async ({ page, app }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .getByRole("button", { name: "More actions for Work", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Rename section", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Rename section",
      exact: true,
    });
    const title = "Release planning and accessibility investigations";
    await dialog.getByRole("textbox", { name: "Section name" }).fill(title);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const section = page.locator('[data-sidebar-section="group:work"]');
    const summary = section.locator("summary");
    await expect(summary).toHaveAccessibleName(title);
    await page.evaluate(() => {
      localStorage.setItem("buzz-font-scale.v1", "2");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "buzz-font-scale.v1",
          storageArea: localStorage,
        }),
      );
    });
    await expect(page.locator("html")).toHaveCSS("font-size", "32px");
    await page.getByRole("separator", { name: "Resize sidebar" }).press("Home");
    await summary.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        summary.evaluate((element) => {
          const text = element.firstElementChild.lastElementChild;
          return (
            text.clientWidth > 0 &&
            text.scrollWidth <= text.clientWidth + 1 &&
            text.scrollHeight <= text.clientHeight + 1
          );
        }),
      )
      .toBe(true);
    await expect(summary.locator("[data-overflowing]")).toHaveCount(0);
    const more = section.getByRole("button", {
      name: `More actions for ${title}`,
      exact: true,
    });
    await more.click();
    await expect(
      page.getByRole("menu", {
        name: `More actions for ${title}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(summary.locator("..")).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
  },
);
