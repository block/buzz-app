import { communitySwitcher, openCommunityPicker } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const mod = async (page) =>
  (await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)))
    ? "Meta"
    : "Control";
const rows = (picker) => picker.getByRole("button", { name: /^Switch to / });
const order = (picker) =>
  rows(picker).evaluateAll((nodes) =>
    nodes.map(
      (node) => node.querySelector(".navigation-item-label")?.textContent,
    ),
  );
const centre = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Community rows must have layout");
  return [box.x + box.width / 2, box.y + box.height / 2];
};

// Real hit testing and layout are required: jsdom cannot prove that a pull
// moves a row while a click still selects it, or where a drop lands.
test("dragging a community reorders the switcher, its numbered shortcuts and the saved order", async ({
  page,
  app,
}) => {
  await open(page, app);
  const modifier = await mod(page);
  let picker = await openCommunityPicker(page);
  await expect.poll(() => order(picker)).toEqual(["Primary", "Secondary"]);
  const [fromX, fromY] = await centre(rows(picker).nth(1));
  const [toX, toY] = await centre(rows(picker).nth(0));
  const pull = async () => {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 8 });
    await expect(picker.locator("[data-dragging]")).toHaveCount(1);
  };
  // Escape cancels the move, not the switcher: the release then drops nothing.
  await pull();
  await page.keyboard.press("Escape");
  await expect(picker.locator("[data-dragging]")).toHaveCount(0);
  await page.mouse.up();
  await expect(picker).toBeVisible();
  await expect.poll(() => order(picker)).toEqual(["Primary", "Secondary"]);
  await pull();
  // The pulled row dims in place; the line marks the side it lands on.
  await expect(picker.locator('[data-drop-edge="before"]')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => order(picker)).toEqual(["Secondary", "Primary"]);
  await expect(picker.locator("[data-dragging], [data-drop-edge]")).toHaveCount(
    0,
  );
  // A drop is not a choice: the switcher stays open on the same community.
  await expect(picker).toBeVisible();
  await expect(communitySwitcher(page, "Primary")).toBeVisible();
  await expect(rows(picker).nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  // Personal space keeps the first number; the communities follow in order.
  await page.keyboard.press(`${modifier}+2`);
  await expect(communitySwitcher(page, "Secondary")).toBeVisible();
  await page.keyboard.press(`${modifier}+3`);
  await expect(communitySwitcher(page, "Primary")).toBeVisible();

  await page.reload();
  await expect(communitySwitcher(page, "Primary")).toBeVisible();
  picker = await openCommunityPicker(page);
  await expect.poll(() => order(picker)).toEqual(["Secondary", "Primary"]);
  // A click that does not travel still selects.
  await rows(picker).nth(0).click();
  await expect(communitySwitcher(page, "Secondary")).toBeVisible();
  await page.keyboard.press(`${modifier}+3`);
  await expect(communitySwitcher(page, "Primary")).toBeVisible();
});
