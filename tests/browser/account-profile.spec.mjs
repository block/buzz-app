import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

// Real menu focus handoff and Escape routing need browser keyboard behavior.
test("reopening the account profile focuses the retained panel", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const trigger = page.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  const menu = page.getByRole("menu");
  const viewProfile = menu.getByRole("menuitem", { name: "View your profile" });
  await trigger.click();
  await viewProfile.click();
  await expect(menu).toHaveCount(0);
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(
    panel.getByRole("region", { name: "Profile details" }),
  ).toBeFocused();
  const channels = panel.getByRole("tab", { name: "Channels", exact: true });
  await channels.click();

  for (const keyboard of [false, true]) {
    if (keyboard) {
      await trigger.focus();
      await trigger.press("Enter");
      await expect(viewProfile).toBeFocused();
      await viewProfile.press("Enter");
    } else {
      await trigger.click();
      await viewProfile.click();
    }
    await expect(menu).toHaveCount(0);
    await expect(panel).toBeFocused();
    await expect(channels).toHaveAttribute("aria-selected", "true");
  }

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
