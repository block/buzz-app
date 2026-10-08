import type * as Pretext from "@chenglou/pretext";
import type * as Rich from "@chenglou/pretext/rich-inline";
import {
  createRowHeights,
  KANA_SAMPLE,
  type Font,
  type Measurer,
  type Metrics,
  type RowHeights,
  type TextReason,
} from "./model";

/** Canvas text measurement exists (browsers, not jsdom or Node). Without it
 * no estimator is passed and Virtua keeps its stock sizing. */
export const capable =
  typeof OffscreenCanvas !== "undefined" &&
  typeof document !== "undefined" &&
  !!document.fonts &&
  typeof matchMedia === "function";

export type Environment = Readonly<{
  /** Undefined until Pretext has loaded and `document.fonts.ready` resolved. */
  model?: RowHeights | undefined;
  /** Undefined while dirty: until calibrated in this font epoch. */
  metrics?: Metrics | undefined;
  /** Action bars take no space only with hover and a fine pointer. */
  hover: boolean;
  /** Font load version. */
  fonts: number;
}>;
let model: RowHeights | undefined;
let metrics: Metrics | undefined;
let pretext: typeof Pretext | undefined;
let fontsReady = false;
let hover = false;
let epoch = 0;
let fonts = 0;
let snapshot: Environment = { hover, fonts };
const listeners = new Set<() => void>();
function publish() {
  snapshot = { model: fontsReady ? model : undefined, metrics, hover, fonts };
}
function notify() {
  publish();
  for (const listener of listeners) listener();
}
export const environment = Object.freeze({
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  snapshot: () => snapshot,
});

/** A new font epoch: recalibrate, and prepare text again. Never for width. */
function invalidate() {
  metrics = undefined;
  pretext?.clearCache();
  prepared = 0;
  faces = new Map();
  kanaShaped = undefined;
  notify();
}
/** Calibration reads the probe once per font epoch; while its fonts load it
 * stays dirty and the next notification retries. From a ResizeObserver
 * callback (`observed`), the render that resize schedules reads the new
 * snapshot, and subscribers hear after the observer's delivery: a synchronous
 * render there would mount rows mid-delivery (a ResizeObserver loop error). */
export function calibrate(
  read: () => Omit<Metrics, "epoch"> | undefined,
  observed = false,
) {
  if (metrics || !fontsReady) return;
  const next = read();
  if (!next || guard("x", next.text.body) === undefined) return;
  metrics = { ...next, epoch: ++epoch };
  if (!observed) return notify();
  publish();
  setTimeout(notify);
}

// Inter's unicode-range subsets load lazily. Each text waits for the faces it
// needs, so fallback widths never reach Pretext's cache. WebKit's
// `FontFace.status` and `check()` can claim readiness early; a face counts
// once its own load promise resolved or it reports "loaded".
type Face = Readonly<{ face: FontFace; ranges: readonly number[][] }>;
/** Faces per family and style, read once per font epoch. */
let faces = new Map<string, readonly Face[]>();
const loaded = new WeakSet<FontFace>();
const loading = new WeakSet<FontFace>();
const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");
function facesOf(font: Font) {
  // "<style> <weight> <size> <family stack>"
  const [style = "normal", , , ...stack] = font.font.split(" ");
  const family = unquote(stack.join(" ").split(",")[0] ?? "");
  const key = `${style} ${family}`;
  let list = faces.get(key);
  if (!list) {
    list = [...document.fonts]
      .filter((face) => unquote(face.family) === family && face.style === style)
      .map((face) => ({
        face,
        ranges: face.unicodeRange.split(",").map((range) =>
          range
            .trim()
            .replace(/^U\+/i, "")
            .split("-")
            .map((bound) => Number.parseInt(bound, 16)),
        ),
      }));
    faces.set(key, list);
  }
  return list;
}
const covers = (ranges: readonly number[][], point: number) =>
  ranges.some(([low = 0, high = low]) => point >= low && point <= high);
/** Characters outside Inter's subsets render in system fallback fonts,
 * which canvas and the DOM can round differently: their line count must
 * hold within 2px of the width. */
