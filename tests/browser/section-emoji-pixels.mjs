import { expect } from "./playwright-test.mjs";

// Layout/Range bounds cannot detect native color-emoji ink bearings. Read the
// actual trigger screenshot, excluding the circle's fill/ring near its edge.
export async function expectSectionEmojiInkCentered(trigger) {
  const png = (await trigger.screenshot()).toString("base64");
  const offset = await trigger.evaluate(async (_button, png) => {
    const response = await fetch(`data:image/png;base64,${png}`);
    const image = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    image.close();
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.36;
    const inside = (x, y) =>
      (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < radius ** 2;
    // The most frequent interior color is the control background in either
    // theme, including its filled/open and outlined/focused states.
    const colors = new Map();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!inside(x, y)) continue;
        const i = (y * width + x) * 4;
        const color = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        colors.set(color, (colors.get(color) ?? 0) + 1);
      }
    }
    const background = [...colors]
      .sort((a, b) => b[1] - a[1])[0][0]
      .split(",")
      .map(Number);
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!inside(x, y)) continue;
        const i = (y * width + x) * 4;
        if (
          Math.max(...background.map((v, c) => Math.abs(v - data[i + c]))) > 32
        ) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
    }
    if (right < 0) throw new Error("Section emoji screenshot contains no ink");
    return Math.abs((left + right + 1) / 2 - cx) / devicePixelRatio;
  }, png);
  // Native text is rasterized onto a device-pixel grid. This detects the
  // reported one-CSS-pixel shift while allowing half-pixel rounding.
  expect(offset).toBeLessThanOrEqual(0.5);
}
