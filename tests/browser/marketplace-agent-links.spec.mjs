import { test, expect } from "./source-fixture.mjs";

// Browser-only evidence: native history traversal, keyboard activation, and
// responsive profile actions. Address/error matrices stay in colocated Vitest.
test("copying a same-name listing opens its exact profile and preserves dismissal", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.copiedMarketplaceLink = text;
        },
      },
    });
  });
  await page.goto("/tests/fixtures/agent-library.html?marketplace");
  await page.getByRole("tab", { name: "Marketplace", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Helper", exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Helper", exact: true })
    .nth(1)
    .click();
  const profile = page.getByRole("region", { name: "Shared agent profile" });
  await expect(profile).toContainText("Instructions from publisher b.");
  const copy = profile.getByRole("button", { name: "Copy link", exact: true });
  for (const { width, dark, fontSize } of [
    { width: 1280, dark: false, fontSize: "16px" },
    { width: 390, dark: true, fontSize: "20px" },
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ dark, fontSize }) => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.fontSize = fontSize;
      },
      { dark, fontSize },
    );
    await copy.focus();
    await expect(copy).toBeFocused();
    await expect(copy).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Link copied.", { exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`marketplace-link-${width}.png`),
    });
    const notice = page.getByRole("dialog", {
      name: "Link copied.",
      exact: true,
    });
    await notice.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(notice).toHaveCount(0);
    // Sonner removes the exiting title after its accessibility role goes away.
    await expect(page.getByText("Link copied.", { exact: true })).toHaveCount(
      0,
    );
  }
  const link = await page.evaluate(() => window.copiedMarketplaceLink);
  expect(new URL(link).searchParams.get("route.shared")).toBe(
    `${"b".repeat(64)}:helper`,
  );
  await profile.getByRole("button", { name: /Close/ }).click();
  await expect(profile).toHaveCount(0);
  await page.evaluate((href) => {
    void window.openMarketplaceLink(href);
  }, link);
  await expect(profile).toContainText("Instructions from publisher b.");
  await page.goBack();
  await expect(profile).toHaveCount(0);
  await page.goForward();
  await expect(profile).toContainText("Instructions from publisher b.");
  await profile.getByRole("button", { name: /Close/ }).click();
  await expect(profile).toHaveCount(0);
  await page.goBack();
  await page.goForward();
  await expect(profile).toHaveCount(0);
});