const FALLBACK_GUARD = 2;
// Characters the exactness sweeps verified in every engine (docs/channels.md):
// ASCII; the letters, marks and digits of the Latin, Greek, Cyrillic, Hebrew,
// Arabic, Devanagari, Thai, kana, Han and Hangul blocks below; the listed
// punctuation, symbols and joiners; CJK punctuation; emoji outside the BMP.
// The engines break or measure others unlike Pretext: other dashes, spaces
// and fractions, BMP pictographs, letters in other fallback fonts.
const western = "\\u00a0¡£§©«®°±¶·»¿×÷—‘’“”†‡•…′″€™←↑→↓−∞≈≠≤≥";
const cjkMarks = "、。，！？：；・";
const ideographic = `\\u3041-\\u30ff\\u4e00-\\u9fff${cjkMarks}`;
const cjk = `${ideographic}\\uac00-\\ud7a3`;
const verified = new RegExp(
  `^(?:[\\x20-\\x7e${western}\\u200c-\\u200f\\u060c\\u061b\\u061f\\u066a-\\u066c\\u06d4\\u0964${cjkMarks}]|(?=[\\p{L}\\p{M}\\p{Nd}])[\\u00c0-\\u017f\\u01a0\\u01a1\\u01af\\u01b0\\u0218-\\u021b\\u0300-\\u036f\\u0386-\\u03ce\\u0400-\\u0481\\u048a-\\u04ff\\u05b0-\\u05b9\\u05bb\\u05bc\\u05bf\\u05c1\\u05c2\\u05d0-\\u05ea\\u0620-\\u065e\\u0660-\\u0669\\u066e-\\u06d5\\u06ee-\\u06ff\\u0900-\\u097f\\u0e00-\\u0e7f\\u1e00-\\u1fff\\u3041-\\u30ff\\u4e00-\\u9fff\\uac00-\\ud7a3]|(?=[\\u{1f300}-\\u{1faff}])(?!\\p{Emoji_Modifier})\\p{Emoji_Presentation}(?:(?<=\\p{Emoji_Modifier_Base})\\p{Emoji_Modifier})?|[\\u{1f1e6}-\\u{1f1ff}]{2})*$`,
  "u",
);
// Beside CJK text, punctuation other than ASCII; CJK punctuation beside
// anything but Han, kana or a space: the engines break, trim, hang and fit
// them unlike Pretext.
const cjkText = new RegExp(`[${cjk}]`);
const cjkPunctuation = new RegExp(
  `[${western}]|[${cjkMarks}](?=[^\\s${ideographic}])|(?<=[^\\s${ideographic}])[${cjkMarks}]`,
  "u",
);
const cjkPunctuated = (text: string) =>
  cjkText.test(text) && cjkPunctuation.test(text);
// A word with punctuation has the shapes the sweeps found the engines break
// as Pretext does: an opener; a number, Latin, Greek or Cyrillic letters
// joined by single hyphens or apostrophes, or other letters; then closers.
// Or a lone dash or ellipsis. Symbols and emoji only stand in words without
// punctuation.
const punctuation = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e¡¿«»‘’“”—…؛؟۔।]/;
const alphabetic = "[\\p{sc=Latin}\\p{sc=Greek}\\p{sc=Cyrillic}\\p{M}]+";
const letters = `[\\p{L}\\p{M}\\p{Nd}\\u00a0\\u200c-\\u200f${cjk}]+`;
const closers = `%?[.,!?:;)"'’”»…]{0,3}`;
const shaped = new RegExp(
  `^(?:["'(¡¿«‘“$]?(?:(?:\\d+(?:[-.,:/]\\d+)*|${alphabetic}(?:[-'’]${alphabetic})*|${letters})${closers}|[\\p{sc=Arabic}\\p{sc=Devanagari}\\p{M}\\u200c-\\u200f]+[؛؟।])|[-—…]|[.!?]{1,3})$`,
  "u",
);
const shapedWord = (word: string) =>
  !punctuation.test(word) || shaped.test(word);
