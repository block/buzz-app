import { test, expect } from "./fixture.mjs";
import {
  openSettings,
  selectSettingsSection,
  closeSettings,
  chooseColorMode,
} from "./navigation.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 0 } });

// The host Settings preference must update a retained composer, with keyboard
// input and choice controls usable in both themes and a narrow enlarged layout.
test("the send-key setting changes a retained composer", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(input).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  const choice = page.getByRole("combobox", {
    name: "Send messages with",
    exact: true,
  });
  const apple = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  for (const mode of ["Dark", "Light"]) {
    await chooseColorMode(page, mode);
    await choice.scrollIntoViewIfNeeded();
    await expect(choice).toBeVisible();
  }
  await page.setViewportSize({ width: 480, height: 800 });
  for (let step = 0; step < 10; step++)
    await page
      .getByRole("button", { name: "Increase interface size", exact: true })
      .click();
  await choice.scrollIntoViewIfNeeded();
  await choice.click();
  await page
    .getByRole("option", {
      name: apple ? "Cmd+Enter" : "Ctrl+Enter",
      exact: true,
    })
    .click();
  await expect(choice).toContainText(apple ? "Cmd+Enter" : "Ctrl+Enter");
  expect(
    await page.evaluate(() => localStorage.getItem("buzz-message-send-key.v1")),
  ).toBe("mod-enter");
  await closeSettings(page);
  await input.fill("first");
  await input.press("End");
  await input.press("Enter");
  await page.keyboard.type("second");
  await expect
    .poll(() => input.evaluate((node) => node.value))
    .toBe("first\nsecond");
  await input.press(apple ? "Meta+Enter" : "Control+Enter");
  await expect.poll(() => input.evaluate((node) => node.value)).toBe("");
});
