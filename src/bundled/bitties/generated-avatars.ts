/** Bitties: avatars drawn from an agent's name. A 128-bit seed picks traits
 * from an original grammar of front-facing, mirror-symmetric pixel busts on a
 * 12 × 12 grid. They are uploaded as ordinary PNGs; nothing here is a catalog
 * asset, and the seed is not saved. */

export const bittyVersion = 1;
const grid = 12;
const half = grid / 2;

/** Capitalization and spacing changes keep the avatar. */
const normalizeName = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

// cyrb128 and sfc32 are small public-domain algorithms: synchronous and the
// same on every engine, so typing never waits for a seed.
function cyrb128(text: string) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index++) {
    const k = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1, h2, h3, h4];
}
const hex = (words: number[]) =>
  words.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");

/** A name-driven seed; `nonce` picks a variant or a shuffle of the name. */
export const bittySeed = (name: string, nonce = "") =>
  hex(
    cyrb128(
      `buzz-avatar-v${bittyVersion}|bitties|${normalizeName(name)}|${nonce}`,
    ),
  );

/** A seed unrelated to any name. */
export function randomBittySeed() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return bittySeed("", hex([...words]).slice(0, 12));
}

function random(seed: string) {
  let [a, b, c, d] = [0, 1, 2, 3].map(
    (index) => Number.parseInt(seed.slice(index * 8, index * 8 + 8), 16) >>> 0,
  ) as [number, number, number, number];
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let index = 0; index < 12; index++) next();
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(next() * items.length)] as T;
  return {
    next,
    pick,
    chance: (probability: number) => next() < probability,
    weighted<T>(items: readonly (readonly [T, number])[]) {
      let left = next() * items.reduce((sum, [, weight]) => sum + weight, 0);
      for (const [value, weight] of items) {
        left -= weight;
        if (left < 0) return value;
      }
      return (items.at(-1) as readonly [T, number])[0];
    },
    /** Picks among candidates that meet `floor`, or else the best one, so a
     * failing color is never chosen while a passing one exists. */
    passing<T>(items: readonly T[], score: (item: T) => number, floor: number) {
      const passed = items.filter((item) => score(item) >= floor);
      if (passed.length) return pick(passed);
      next();
      return items.reduce((best, item) =>
        score(item) > score(best) ? item : best,
      );
    },
  };
}