// Chromium shapes a word's leading punctuation in the script of the letters
// before it, so beside letters of another script it loses its kerning; and
// right-to-left text reorders punctuation beside numbers unlike Pretext.
const scripts = [
  /\p{sc=Latin}/u,
  /\p{sc=Greek}/u,
  /\p{sc=Cyrillic}/u,
  /[^\P{L}\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}]/u,
];
const opened = /(?:^|\s)(?!\p{Extended_Pictographic})[\p{P}\p{S}]/u;
const rtl = /[\p{sc=Hebrew}\p{sc=Arabic}]/u;
const punctuatedNumber =
  /\p{Nd}[^\s\p{L}\p{M}\p{Nd}]|[^\s\p{L}\p{M}\p{Nd}]\p{Nd}/u;
// The engines break beside some emoji (as ideographs) and not others.
const emoji =
  "[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{1f1e6}-\\u{1f1ff}]";
const glued = new RegExp(
  `[\\p{L}\\p{M}\\p{N}]${emoji}|${emoji}[\\p{L}\\p{M}\\p{N}]`,
  "u",
);
/** Why the engine may break a `<br>` segment's text (all its text nodes)
 * between words unlike Pretext. */
export function wordBreaks(text: string): TextReason | undefined {
  if (cjkPunctuated(text)) return "cjk-punctuation";
  if (!text.split(" ").every(shapedWord)) return "punctuation";
  if (opened.test(text) && scripts.filter((s) => s.test(text)).length > 1)
    return "scripts";
  if (rtl.test(text) && punctuatedNumber.test(text)) return "bidi";
  if (glued.test(text)) return "emoji";
  return undefined;
}
// Kana the engine shapes unlike canvas (Chromium kerns it): RowHeightProbe
// measures the sample's DOM width once per font epoch. Pretext breaks
// before small kana; the engines do not.
const kana = /[\p{sc=Hiragana}\p{sc=Katakana}]/u;
const smallKana = /[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ]/;
let kanaShaped: boolean | undefined;
/** `undefined` while a needed Inter subset loads (and starts its load), a
 * reason when the model cannot lay this text out as the engine does, else
 * the width margin its line count must hold across. */
export function guard(
  text: string,
  font: Font,
): number | TextReason | undefined {
  if (!verified.test(text)) return "characters";
  if (cjkPunctuated(text)) return "cjk-punctuation";
  if (kana.test(text)) {
    if (smallKana.test(text)) return "kana";
    if (pretext && metrics) {
      kanaShaped ??=
        Math.abs(
          pretext.measureNaturalWidth(
            pretext.prepareWithSegments(KANA_SAMPLE, metrics.text.body.font),
          ) - metrics.kana,
        ) >
        1 / 64;
      if (kanaShaped) return "kana";
    }
  }
  // ASCII needs only the subset covering "A".
  const points = /[\u0080-\uffff]/.test(text)
    ? new Set(Array.from(text, (char) => char.codePointAt(0) ?? 0))
    : [0x41];
  const list = facesOf(font);
  let fallback = false;
  let pending: FontFace | undefined;
  for (const point of points) {
    const face = list.find(({ ranges }) => covers(ranges, point))?.face;
    if (!face) fallback = true;
    else if (face.status !== "loaded" && !loaded.has(face)) pending = face;
  }
  if (pending) {
    const face = pending;
    if (!loading.has(face)) {
      loading.add(face);
      face.load().then(
        () => {
          loaded.add(face);
          fonts++;
          notify();
        },
        () => {},
      );
    }
    return undefined;
  }
  return fallback ? FALLBACK_GUARD : 0;
}

// Pretext caches segment widths without bound; each prepared text keeps its
// own, so clearing past a budget only makes later preparation measure again.
const CACHE_CHARACTERS = 1_500_000;
let prepared = 0;
function charge(module: typeof Pretext, text: string) {
  prepared += text.length;
  if (prepared <= CACHE_CHARACTERS) return;
  module.clearCache();
  prepared = text.length;
}
/** A text node's width margin and its widest word: the engine breaks a
 * word wider than a line by its own measure of the pieces (kerned, joined),
 * unlike the model. */
type Prepared = Readonly<{
  text: Pretext.PreparedText;
  guard: number;
  widest: number;
}>;
/** A segment of several text nodes or atomic boxes: whether each may start
 * a line (has whitespace before it), the width margin its line breaks must
 * hold across, and its widest button (one wider than a line wraps inside). */
