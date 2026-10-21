import { test, expect } from "./source-fixture.mjs";

// Browser-only: native selection and focus must survive an automatic recipient
// replacement, with formatted prose and one-step undo in the real editor.
test("recipient replacement preserves native selection, formatting, focus and undo", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("Keep this prose");
  await input.press("ControlOrMeta+a");
  await input.press("ControlOrMeta+b");
  const replace = (which) =>
    page.evaluate(
      (which) =>
        window.mentionFixture.replaceRecipients([
          { pubkey: window.mentionFixture[which], name: "Honey" },
        ]),
      which,
    );
  await expect.poll(() => replace("first")).toBe(true);
  await input.evaluate((el) => el.setSelectionRange(12, 16));
  const before = await input.evaluate((el) => [
    el.selectionStart,
    el.selectionEnd,
  ]);
  expect(await replace("second")).toBe(true);
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "@Honey Keep this prose");
  expect(
    await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
  ).toEqual(before);
  await expect(input.locator("strong")).toContainText("Keep this prose");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "@Honey Keep this prose");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.publications.filter((event) => event.kind === 9)
            .length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(() =>
    window.mentionFixture.publications.find((event) => event.kind === 9),
  );
  const first = await page.evaluate(() => window.mentionFixture.first);
  expect(
    sent.tags.filter(([tag]) => tag === "p").map(([, key]) => key),
  ).toEqual([first]);
  expect(sent.content).toContain("**Keep this prose**");
});
