import { test, expect } from "./source-fixture.mjs";

// The browser moves the caret through prose, words and lines; the editor takes
// over only at a mention's edge. That handoff is a native selection contract.
test("keyboard and pointer selection cross a mention as one unit in both directions", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  const input = page.getByRole("textbox", { name: "Message #General" });
  const mention = async (name) => {
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page.getByRole("button", { name, exact: true }).click();
    // The picker restores focus and the caret on the next animation frame.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(input).toBeFocused();
  };
  await input.click();
  await mention(`Honey ${keys.first}`);
  await page.keyboard.type("say hello to ");
  await mention(`Honey (agent) ${keys.second}`);
  await expect(input).toHaveJSProperty("value", "@Honey say hello to @Honey ");
  const selection = () =>
    input.evaluate((el) => [
      el.selectionStart,
      el.selectionEnd,
      el.selectionDirection,
    ]);
  const caret = (offset) =>
    input.evaluate(
      (el, offset) => el.setSelectionRange(offset, offset),
      offset,
    );

  // The browser selects the trailing space; the editor extends over the mention.
  await expect.poll(selection).toEqual([27, 27, "forward"]);
  await input.press("Shift+ArrowLeft");
  await expect.poll(selection).toEqual([26, 27, "backward"]);
  await input.press("Shift+ArrowLeft");
  await expect.poll(selection).toEqual([20, 27, "backward"]);
  await input.press("Shift+ArrowLeft");
  await expect.poll(selection).toEqual([19, 27, "backward"]);
  await input.press("Shift+ArrowRight");
  await expect.poll(selection).toEqual([20, 27, "backward"]);
  await input.press("Shift+ArrowRight");
  await expect.poll(selection).toEqual([26, 27, "backward"]);

  await caret(20);
  await input.press("Shift+ArrowRight");
  await expect.poll(selection).toEqual([20, 26, "forward"]);
  await input.press("Shift+ArrowRight");
  await expect.poll(selection).toEqual([20, 27, "forward"]);
  await input.press("Shift+ArrowLeft");
  await expect.poll(selection).toEqual([20, 26, "forward"]);
  await input.press("Shift+ArrowLeft");
  await expect.poll(selection).toEqual([20, 20, "forward"]);

  await caret(26);
  await input.press("Shift+ArrowLeft");
  await expect.poll(selection).toEqual([20, 26, "backward"]);
  await caret(6);
  await input.press("Shift+ArrowLeft");
  await expect.poll(selection).toEqual([0, 6, "backward"]);
  await input.press("Shift+ArrowRight");
  await expect.poll(selection).toEqual([6, 6, "forward"]);

  // Word and line jumps stay native and never split a mention.
  const word = process.platform === "darwin" ? "Alt" : "Control";
  await caret(27);
  await input.press(`${word}+Shift+ArrowLeft`);
  await expect.poll(selection).toEqual([20, 27, "backward"]);
  await input.press(`${word}+Shift+ArrowLeft`);
  await expect.poll(selection).toEqual([17, 27, "backward"]);
  await input.press("Shift+Home");
  await expect.poll(selection).toEqual([0, 27, "backward"]);
  await caret(4);
  await input.press("Shift+End");
  await expect.poll(selection).toEqual([4, 27, "forward"]);

  // Dragging from the end back into the prose selects the mention in between.
  const points = await input.evaluate((el) => {
    const paragraph = el.querySelector("p");
    const prose = [...paragraph.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.data.includes("hello"),
    );
    const line = document.createRange();
    line.selectNodeContents(paragraph);
    const edge = line.getBoundingClientRect();
    const boundary = document.createRange();
    boundary.setStart(prose, 12);
    boundary.setEnd(prose, 12);
    const at = boundary.getBoundingClientRect();
    return {
      y: edge.top + edge.height / 2,
      end: edge.right + 2,
      inProse: at.left,
    };
  });
  await page.mouse.move(points.end, points.y);
  await page.mouse.down();
  await page.mouse.move(points.inProse, points.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(selection).toEqual([18, 27, "backward"]);
});