type Flow = Readonly<{
  rich: Rich.PreparedRichInline;
  open: readonly boolean[];
  edge: number;
  widest: number;
}>;
/** Canvas and layout sum glyph advances in their own float precision, and
 * Chromium fits a line up to a layout unit wider than its box. */
const PRECISION = 1 / 128;
const EDGE = 1 / 64 + PRECISION;
const spacing = ({ letterSpacing }: Font) =>
  letterSpacing ? { letterSpacing } : undefined;
// Inter's own letters and punctuation, where kerning and ligatures apply.
const inter = /^[\u0020-\u024f\u0370-\u052f\u1e00-\u1fff\u2000-\u206f]$/u;
let canvas: OffscreenCanvasRenderingContext2D | null | undefined;
/** Pretext measures the pieces between break opportunities apart; the
 * engine shapes across some of them ("->" ligatures in both engines, "-T"
 * kerning in Chromium). Where two adjacent pieces measure differently
 * together, the text is left to measurement. */
function shaping(
  { segments, kinds, widths }: Pretext.PreparedTextWithSegments,
  font: Font,
) {
  for (let index = 1; index < segments.length; index++) {
    const before = segments[index - 1] ?? "";
    const after = segments[index] ?? "";
    if (kinds[index - 1] !== "text" || kinds[index] !== "text") continue;
    if (!inter.test(before.at(-1) ?? "") || !inter.test(after[0] ?? ""))
      continue;
    canvas ??= new OffscreenCanvas(1, 1).getContext("2d");
    if (!canvas) return true;
    canvas.font = font.font;
    const apart = (widths[index - 1] ?? 0) + (widths[index] ?? 0);
    if (Math.abs(canvas.measureText(before + after).width - apart) > PRECISION)
      return true;
  }
  return false;
}
/** Where each line of a flow ends, or why the engine may break otherwise:
 * at a text node boundary inside a word, which the engine never breaks
 * ("glue"), or inside a word (overflow-wrap; "wrap"). */