const luminance = (color: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((index) => Number.parseInt(color.slice(index, index + 2), 16) / 255)
    .map((value) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two `#RRGGBB` colors. */
export const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
};
const darken = (color: string, amount: number) =>
  `#${[1, 3, 5]
    .map((index) =>
      Math.round(
        Number.parseInt(color.slice(index, index + 2), 16) * (1 - amount),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();

// The agent picker's exported artwork colors, minus near-black #18181B and
// #FBBF24, which no fantasy skin stands off.
const backgrounds = [
  "#F43F5E",
  "#EC4899",
  "#D946EF",
  "#8E4EC6",
  "#6366F1",
  "#0090FF",
  "#0EA5E9",
  "#06B6D4",
  "#14B8A6",
  "#30A46C",
  "#22C55E",
  "#84CC16",
  "#F59E0B",
  "#F97316",
  "#EA580C",
  "#EF4444",
  "#A16207",
  "#334155",
] as const;
/** Fantasy tones only, as [base, shadow]: mint, periwinkle, pink, lemon,
 * lilac, aqua and chalk. A tone drawn from a name hash should never read as
 * something about the person. */
export const bittySkins = [
  ["#B8F2C9", "#7FD49A"],
  ["#C9D7FF", "#93A8F0"],
  ["#FFC6E0", "#F08DBA"],
  ["#FFF1A8", "#E8CF5C"],
  ["#D9C9FF", "#AE95F2"],
  ["#B5EEF2", "#73CDD6"],
  ["#F2F2F2", "#C9C9C9"],
] as const;
const shirts = [
  "#1F2937",
  "#F8FAFC",
  "#7C3AED",
  "#0F766E",
  "#B91C1C",
  "#1D4ED8",
  "#CA8A04",
  "#BE185D",
];
const hairs = [
  "#2B1B12",
  "#5B3A21",
  "#B4542C",
  "#E6C35C",
  "#E8E8E8",
  "#3B82F6",
  "#22C55E",
  "#EC4899",
  "#7C3AED",
];
const ink = "#1A1423";
const lightInk = "#FFF1E6";
const blush = "#F59AB0";
const tongue = "#F25C7A";
const leaf = "#3FA34D";
const leafTip = "#6BD06F";
/** Half-widths of the head for rows 2–8. */
export const bittyHeads = {
  round: [2, 3, 4, 4, 4, 3, 2],
  egg: [2, 3, 3, 4, 4, 4, 3],
  bean: [3, 4, 4, 4, 4, 3, 2],
  block: [3, 4, 4, 4, 4, 4, 3],
  pear: [1, 2, 3, 4, 4, 4, 3],
  wide: [3, 4, 5, 5, 5, 4, 3],
  narrow: [2, 3, 3, 3, 3, 3, 2],
} as const;

export type Bitty = {
  background: string;
  /** Row-major cell colors; null shows the background. */
  grid: (string | null)[][];
  traits: {
    skin: string;
    shirt: string;
    hair: string;
    /** Eye and mouth ink, ≥ 3:1 on the skin. */
    ink: string;
    /** Eye shine and teeth, ≥ 1.5:1 on the skin. */
    highlight: string;
    head: keyof typeof bittyHeads;
    top: string;
    eyes: string;
    mouth: string;
  };
};

/** The avatar for `seed`; the same seed always draws the same avatar. */
export function bitty(seed: string): Bitty {
  const r = random(seed);
  const cells: (string | null)[][] = Array.from({ length: grid }, () =>
    Array<string | null>(grid).fill(null),
  );
  /** Paints a left-half cell and its mirror. */
  const set = (row: number, column: number, color: string | null) => {
    if (row < 0 || row >= grid || column < 0 || column >= half) return;
    (cells[row] as (string | null)[])[column] = color;
    (cells[row] as (string | null)[])[grid - 1 - column] = color;
  };
  /** Paints a centered run of half-width `width`. */
  const span = (row: number, width: number, color: string) => {
    for (let index = 0; index < width; index++)
      set(row, half - 1 - index, color);
  };
  const background = r.pick(backgrounds);
  const [skin, shadow] = r.passing(
    bittySkins,
    ([base]) => contrast(base, background),
    1.6,
  );
  const onBoth = (color: string) =>
    Math.min(contrast(color, background), contrast(color, skin));
  const shirt = r.passing(shirts, onBoth, 1.4);
  const hair = r.passing(hairs, onBoth, 1.5);
  const face = contrast(ink, skin) >= 3 ? ink : lightInk;
  // White shine vanishes on pale skin, so those get a darker skin tone. Both
  // stay ≥ 1.5:1 from the skin and from the ink (or a bright eye reads as
  // glasses); the generator test checks every skin.
  const highlight =
    contrast("#FFFFFF", skin) >= 1.5 ? "#FFFFFF" : darken(skin, 0.3);

  // Shoulders on rows 10–11, neck on row 9.
  const shoulders = r.pick(["slim", "broad", "round"] as const);
  span(11, shoulders === "slim" ? 4 : 5, shirt);
  span(10, shoulders === "broad" ? 4 : 3, shirt);
  if (shoulders === "round") {
    span(10, 4, shirt);
    set(10, 1, null);
  }
  span(9, 1, shadow);

  const head = r.pick(Object.keys(bittyHeads) as (keyof typeof bittyHeads)[]);
  const widths = bittyHeads[head];
  for (const [index, width] of widths.entries()) span(2 + index, width, skin);
  span(8, widths[6], shadow);

  const ears = r.weighted([
    ["none", 5],
    ["round", 2],
    ["tall", 1],
  ] as const);
  if (ears !== "none") set(5, half - 1 - widths[3], shadow);
  if (ears === "tall") set(4, half - 1 - widths[3], shadow);

  // No hats, caps, hoods or mohawks.
  const top = r.weighted([
    ["bare", 3],
    ["fringe", 3],
    ["swoop", 2],
    ["sprout", 2],
    ["antennae", 2],
    ["bulb", 1],
    ["nubs", 1],
    ["topknot", 2],
    ["crest", 1],
    ["puffs", 1],
  ] as const);
  const crown = widths[0];
  // Stalks stand on the background.
  const stalk = contrast(ink, background) >= 3 ? ink : lightInk;
  if (top === "fringe") {
    span(2, crown, hair);
    span(3, widths[1], hair);
    set(4, half - widths[2], hair);
  } else if (top === "swoop") {
    span(2, crown, hair);
    span(1, Math.max(1, crown - 1), hair);
    set(3, half - widths[1], hair);
  } else if (top === "sprout") {
    // The leaf leans one way; the only off-mirror detail.
    (cells[1] as (string | null)[])[5] = leaf;
    (cells[1] as (string | null)[])[4] = leafTip;
    (cells[0] as (string | null)[])[5] = leafTip;
  } else if (top === "antennae") {
    set(1, 3, stalk);
    set(0, 2, hair);
  } else if (top === "bulb") {
    set(1, 5, stalk);
    set(0, 5, hair);
  } else if (top === "nubs") {
    set(1, half - crown, shadow);
  } else if (top === "topknot") {
    span(2, crown, hair);
    span(1, 1, hair);
    span(0, 1, hair);
  } else if (top === "crest") {
    set(1, 5, hair);
    set(1, 3, hair);
    set(2, 4, hair);
    set(2, 5, hair);
  } else if (top === "puffs") {
    span(2, crown, hair);
    set(1, half - 1 - crown, hair);
    set(2, Math.max(0, half - 2 - crown), hair);
  }

  // Eyes on row 5. No two-wide dark eyes: paired dark bars read as glasses.
  const eyes = r.pick(["dot", "tall", "shine", "bright"] as const);
  // Every eye cell stays on the head, even on narrow rows.
  const edge = (row: number) => half - (widths[row - 2] as number);
  const eye = r.pick(
    [3, 4].filter(
      (column) =>
        column - (eyes === "bright" ? 1 : 0) >= edge(5) &&
        (eyes === "dot" || eyes === "bright" || column >= edge(4)),
    ),
  );
  if (eyes === "dot") set(5, eye, face);
  if (eyes === "tall") {
    set(4, eye, face);
    set(5, eye, face);
  }
  if (eyes === "shine") {
    set(4, eye, highlight);
    set(5, eye, face);
  }
  if (eyes === "bright") {
    set(5, eye, highlight);
    set(5, eye - 1, face);
  }
  if (r.chance(0.45)) set(6, Math.max(edge(6), eye - 1), blush);

  const mouth = r.pick([
    "small",
    "wide",
    "smile",
    "oh",
    "grin",
    "tongue",
  ] as const);
  if (mouth === "smile") set(8, 5, face);
  else set(7, 5, mouth === "grin" ? highlight : face);
  if (mouth === "wide" || mouth === "smile" || mouth === "grin")
    set(7, 4, face);
  if (mouth === "oh") set(8, 5, face);
  if (mouth === "tongue") set(8, 5, tongue);

  return {
    background,
    grid: cells,
    traits: {
      skin,
      shirt,
      hair,
      ink: face,
      highlight,
      head,
      top,
      eyes,
      mouth,
    },
  };
}

/** Every cell's painted color, row-major, with the background filled in. */
export const bittyColors = (art: Bitty) =>
  art.grid.flat().map((color) => color ?? art.background);

/** Paints flat cells onto a square canvas; `colors` is from `bittyColors`. */
export function paintBitty(
  canvas: HTMLCanvasElement,
  colors: readonly string[],
  size = 480,
): boolean {
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return false;
  const cell = size / grid;
  colors.forEach((color, index) => {
    context.fillStyle = color;
    context.fillRect(
      Math.floor((index % grid) * cell),
      Math.floor(Math.floor(index / grid) * cell),
      Math.ceil(cell),
      Math.ceil(cell),
    );
  });
  return true;
}

/** A 480 × 480 PNG of `seed`, square and unclipped; Avatar owns the mask. */
export async function bittyFile(seed: string): Promise<File> {
  const canvas = document.createElement("canvas");
  // Never encode a blank canvas: it would save as transparent artwork.
  if (!paintBitty(canvas, bittyColors(bitty(seed))))
    throw new Error("Could not prepare the avatar image.");
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(new Error("Could not prepare the avatar image.")),
      "image/png",
    ),
  );
  return new File([blob], "avatar.png", { type: "image/png" });
}
