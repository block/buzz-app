// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
  bitty,
  bittyColors,
  bittyFile,
  bittyHeads,
  bittySeed,
  bittySkins,
  contrast,
  randomBittySeed,
} from "./generated-avatars";

const names = Array.from({ length: 2000 }, (_, index) => `review-${index}`);
const avatars = names.map((name) => bitty(bittySeed(name)));

// The avatar-squircle.svg curve as a polygon in unit space.
const curve = (points: number[][]) =>
  Array.from({ length: 64 }, (_, step) => {
    const t = step / 64;
    const u = 1 - t;
    const [p0, p1, p2, p3] = points as [number[], number[], number[], number[]];
    return [0, 1].map(
      (axis) =>
        u * u * u * (p0[axis] as number) +
        3 * u * u * t * (p1[axis] as number) +
        3 * u * t * t * (p2[axis] as number) +
        t * t * t * (p3[axis] as number),
    ) as [number, number];
  });
const squircle = [
  ...curve([
    [0.5, 0],
    [0.93, 0],
    [1, 0.07],
    [1, 0.5],
  ]),
  ...curve([
    [1, 0.5],
    [1, 0.93],
    [0.93, 1],
    [0.5, 1],
  ]),
  ...curve([
    [0.5, 1],
    [0.07, 1],
    [0, 0.93],
    [0, 0.5],
  ]),
  ...curve([
    [0, 0.5],
    [0, 0.07],
    [0.07, 0],
    [0.5, 0],
  ]),
];
const insideSquircle = (x: number, y: number) => {
  let inside = false;
  for (let i = 0, j = squircle.length - 1; i < squircle.length; j = i++) {
    const [xi, yi] = squircle[i] as [number, number];
    const [xj, yj] = squircle[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
};
/** Face cells: eye and mouth ink and highlights, on rows 4–8. */
const faceCells = (art: ReturnType<typeof bitty>) =>
  art.grid.flatMap((row, r) =>
    row.flatMap((color, c) =>
      r >= 4 &&
      r <= 8 &&
      (color === art.traits.ink || color === art.traits.highlight)
        ? [{ r, c, color }]
        : [],
    ),
  );

it("draws the same avatar for the same name, ignoring case and spacing", () => {
  expect(bittySeed("  Princess   Donut ")).toBe(bittySeed("princess donut"));
  expect(bittySeed("CARL")).toBe(bittySeed("Carl"));
  expect(bittySeed("ｃａｒｌ")).toBe(bittySeed("carl"));
  expect(bittySeed("Carl")).not.toBe(bittySeed("Carla"));
  expect(bittySeed("Carl", "v1")).not.toBe(bittySeed("Carl"));
  expect(bitty(bittySeed("Carl"))).toEqual(bitty(bittySeed("Carl")));
  expect(randomBittySeed()).toMatch(/^[0-9a-f]{32}$/);
  expect(randomBittySeed()).not.toBe(randomBittySeed());
});

it("keeps the version-1 grammar stable", () => {
  // A grammar change must bump bittyVersion instead of changing these.
  expect(
    ["Carl", "Princess Donut", "eggboy", "Fizz", "Sol"].map((name) => {
      const { background, traits } = bitty(bittySeed(name));
      return [
        background,
        traits.skin,
        traits.head,
        traits.top,
        traits.eyes,
        traits.mouth,
      ].join(" ");
    }),
  ).toMatchInlineSnapshot(`
    [
      "#F97316 #FFC6E0 round sprout tall grin",
      "#F43F5E #F2F2F2 pear puffs bright wide",
      "#06B6D4 #FFC6E0 pear sprout bright small",
      "#0090FF #FFC6E0 bean nubs dot oh",
      "#6366F1 #B5EEF2 egg topknot tall smile",
    ]
  `);
});

it("meets every contrast and shape rule over 2,000 names", () => {
  const skins = new Set<string>(bittySkins.map(([base]) => base));
  const lowest = {
    "skin/background": Infinity,
    "shirt/background,skin": Infinity,
    "hair/background,skin": Infinity,
    "ink/skin": Infinity,
    "highlight/skin": Infinity,
    "highlight/ink": Infinity,
    "stalk/background": Infinity,
  };
  const low = (rule: keyof typeof lowest, value: number) => {
    lowest[rule] = Math.min(lowest[rule], value);
  };
  const faces = new Set<string>();
  let clipped = 0;
  let offHead = 0;
  for (const art of avatars) {
    const { background, traits } = art;
    expect(skins.has(traits.skin)).toBe(true);
    low("skin/background", contrast(traits.skin, background));
    low(
      "shirt/background,skin",
      Math.min(
        contrast(traits.shirt, background),
        contrast(traits.shirt, traits.skin),
      ),
    );
    low(
      "hair/background,skin",
      Math.min(
        contrast(traits.hair, background),
        contrast(traits.hair, traits.skin),
      ),
    );
    for (const { r, c, color } of faceCells(art)) {
      if (!insideSquircle((c + 0.5) / 12, (r + 0.5) / 12)) clipped++;
      if (color === traits.ink) low("ink/skin", contrast(color, traits.skin));
      else {
        low("highlight/skin", contrast(color, traits.skin));
        low("highlight/ink", contrast(color, traits.ink));
      }
    }
    // Eyes, mouth and blush sit on the head, not the background beside it.
    const widths = bittyHeads[traits.head];
    art.grid.slice(4, 9).forEach((row, index) => {
      const r = index + 4;
      const edge = 6 - (widths[r - 2] as number);
      for (const [c, color] of row.entries())
        if (
          (color === traits.ink ||
            color === traits.highlight ||
            color === "#F59AB0") &&
          Math.min(c, 11 - c) < edge
        )
          offHead++;
    });
    if (traits.top === "antennae" || traits.top === "bulb")
      low(
        "stalk/background",
        contrast((art.grid[1] as string[]).find(Boolean) as string, background),
      );
    // Each cell's role (skin, ink, highlight, hair, blush, tongue, other),
    // ignoring color: how many faces look different.
    faces.add(
      art.grid
        .slice(4, 9)
        .map((row) =>
          row
            .map((color) =>
              color === null
                ? "."
                : color === traits.skin
                  ? "s"
                  : color === traits.ink
                    ? "i"
                    : color === traits.highlight
                      ? "w"
                      : color === traits.hair
                        ? "h"
                        : color === "#F59AB0"
                          ? "c"
                          : color === "#F25C7A"
                            ? "t"
                            : "o",
            )
            .join(""),
        )
        .join("/"),
    );
  }
  console.info(
    `Bitties over ${names.length} names: ${faces.size} distinct faces, ${offHead} face cells off the head; lowest`,
    Object.fromEntries(
      Object.entries(lowest).map(([rule, value]) => [rule, value.toFixed(3)]),
    ),
  );
  expect(lowest["skin/background"]).toBeGreaterThanOrEqual(1.6);
  expect(lowest["shirt/background,skin"]).toBeGreaterThanOrEqual(1.4);
  expect(lowest["hair/background,skin"]).toBeGreaterThanOrEqual(1.5);
  expect(lowest["ink/skin"]).toBeGreaterThanOrEqual(3);
  expect(lowest["highlight/skin"]).toBeGreaterThanOrEqual(1.5);
  expect(lowest["highlight/ink"]).toBeGreaterThanOrEqual(1.5);
  expect(lowest["stalk/background"]).toBeGreaterThanOrEqual(3);
  expect(clipped).toBe(0);
  expect(offHead).toBe(0);
  // Gating highlights off pale skins left 777 of these; tinting keeps them.
  expect(faces.size).toBeGreaterThan(1000);
});

it("prepares a square 480 px PNG with the background filled in", async () => {
  const art = bitty(bittySeed("Carl"));
  expect(bittyColors(art)).toHaveLength(144);
  expect(bittyColors(art)).not.toContain(null);
  const fills: string[] = [];
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      return {
        set fillStyle(color: string) {
          fills.push(color);
        },
        fillRect() {},
      } as unknown as CanvasRenderingContext2D;
    } as never);
  const sizes: number[] = [];
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation(function (this: HTMLCanvasElement, done, type) {
      sizes.push(this.width, this.height);
      done(new Blob(["png"], { type: type ?? "" }));
    });
  try {
    const file = await bittyFile(bittySeed("Carl"));
    expect(file.type).toBe("image/png");
    expect(sizes).toEqual([480, 480]);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(fills).toEqual(bittyColors(art));
  } finally {
    getContext.mockRestore();
    toBlob.mockRestore();
  }
});

it("rejects instead of encoding a blank image when the canvas cannot paint", async () => {
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");
  try {
    await expect(bittyFile(bittySeed("Carl"))).rejects.toThrow(
      "Could not prepare the avatar image.",
    );
    expect(toBlob).not.toHaveBeenCalled();
  } finally {
    getContext.mockRestore();
    toBlob.mockRestore();
  }
});