function flowBreaks(rich: typeof Rich, flow: Flow, width: number) {
  const ends: string[] = [];
  let cursor: Rich.RichInlineCursor = {
    itemIndex: 0,
    segmentIndex: 0,
    graphemeIndex: 0,
  };
  for (;;) {
    const line = rich.layoutNextRichInlineLineRange(flow.rich, width, cursor);
    if (!line) return ends;
    const { itemIndex, segmentIndex, graphemeIndex } = line.end;
    if (graphemeIndex > 0) return "wrap";
    if (
      segmentIndex === 0 &&
      itemIndex < flow.open.length &&
      !flow.open[itemIndex]
    )
      return "glue";
    ends.push(`${itemIndex}:${segmentIndex}`);
    cursor = line.end;
  }
}
function measurer(module: typeof Pretext, rich: typeof Rich): Measurer {
  return {
    prepare(runs): Prepared | Flow | TextReason | undefined {
      let margin = EDGE;
      let pending = false;
      for (const { text, font, box } of runs) {
        if (!text) continue;
        const guarded = guard(text, font);
        if (typeof guarded === "string") return guarded;
        // A button lays its label out at `line-height: normal`, where a
        // fallback font's taller line grows the button past the body line.
        if (box !== undefined && guarded) return "mention-font";
        if (guarded === undefined) pending = true;
        else margin = Math.max(margin, guarded);
      }
      // A box breaks the text around it like a letter: punctuation touching
      // it belongs to it as to a word. The engine breaks at its edges only
      // where Pretext may too (or "glue" below).
      const whole = runs
        .map(({ text, box }) => (box === undefined ? text : "x"))
        .join("");
      const reason = wordBreaks(whole);
      if (reason) return reason;
      if (pending) return undefined;
      charge(module, whole);
      let widest = 0;
      let buttons = 0;
      for (const { text, font, box } of runs) {
        if (!text) continue;
        const prepared = module.prepareWithSegments(
          text,
          font.font,
          spacing(font),
        );
        if (shaping(prepared, font)) return "shaping";
        if (box !== undefined)
          buttons = Math.max(
            buttons,
            module.measureNaturalWidth(prepared) + box,
          );
        else
          for (const advance of prepared.widths)
            widest = Math.max(widest, advance);
        if (runs.length === 1 && box === undefined)
          return { text: prepared, guard: margin, widest };
      }
      // A node boundary without whitespace is inside a word: the engine
      // shapes nodes of one font there as one run, unlike the model. Boxes
      // are shaped apart, and both engines break on either side of one,
      // whatever touches it, as Pretext does between items.
      const open: boolean[] = [];
      let space = true;
      let previous: string | undefined;
      for (const { text, font, box } of runs) {
        open.push(box !== undefined || space || /^\s/u.test(text));
        if (box !== undefined) {
          space = true;
          previous = undefined;
          continue;
        }
        if (!text.trim()) {
          space = true;
          continue;
        }
        if (!open.at(-1) && previous === font.font) return "glue";
        previous = font.font;
        space = /\s$/u.test(text);
      }
      return {
        rich: rich.prepareRichInline(
          runs.map(({ text, font, box }) => ({
            text: text || "0",
            font: font.font,
            ...spacing(font),
            // A box without text is "0" less its own width.
            ...(box === undefined
              ? {}
              : {
                  break: "never" as const,
                  extraWidth:
                    box -
                    (text
                      ? 0
                      : module.measureNaturalWidth(
                          module.prepareWithSegments(
                            "0",
                            font.font,
                            spacing(font),
                          ),
                        )),
                }),
          })),
        ),
        open,
        // Chromium rounds each text node and box on a line to its layout unit.
        edge: margin + runs.length / 64,
        widest: buttons,
      };
    },
    // Line breaks must hold across the margin, or they are a knife edge.
    lines(value, width) {
      if ("rich" in value) {
        const flow = value as Flow;
        if (width - flow.edge < flow.widest) return "wrap";
        const ends = flowBreaks(rich, flow, width);
        if (typeof ends === "string") return ends;
        for (const margin of [-flow.edge, flow.edge]) {
          const near = flowBreaks(rich, flow, width + margin);
          if (typeof near === "string" || near.join() !== ends.join())
            return "edge";
        }
        return ends.length;
      }
      const { text, guard, widest } = value as Prepared;
      if (width - guard < widest) return "wrap";
      const lines = module.layout(text, width - guard, 1).lineCount;
      return lines === module.layout(text, width + guard, 1).lineCount
        ? lines
        : "edge";
    },
    width(text, font) {
      const margin = guard(text, font);
      if (typeof margin !== "number") return margin;
      charge(module, text);
      return (
        module.measureNaturalWidth(
          module.prepareWithSegments(text, font.font, spacing(font)),
        ) + margin
      );
    },
  };
}

if (capable) {
  // Launch renders the restored timeline before this resolves, so that first
  // Virtualizer usually keeps Virtua's own estimate, unseeded.
  void document.fonts.ready.then(() => {
    fontsReady = true;
    notify();
  });
  // A lazy chunk, requested with the timeline's module rather than at its
  // first mount, so a timeline opened after launch is predicted from its
  // first commit.
  void Promise.all([
    import("@chenglou/pretext"),
    import("@chenglou/pretext/rich-inline"),
  ]).then(([module, rich]) => {
    pretext = module;
    model = createRowHeights(measurer(module, rich));
    notify();
  });
  const pointer = matchMedia("(hover: hover) and (pointer: fine)");
  hover = pointer.matches;
  // Hover only gates the model: no calibrated metric depends on it.
  pointer.addEventListener("change", () => {
    hover = pointer.matches;
    notify();
  });
  // Text scale is the root font size. Other root style writes, such as a
  // resize handle's cursor, are not a new epoch.
  const root = document.documentElement;
  let size = getComputedStyle(root).fontSize;
  new MutationObserver(() => {
    const next = getComputedStyle(root).fontSize;
    if (next === size) return;
    size = next;
    invalidate();
  }).observe(root, { attributes: true, attributeFilter: ["style"] });
  snapshot = { hover, fonts };
}
