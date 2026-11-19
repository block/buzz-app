import { test, expect } from "./source-fixture.mjs";

// Real geometry is needed to cross from the message link into its portal and
// keep keyboard focus, without a nested button opening the PR instead.
test("Solo PR hover actions link and unlink while browser opening is selected", async ({
  page,
}) => {
  for (const [width, theme, scale] of [
    [1000, "light", 1],
    [480, "dark", 2],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/tests/fixtures/github-chat-links.html");
    await page.evaluate(
      ({ theme, scale }) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = `${16 * scale}px`;
      },
      { theme, scale },
    );
    const setting = page.getByRole("switch", {
      name: "Open GitHub links in Buzz",
    });
    if (await setting.isChecked()) await setting.click();
    await expect(setting).not.toBeChecked();
    const first = page.getByRole("link", { name: "example-org/widgets#42" });
    await first.hover();
    const action = page.getByRole("button", {
      name: "Link to chat",
      exact: true,
    });
    await expect(action).toBeVisible();
    const padding = await action.evaluate((button) => {
      const style = getComputedStyle(button);
      return [
        style.paddingLeft,
        style.paddingRight,
        style.paddingTop,
        style.paddingBottom,
      ];
    });
    expect(padding[0]).toBe(padding[1]);
    expect(padding[2]).toBe(padding[3]);
    await expect
      .poll(() =>
        first.evaluate((link) => {
          const popup = document.querySelector(".buzz-preview-card[data-open]");
          return popup
            ? Math.abs(
                link.getBoundingClientRect().top -
                  popup.getBoundingClientRect().bottom,
              )
            : Infinity;
        }),
      )
      .toBeLessThan(1);
    await expect
      .poll(() =>
        action.evaluate((button) => {
          const popup = button.closest(".buzz-preview-card");
          return popup
            ? popup.getBoundingClientRect().bottom -
                button.getBoundingClientRect().bottom
            : Infinity;
        }),
      )
      .toBeLessThan(1.5);
    await page
      .getByRole("button", { name: "Link to chat", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Unlink from chat", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Update release notes/ }),
    ).toContainText("Pull request, open:");
    await page.keyboard.press("Escape");
    const second = page.getByRole("link", { name: "example-org/widgets#43" });
    await second.focus();
    await expect(
      page.getByRole("button", { name: "Link to chat", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Link to chat", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Unlink from chat", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Unlink from chat", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Link to chat", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Update release notes/ }),
    ).not.toContainText("Pull request");
    expect(await page.locator("a button").count()).toBe(0);
  }
});
