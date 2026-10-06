import { test, expect } from "./source-fixture.mjs";

test("renders the bounded Buzz emoji avatar as an agent picture", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/tests/fixtures/agent-avatar.html");
  await page.getByRole("button", { name: "Load emoji picture" }).click();

  const group = page.getByRole("region", { name: "40px avatars" });
  const avatar = group.getByRole("img", { name: /^Agent/ });
  const image = avatar.locator("img");
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml,/);
  await expect
    .poll(() => image.evaluate((node) => node.naturalWidth))
    .toBe(512);
  await expect(image).toHaveAttribute("data-loaded", "true");
  await expect(avatar.locator("[data-avatar-shape] > span")).toHaveCount(0);

  await page.screenshot({
    path: test.info().outputPath("agent-emoji-avatar.png"),
  });
});
