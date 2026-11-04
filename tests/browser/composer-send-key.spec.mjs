import { test, expect } from "./source-fixture.mjs";

// Native editor line splitting and modified Enter delivery need a real engine;
// platform modifier and IME/repeat matrices stay in the mounted composer tests.
test("the saved send key inserts lines, survives reload, and sends with modified Enter", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/link-messages.html");
  // Seed once, not with addInitScript: reload must read the saved preference.
  await page.evaluate(() => {
    localStorage.setItem("buzz-message-send-key.v1", "mod-enter");
  });
  await page.reload();
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  await input.fill("first");
  await input.press("End");
  await input.press("Enter");
  await page.keyboard.type("second");
  await input.press("Shift+Enter");
  await page.keyboard.type("third");
  await expect
    .poll(() => input.evaluate((element) => element.value))
    .toBe("first\nsecond\nthird");
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent),
  ).toHaveLength(0);
  await page.reload();
  await expect
    .poll(() => input.evaluate((element) => element.value))
    .toBe("first\nsecond\nthird");
  const apple = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  await input.press(apple ? "Meta+Enter" : "Control+Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.linkComposerFixture.sent.at(-1)?.text),
    )
    .toBe("first\nsecond\nthird");
  await expect.poll(() => input.evaluate((element) => element.value)).toBe("");
});
