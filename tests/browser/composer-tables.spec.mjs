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

const paste = (input, text, html = "") =>
  input.evaluate(
    (element, { text, html }) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      if (html) clipboardData.setData("text/html", html);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    },
    { text, html },
  );

test("only spreadsheet cells paste as a table, never indented code", async ({
  page,
}) => {
  const input = await composer(page);
  const go = "\tif err != nil {\n\t\treturn err\n\t}\n";
  const code =
    "<meta charset='utf-8'><div style=\"white-space: pre;\"><div><span>\tif err != nil {</span></div><div><span>\t\treturn err</span></div><div><span>\t}</span></div></div>";
  await input.click();
  await paste(input, go);
  await paste(input, go, code);
  await expect(input.locator("table")).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", go + go);
  await input.fill("");
  await paste(
    input,
    "Name\tQty\nTea\t2\n",
    "<meta charset='utf-8'><google-sheets-html-origin><table><tbody><tr><td>Name</td><td>Qty</td></tr><tr><td>Tea</td><td>2</td></tr></tbody></table>",
  );
  await expect(input.locator("tr")).toHaveCount(2);
  await expect(input.locator("th").first()).toHaveText("Name");
});

test("a table pasted into a list item or a quote stays Markdown text", async ({
  page,
}) => {
  const input = await composer(page);
  const grid = "| a | b |\n| - | - |\n| 1 | 2 |";
  await page
    .getByRole("button", { name: "Toggle formatting", exact: true })
    .click();
  await input.click();
  for (const [name, container] of [
    ["Bullet list", "ul"],
    ["Quote", "blockquote"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Table", exact: true }),
    ).toBeDisabled();
    await paste(input, grid);
    await expect(input.locator(container)).toHaveCount(1);
    await expect(input.locator("table")).toHaveCount(0);
    await expect(input).toHaveJSProperty("value", grid);
    await input.fill("");
  }
});
