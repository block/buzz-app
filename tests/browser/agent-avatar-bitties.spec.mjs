import { test, expect } from "./source-fixture.mjs";

// The saved PNG's size and a few decoded pixels.
const savedPixels = async (page) => {
  const saved = page.getByRole("img", { name: "Saved avatar" });
  await expect(saved).toBeVisible();
  return saved.evaluate(async (image) => {
    await image.decode();
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    return {
      size: [bitmap.width, bitmap.height],
      corner: pixel(0, 0),
      center: pixel(bitmap.width / 2, bitmap.height / 2),
    };
  });
};
const selectedSource = (page) =>
  page.getByRole("img", { name: "Selected avatar" }).locator("img");

test("draws the name's Bitty, pins a variant from the keyboard, and saves it", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html?bitties");
  await page.getByRole("tab", { name: "Bitties", exact: true }).click();
  await expect(selectedSource(page)).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  const named = await selectedSource(page).getAttribute("src");
  const lock = page.getByRole("button", {
    name: "Keep this avatar when the name changes",
  });
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({
    path: test.info().outputPath("bitties-tab.png"),
  });

  // The strip is one Tab stop; arrows move within it.
  const strip = page.getByRole("group", { name: "Bitties for this name" });
  await expect(strip.getByRole("button")).toHaveCount(12);
  await strip.getByRole("button", { name: "Bitty 1", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const third = strip.getByRole("button", { name: "Bitty 3", exact: true });
  await expect(third).toBeFocused();
  await expect(third).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("Enter");
  await expect(third).toHaveAttribute("aria-pressed", "true");
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await expect(selectedSource(page)).not.toHaveAttribute("src", named);
  await page.screenshot({
    path: test.info().outputPath("bitties-pinned.png"),
  });

  await page.getByRole("button", { name: "Save" }).click();
  const { size, corner } = await savedPixels(page);
  // A square 480 px PNG with its background filled in; Avatar owns the mask.
  expect(size).toEqual([480, 480]);
  expect(corner[3]).toBe(255);
});

test("keeps the tab, its strip and the picker inside a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto("/tests/fixtures/agent-avatar-picker.html?bitties");
  await page.getByRole("tab", { name: "Bitties", exact: true }).click();
  await expect(selectedSource(page)).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // The strip scrolls within the dock to reach its last Bitty.
  const last = page.getByRole("button", { name: "Bitty 12" });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await page.getByRole("button", { name: "Shuffle" }).click();
  await expect(
    page.getByRole("button", {
      name: "Keep this avatar when the name changes",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: test.info().outputPath("bitties-narrow.png"),
  });
});

test("saves the Bitty picked just before Save, after its encode finishes", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html?bitties");
  await page.getByRole("tab", { name: "Bitties", exact: true }).click();
  await expect(selectedSource(page)).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  const original = await selectedSource(page).getAttribute("src");
  // Hold the next 480 px encode, so Save starts before the new preview.
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      if (this.width !== 480) return toBlob.call(this, callback, ...args);
      window.heldBitty = this.toDataURL();
      window.releaseBitty = () => toBlob.call(this, callback, ...args);
    };
  });
  await page.getByRole("button", { name: "Bitty 3", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseBitty))
    .toBe("function");
  const held = await page.evaluate(() => window.heldBitty);
  expect(held).not.toBe(original);
  await page.getByRole("button", { name: "Save" }).click();
  // Save waits for the held Bitty rather than saving the one shown.
  await page.evaluate(() => window.releaseBitty());
  const saved = page.getByRole("img", { name: "Saved avatar" });
  await expect(saved).toBeVisible();
  const same = await saved.evaluate(
    async (image, [held, original]) => {
      const load = async (src) => {
        const other = new Image();
        other.src = src;
        await other.decode();
        return other;
      };
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 480;
      const context = canvas.getContext("2d");
      const sample = (input) => {
        context.clearRect(0, 0, 480, 480);
        context.drawImage(input, 0, 0, 480, 480);
        return canvas.toDataURL();
      };
      const savedPixels = sample(image);
      return {
        held: savedPixels === sample(await load(held)),
        original: savedPixels === sample(await load(original)),
      };
    },
    [held, original],
  );
  expect(same).toEqual({ held: true, original: false });
});
