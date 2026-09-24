import { test, expect } from "./source-fixture.mjs";

// Real contenteditable key/default-action boundary; unit tests own the ranking matrix.
test("Space commits a unique exact identity but leaves namesakes as prose", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html?delayed-profiles");
  await page.evaluate(() => window.mentionFixture.releaseProfiles());
  const input = page.getByRole("textbox", { name: "Message #General" });
  // Exact-name Space must not create intent inside an actual rich-editor code span.
  await input.fill("`@Mary Jane`");
  await input.evaluate((el) => el.setSelectionRange(11, 11));
  await input.press("Space");
  await expect(input).toHaveJSProperty("value", "`@Mary Jane `");
  await expect(input.locator(".inline-chip")).toHaveCount(0);
  await input.fill("@Mary Jane");
  await expect(page.getByRole("option", { name: /^Mary Jane / })).toBeVisible();
  await input.press("Space");
  await expect(input.locator(".inline-chip")).toHaveText("@Mary Jane");
  await input.pressSequentially("hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.publications.filter((e) => e.kind === 9).length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(() => ({
    event: window.mentionFixture.publications.find((e) => e.kind === 9),
    key: window.mentionFixture.first,
  }));
  expect(sent.event.tags).toContainEqual(["p", sent.key]);
  await page.goto("/tests/fixtures/mentions.html");
  await input.fill("@Honey");
  await expect(page.getByRole("option", { name: /^Honey / })).toHaveCount(2);
  await input.press("Space");
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await expect(input.locator(".inline-chip")).toHaveCount(0);
});

test("an open list preserves keys and highlight when membership is revoked", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("@Honey");
  const rows = page.getByRole("option");
  await expect(rows).toHaveCount(2);
  const rowKeys = () =>
    rows.evaluateAll((nodes) =>
      nodes.map((n) => n.querySelector("small")?.textContent),
    );
  const before = await rowKeys();
  const revokedKey = await page.evaluate(() => window.mentionFixture.first);
  const removed = page.getByRole("option", { name: new RegExp(revokedKey) });
  if ((await removed.getAttribute("aria-selected")) !== "true")
    await input.press("ArrowDown");
  await expect(removed).toHaveAttribute("aria-selected", "true");
  const selectedId = await input.getAttribute("aria-activedescendant");
  await page.evaluate(() => window.mentionFixture.removeFirst());
  await expect(
    page.getByRole("option", { name: /No longer available/ }),
  ).toHaveAttribute("aria-disabled", "true");
  const archived = page.getByRole("option", { name: /No longer available/ });
  await expect(archived).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", selectedId);
  const position = before.indexOf(revokedKey);
  await expect(rows.nth(position)).toHaveAttribute("aria-disabled", "true");
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", "@Honey");
  await expect(input.locator(".inline-chip")).toHaveCount(0);
  expect(
    await page.evaluate(() => window.mentionFixture.publications.length),
  ).toBe(0);
  expect(before).toHaveLength(2);
});
