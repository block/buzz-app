import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "owner",
  sessionMembers: {
    "11111111-1111-4111-8111-111111111111": ["a".repeat(64)],
  },
  historyCounts: { alpha: 1, beta: 1 },
});

// Browser-only: nested scrolling, text reflow and clipping need the real dialog
// and CSS layout engine. Role/recovery matrices stay in component/session tests.
test("general access stays visible outside member scrolling with enlarged text", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Lifecycle channel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const general = dialog.getByRole("region", {
    name: "General access",
    exact: true,
  });
  const list = dialog.getByRole("region", { name: "Member list", exact: true });
  const audience = general.getByRole("combobox", { name: "Who can read" });
  await expect(audience).toBeEnabled();
  await dialog.evaluate(async (node) => {
    await Promise.all(
      node.getAnimations().map((animation) => animation.finished),
    );
  });
  for (const [width, height, scale, theme] of [
    [1440, 950, 1, "light"],
    [1440, 950, 2, "dark"],
    [700, 900, 2, "light"],
    [390, 900, 2, "dark"],
    [390, 720, 1.5, "light"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      ({ scale, theme }) => {
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        );
        document.documentElement.setAttribute("data-color-mode", theme);
      },
      { scale, theme },
    );
    if (width < 480) {
      // The fixed chrome and enlarged controls cannot all fit at this width.
      // Preserve the bounded whole-body fallback and prove keyboard reachability.
      for (const control of [
        audience,
        general.getByRole("combobox", { name: "New people can" }),
      ]) {
        await control.focus();
        await expect(control).toBeInViewport({ ratio: 1 });
      }
    } else {
      await expect
        .poll(() =>
          list.evaluate((node) => {
            const layout = node.parentElement;
            const general = layout.querySelector(
              '[aria-label="General access"]',
            );
            const caption = general.querySelector("p");
            const body = layout.closest(".buzz-dialog-body");
            return {
              verticalOverflow: layout.scrollHeight > layout.clientHeight + 1,
              horizontalOverflow:
                layout.scrollWidth > layout.clientWidth + 1 ||
                caption.scrollWidth > caption.clientWidth + 1,
              footerClipped:
                general.getBoundingClientRect().bottom >
                body.getBoundingClientRect().bottom + 1,
            };
          }),
        )
        .toEqual({
          verticalOverflow: false,
          horizontalOverflow: false,
          footerClipped: false,
        });
      const before = await general.boundingBox();
      await list.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      expect((await general.boundingBox()).y).toBe(before.y);
    }
    await dialog.screenshot({
      path: testInfo.outputPath(
        `access-${width}-${height}-${scale}-${theme}.png`,
      ),
    });
  }
  await audience.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(audience).toBeFocused();
  await audience.click();
  await page.getByRole("option", { name: "Private", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(audience).toBeFocused();
  const memberActions = dialog.getByRole("button", { name: /^Actions for / });
  await expect(memberActions).toHaveCount(2);
  await memberActions.nth(1).click();
  await page
    .getByRole("menuitemradio", { name: "Viewing only", exact: true })
    .click();
  const roleConfirmation = page.getByRole("dialog", {
    name: "Change access to Viewing only?",
    exact: true,
  });
  await expect(roleConfirmation).toContainText(
    "Change access from Participating to Viewing only.",
  );
  await expect(
    roleConfirmation.getByRole("button", {
      name: "Set to viewing only",
      exact: true,
    }),
  ).toBeVisible();
  await roleConfirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(app.report.lifecyclePublications ?? []).toEqual([]);
  expect(app.report.unexpected).toEqual([]);
});
