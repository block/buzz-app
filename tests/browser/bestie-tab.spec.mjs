import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Real layout is outside jsdom: the tab at the Agents side panel's default and
// narrowest widths, with large text, never runs off the panel.
// With a section edited by hand, its row shows Restore instead of a switch.
for (const [variant, query] of [
  ["bestie", ""],
  ["former", "?former"],
  ["edited", "?edited"],
]) {
  test(`The ${variant} Bestie tab fits the side panel at every width and text size`, async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.goto(`/tests/fixtures/bestie-tab.html${query}`);
    if (variant === "edited")
      await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    const panel = page.getByRole("complementary", { name: "Agent panel" });
    const access = panel.getByRole("region", {
      name:
        variant === "former"
          ? "What Ada can read"
          : "What your Bestie can read",
    });
    const readInbox = access.getByRole("switch", { name: "Inbox" });
    await expect(readInbox).toBeChecked();
    await readInbox.scrollIntoViewIfNeeded();
    await readInbox.focus();
    await readInbox.press("Space");
    await expect(readInbox).not.toBeChecked();
    await expect(panel.getByText("#family", { exact: true })).toBeVisible();
    await readInbox.click();
    await expect(readInbox).toBeChecked();
    for (const width of ["28rem", "20rem"]) {
      for (const [mode, fontSize] of [
        ["light", "16px"],
        ["dark", "20px"],
      ]) {
        await page.evaluate(
          ([width, fontSize, mode]) => {
            document.documentElement.dataset.colorMode = mode;
            document.documentElement.style.setProperty(
              "--secondary-panel-width",
              width,
            );
            document.documentElement.style.fontSize = fontSize;
          },
          [width, fontSize, mode],
        );
        await access.scrollIntoViewIfNeeded();
        await expect(readInbox).toBeInViewport();
        if (process.env.BESTIE_SHOTS)
          await panel.screenshot({
            path: `${process.env.BESTIE_SHOTS}/${variant}-${width}-${fontSize}.png`,
          });
        expect(
          await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
          `${width} at ${fontSize}`,
        ).toBe(true);
        for (const button of await panel.getByRole("button").all()) {
          const box = await button.boundingBox();
          const bounds = await panel.boundingBox();
          expect(
            box && bounds && box.x + box.width <= bounds.x + bounds.width + 0.5,
            `${await button.textContent()} at ${width} ${fontSize}`,
          ).toBe(true);
        }
      }
    }
    expect(errors.unexplained()).toEqual([]);
  });
}
