import { expect, test } from "./source-fixture.mjs";

// Real hit-testing is essential: IconButton's decorative artwork deliberately
// has pointer-events:none. Audit cancellation after React handles the event;
// the absence of an HTML menu alone cannot prove the native menu was blocked.
for (const control of [
  "message avatar",
  "Bestie dock",
  "Bestie dock with preview",
]) {
  test(`${control} suppresses image menus without changing activation`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.menuEvents = [];
      for (const type of ["contextmenu", "keydown"]) {
        window.addEventListener(
          type,
          (event) => {
            if (
              type === "keydown" &&
              !(
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              )
            )
              return;
            window.menuEvents.push(event);
          },
          true,
        );
      }
    });
    await page.goto(
      `/tests/fixtures/avatar-menu.html${control.endsWith("preview") ? "?preview" : ""}`,
    );
    const trigger =
      control === "message avatar"
        ? page.getByRole("button", { name: "View Test Agent profile" })
        : page.getByRole("tab", { name: "Test Bestie" });
    await expect
      .poll(() =>
        trigger
          .locator("img")
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    if (control !== "message avatar") {
      await page.keyboard.press("Tab");
      await expect(trigger).toBeFocused();
      await expect(page.getByRole("tooltip")).toHaveText("Test Bestie");
      if (control.endsWith("preview")) {
        await trigger.hover();
        const preview = page.getByRole("dialog", { name: "Test Bestie" });
        await expect(preview).toHaveText("Bestie preview");
        await page.mouse.move(1100, 700);
        await expect(preview).toBeHidden();
      }
    }
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({
        width: theme === "light" ? 1200 : 390,
        height: 800,
      });
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize =
          theme === "light" ? "16px" : "24px";
        window.menuEvents = [];
      }, theme);
      await trigger.click({ button: "right" });
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.menuEvents
              .filter((event) => event.type === "contextmenu")
              .map((event) => ({
                type: event.type,
                cancelled: event.defaultPrevented,
              })),
          ),
        )
        .toEqual([{ type: "contextmenu", cancelled: true }]);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await trigger.focus();
      for (const key of ["Shift+F10", "ContextMenu"]) {
        await page.keyboard.press(key);
      }
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.menuEvents
              .filter((event) => event.type === "keydown")
              .map((event) => ({
                type: event.type,
                cancelled: event.defaultPrevented,
              })),
          ),
        )
        .toEqual([
          { type: "keydown", cancelled: true },
          { type: "keydown", cancelled: true },
        ]);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    await expect(page.locator("output")).toBeEmpty();
    // Enter must still activate the existing profile/navigation behavior.
    await page.keyboard.press("Enter");
    const action =
      control === "message avatar" ? "Profile opened" : "Bestie opened";
    await expect(page.locator("output")).toHaveText(action);
    await trigger.click();
    await expect(page.locator("output")).toHaveText(`${action}, ${action}`);
  });
}
