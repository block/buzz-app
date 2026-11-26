import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only: stacking contexts, painted pixels and media preferences need a
// real engine. The fixture registers a red layer whose content sits at z-index 1,
// then a blue layer at z-index auto. Registration order must decide the paint.
test.use({ pluginFixtures: true, enabledPlugins: ["fixture.backdrops"] });

const red = [255, 0, 0];
const blue = [0, 0, 255];

/** The painted color at each viewport point, read from a real screenshot. */
async function paint(page, points) {
  const png = (await page.screenshot({ scale: "css" })).toString("base64");
  return page.evaluate(
    async ({ png, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return points.map(([x, y]) =>
        [
          ...context.getImageData(Math.round(x), Math.round(y), 1, 1).data,
        ].slice(0, 3),
      );
    },
    { png, points },
  );
}
const near = (actual, expected) =>
  actual.every((value, index) => Math.abs(value - expected[index]) <= 2);
/** Seen through the glass sheet: softened, but still clearly the blue layer. */
const throughGlass = ([r, g, b]) => b - Math.max(r, g) > 40;

/** Solid `bg-app` resolved to rgb, as the engine paints it. */
const appColor = (page) =>
  page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--bg-app)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color.match(/\d+/g).slice(0, 3).map(Number);
  });

test("registered backdrops paint in order between the shell and its controls, and step aside for user preferences", async ({
  page,
  app,
}) => {
  await open(page, app);
  const layer = page.locator(".shell-backdrop");
  await expect(layer.locator(".shell-backdrop-layer")).toHaveCount(2);
  const points = await page.evaluate(() => {
    const header = document
      .querySelector(".shell-header")
      .getBoundingClientRect();
    const toggle = document
      .querySelector("[data-shell-sidebar-toggle]")
      .getBoundingClientRect();
    const history = document
      .querySelector(".shell-history")
      .getBoundingClientRect();
    const main = document
      .getElementById("main-content")
      .getBoundingClientRect();
    const card = document
      .querySelector("[data-sidebar-card]")
      .getBoundingClientRect();
    return {
      // Below the header row, beside the bottom of the window: the glass sheet.
      gutter: [window.innerWidth - 2, window.innerHeight - 2],
      // Inside the history group, above its icons, and just outside it: the
      // group's own fill and the floor's spread around it.
      group: [history.left + history.width / 2, history.top + 3],
      floor: [toggle.left - 3, header.top + header.height / 2],
      pane: [main.left + main.width / 2, main.top + main.height / 2],
      // Sidebar cards float like the conversation: opaque inside, with the
      // backdrop showing through the glass sheet in the gap below the first.
      dock: [card.left + card.width / 2, card.bottom - 3],
      gap: [card.left + card.width / 2, card.bottom + 3],
    };
  });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    const [gutter, group, floor, pane, dock, gap] = await paint(page, [
      points.gutter,
      points.group,
      points.floor,
      points.pane,
      points.dock,
      points.gap,
    ]);
    expect(throughGlass(gutter), `${mode} gutter ${gutter}`).toBe(true);
    const app = await appColor(page);
    expect(near(group, app), `${mode} header group ${group}`).toBe(true);
    expect(near(floor, app), `${mode} header floor ${floor}`).toBe(true);
    expect(
      near(dock, blue) || near(dock, red),
      `${mode} sidebar card ${dock}`,
    ).toBe(false);
    expect(throughGlass(gap), `${mode} sidebar gap ${gap}`).toBe(true);
    expect(near(pane, blue) || near(pane, red), `${mode} pane ${pane}`).toBe(
      false,
    );
  }

  // The sidebar grip appears on hover. It sits at the conversation card's edge,
  // after the panel gap that separates it from the sidebar. That gap is a bare
  // gutter, so the backdrop paints there as it does at the window's edge; the
  // pixels on the card's side match the card well below the grip.
  const grip = page.getByRole("separator", { name: "Resize sidebar" });
  await grip.hover();
  await expect
    .poll(() => grip.evaluate((el) => getComputedStyle(el, "::after").opacity))
    .toBe("0.5");
  const seam = await grip.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const after = getComputedStyle(el, "::after");
    return {
      x: box.left + Number.parseFloat(after.left),
      half: Number.parseFloat(after.width) / 2,
      y: box.top + box.height / 2,
    };
  });
  const [gutter, gapBeside, gapBelow, cardBeside, cardBelow] = await paint(
    page,
    [
      points.gutter,
      [seam.x - seam.half - 2, seam.y],
      [seam.x - seam.half - 2, seam.y + 100],
      [seam.x + seam.half + 1, seam.y],
      [seam.x + seam.half + 1, seam.y + 100],
    ],
  );
  expect(near(gapBeside, gapBelow), `gap ${gapBeside} vs ${gapBelow}`).toBe(
    true,
  );
  expect(near(gapBeside, gutter), `gap ${gapBeside} vs ${gutter}`).toBe(true);
  expect(
    near(cardBeside, cardBelow),
    `card side ${cardBeside} vs ${cardBelow}`,
  ).toBe(true);
  expect(
    near(cardBeside, blue) || near(cardBeside, red),
    `card side ${cardBeside}`,
  ).toBe(false);
  await page.mouse.move(0, 0);

  for (const preference of [
    { reducedMotion: "reduce" },
    // Chromium models forced colors; WebKit has no emulation.
    ...(page.context().browser().browserType().name() === "chromium"
      ? [{ forcedColors: "active" }]
      : []),
  ]) {
    await page.emulateMedia(preference);
    await expect(layer).toHaveCount(0);
    // Clear the preference explicitly; null restores the runner's OS setting.
    await page.emulateMedia({
      reducedMotion: "no-preference",
      forcedColors: "none",
    });
    await expect(layer.locator(".shell-backdrop-layer")).toHaveCount(2);
  }
});
