import { test, expect } from "./source-fixture.mjs";

async function composer(page) {
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  await input.fill("");
  return input;
}

const wide = (columns, rows) => {
  const head = Array.from({ length: columns }, (_, c) => `Column ${c + 1}`);
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...Array.from(
      { length: rows },
      (_, r) =>
        `| ${head.map((_, c) => `r${r + 1} c${c + 1} value`).join(" | ")} |`,
    ),
  ].join("\n");
};

test("native typing, Tab and arrow keys move through a table and out of it", async ({
  page,
}) => {
  const input = await composer(page);
  await page
    .getByRole("button", { name: "Toggle formatting", exact: true })
    .click();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.keyboard.type("a");
  await page.keyboard.press("Tab");
  await page.keyboard.type("b");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.type("c");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("!");
  await expect(input.locator("tr").nth(1).locator("td").first()).toHaveText(
    "c",
  );
  await expect(input.locator("th").nth(1)).toHaveText("b");
  await expect(input.locator("tr").nth(0).locator("th").nth(2)).toHaveText("!");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("below");
  await expect(input.locator("p").last()).toHaveText("below");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("x");
  await expect(input.locator("td[data-active]")).toHaveCount(1);
});

test("a wide, long table scrolls inside itself and the toolbar edits it", async ({
  page,
}) => {
  const input = await composer(page);
  await input.evaluate((el, text) => el.insertText(text), wide(8, 15));
  await input.evaluate((el) => el.setSelectionRange(0, 0));
  const grid = input.locator("[data-composer-table]");
  const size = await grid.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(size.scrollWidth).toBeGreaterThan(size.clientWidth);
  expect(size.scrollHeight).toBeGreaterThan(size.clientHeight);
  const toolbar = page.getByRole("toolbar", { name: "Table" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "Add column right" }).click();
  await expect(input.locator("tr").first().locator("th")).toHaveCount(9);
  await toolbar.getByRole("button", { name: "Delete table" }).click();
  await expect(input.locator("table")).toHaveCount(0);
  await expect(toolbar).toHaveCount(0);
});
