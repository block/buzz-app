import { test, expect } from "./source-fixture.mjs";

// Browser-only: a message link is an inline block (its chip, see
// docs/channels.md), and how it meets a heading's short line, an ancestor's
// strikethrough and a table cell's shrink-to-fit width is layout and paint
// that no DOM emulator computes.
test("link chips keep heading glyphs, strikethrough and table labels whole", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/link-messages.html?chips");
  const row = page.locator('[data-message-id="chip-row"]');
  await expect(row.locator("table a")).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);
  const read = () =>
    row.evaluate((element) => {
      // The chip clips what overflows its padding box: in a heading that box
      // must hold the label's font box, which an h1 line is shorter than.
      const heading = element.querySelector("h1 a");
      const box = heading.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(heading);
      const glyphs = [...range.getClientRects()];
      return {
        heading: glyphs.every(
          (rect) => rect.top >= box.top && rect.bottom <= box.bottom,
        ),
        struck: [...element.querySelectorAll("del a")].map((link) =>
          getComputedStyle(link).textDecorationLine.includes("line-through"),
        ),
        truncated: [...element.querySelectorAll("td a")].filter(
          (link) => link.scrollWidth > link.clientWidth,
        ).length,
      };
    });
  // With the bundled links renderer, then as plain anchors.
  for (const mode of ["on", "off"]) {
    await page.getByRole("button", { name: `Plugin ${mode}` }).click();
    await expect(page.getByText(`Plugin mode: ${mode}`)).toBeVisible();
    expect(await read(), `plugin ${mode}`).toEqual({
      heading: true,
      struck: [true, true],
      truncated: 0,
    });
  }
});
