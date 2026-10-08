import type { ChannelMessage } from "../../relay/contracts";
import type { Placement } from "./placement";
import {
  type Inputs,
  prose,
  type Prose,
  type ProseReason,
  readsInputs,
  type Run,
} from "./prose";

export type Font = Readonly<{ font: string; letterSpacing: number }>;
/** One font epoch's live DOM measurements (RowHeightProbe). Heights add
 * exactly: every value is a multiple of the engines' 1/64px layout unit. */
export type Metrics = Readonly<{
  epoch: number;
  /** One body line. */
  pitch: number;
  /** Between two paragraphs. */
  gap: number;
  /** The day divider above a row. */
  day: number;
  /** A row with one line of text. */
  single: Readonly<Record<Placement["layout"], number>>;
  /** A row with two or more lines, less those lines. */
  chrome: Readonly<Record<Placement["layout"], number>>;
  /** The list's width less the text column's. */
  inset: number;
  /** Between the byline's name and time. */
  bylineGap: number;
  /** Paragraph text in each style. */
  text: Readonly<Record<Run["style"], Font>>;
  name: Font;
  time: Font;
  /** Labels a byline time can show here; the widest must fit beside a name. */
  times: readonly string[];
  /** The DOM width of KANA_SAMPLE in body text. */
  kana: number;
  /** Atomic inline boxes on a body line: a mention icon's advance (a
   * person's, an agent's), a custom emoji, and the link chip's cap; undefined
   * where a line holding them is not one body line (docs/channels.md). */
  boxes?:
    | Readonly<{ person: number; agent: number; emoji?: number; chip: number }>
    | undefined;
}>;
/** Kana an engine may kern (Chromium does, canvas does not). */
export const KANA_SAMPLE = "キスキスキステスト";
/** Why the measurer cannot lay text out exactly. */
export type TextReason =
  | "edge"
  | "glue"
  | "wrap"
  | "mention-font"
  | "shaping"
  | "kana"
  | "cjk-punctuation"
  | "characters"
  | "punctuation"
  | "scripts"
  | "bidi"
  | "emoji";
/** Text layout (Pretext in browsers): a `<br>` segment's text nodes in their
 * fonts, and atomic boxes `box` wider than their text. `prepare` gives
 * `undefined` while a font it needs loads; a reason from either step leaves
 * the text to measurement. */
export type Measurer = Readonly<{
  prepare(
    runs: readonly Readonly<{ text: string; font: Font; box?: number }>[],
  ): object | TextReason | undefined;
  lines(prepared: object, width: number): number | TextReason;
  width(text: string, font: Font): number | TextReason | undefined;
}>;
export type Context = Readonly<{
  metrics: Metrics;
  /** The text column's width. */
  width: number;
  inputs: Inputs;
  /** The name a timeline row's byline shows. */
  name(row: ChannelMessage): string;
  /** Font load version: a pending font is retried when it changes. */
  fonts: number;
}>;
const SAMPLE =
  "The quick brown fox jumps over a lazy dog while engineers review layout.";
export type Reason =
  | ProseReason
  | TextReason
  | "font"
  | "byline"
  | "budget"
  | "boxes"
  | "link-width";

/** Characters of prepared text kept for layout at another width: about
 * 18 bytes each in Chromium (Pretext keeps per-segment advances), so at most
 * about 5.5 MB. Past it, the oldest rows keep only their last height and
 * prepare again for another width. */
const RETAINED = 300_000;

type Entry = {
  /** The inputs the prose was described with, and whether it read more than
   * the renderer registries. */
  inputs: Inputs;
  reads: boolean;
  prose: Prose | ProseReason;
  epoch?: number;
  /** Per segment, a laid-out text or, with link chips, the text at the
   * chips' least and greatest widths. A reason: the measurer cannot lay this
   * text out exactly; `undefined`: not prepared, or no longer retained. */
  prepared?: (object | [object, object])[][] | Reason | undefined;
  characters?: number;
  /** The font version when preparing last waited for a font. */
  pending?: number;
  width?: number;
  lines?: number | Reason;
};

/** Heights of rows the model can determine exactly. Text results are cached
 * by row identity and survive placement, so a prepend re-predicts the former
 * first row's divider and header from cached text. Parsing and preparing are
 * the expensive steps; with `compute` false a row that needs them is a
 * "budget" miss. */
export function createRowHeights(measurer: Measurer) {
  const rows = new WeakMap<ChannelMessage, Entry>();
  const names = new Map<string, number | TextReason>();
  let widthsEpoch = -1;
  let timeWidth: number | undefined;
  let charWidth: number | undefined;
  // Widths of one font epoch.
  function widths({ epoch }: Metrics) {
    if (widthsEpoch === epoch && names.size <= 2000) return;
    names.clear();
    widthsEpoch = epoch;
    timeWidth = undefined;
    charWidth = undefined;
  }
  // Rows holding prepared text of this font epoch, oldest first.
  let retained: Entry[] = [];
  let retainedEpoch = -1;
  let characters = 0;
  function retain(entry: Entry, epoch: number) {
    if (retainedEpoch !== epoch) {
      for (const old of retained)
        if (old.epoch !== epoch) old.prepared = undefined;
      retained = [];
      retainedEpoch = epoch;
      characters = 0;
    }
    retained.push(entry);
    characters += entry.characters ?? 0;
    // The newest stays: its layout follows.
    while (characters > RETAINED && retained.length > 1) {
      const old = retained.shift();
      if (!old) break;
      characters -= old.characters ?? 0;
      old.prepared = undefined;
    }
  }
  function nameFits(name: string, context: Context, compute: boolean) {
    const { metrics } = context;
    widths(metrics);
    if (timeWidth === undefined) {
      if (!compute) return "budget";
      // Times use proportional digits: write each label with the widest.
      let digit = "0";
      let digitWidth = 0;
      for (const candidate of "0123456789") {
        const width = measurer.width(candidate, metrics.time);
        if (typeof width !== "number") return width ?? "font";
        if (width > digitWidth) [digit, digitWidth] = [candidate, width];
      }
      let widest = 0;
      for (const label of new Set(
        metrics.times.map((time) => time.replace(/\d/g, digit)),
      )) {
        const width = measurer.width(label, metrics.time);
        if (typeof width !== "number") return width ?? "font";
        widest = Math.max(widest, width);
      }
      timeWidth = widest;
    }
    let width = names.get(name);
    if (width === undefined) {
      if (!compute) return "budget";
      width = measurer.width(name, metrics.name);
      if (width === undefined) return "font";
      names.set(name, width);
    }
    if (typeof width === "string") return width;
    // A pixel of slack absorbs canvas/DOM rounding at the wrap edge.
    return width + metrics.bylineGap + timeWidth <= context.width - 1;
  }
  return {
    /** A rough height for Virtua's default size of rows left unknown, which
     * are mostly what the model leaves to measurement: lines of text wrapped
     * by length, a gap between Markdown blocks (paragraphs, lists, quotes,
     * code, headings, tables), the padding and inner margins of quotes and
     * code (about two gaps), and the strips a row adds below its text (see
     * Messages.module.css). Never a prediction. */
    estimate(row: ChannelMessage, placement: Placement, context: Context) {
      const { metrics, width } = context;
      const { pitch, gap } = metrics;
      widths(metrics);
      charWidth ??=
        (Number(measurer.width(SAMPLE, metrics.text.body)) ||
          SAMPLE.length * 7) / SAMPLE.length;
      let lines = 0;
      let blocks = 0;
      let extra = 0;
      // The kind of block the previous line is in; "" after a blank line.
      let open = "";
      for (const line of row.content.split("\n")) {
        const text = line.trim();
        if (/^(```|~~~)/.test(text)) {
          open = open === "`" ? "" : "`";
          if (open === "`") {
            blocks++;
            extra += 2 * gap;
          }
        } else if (open === "`")
          lines++; // Code lines do not wrap.
        else if (!text) open = "";
        else {
          const marker = /^(?:([#>|])|[-*+] |\d+[.)] )/.exec(text);
          const kind = marker ? (marker[1] ?? "-") : "p";
          if (kind !== open || kind === "#") blocks++;
          if (kind === ">" && open !== ">") extra += 2 * gap;
          open = kind;
          lines += Math.max(1, Math.ceil((text.length * charWidth) / width));
        }
      }
      if (row.reactions.length) extra += pitch + gap;
      if (row.replyCount > 0) extra += pitch + gap;
      // Images and videos as one fallback tile (360 by 320px), other files
      // as a strip each.
      const media = row.attachments.filter(
        ({ kind }) => kind === "image" || kind === "video",
      ).length;
      if (media) extra += Math.min(width, 360) * (8 / 9);
      extra += (row.attachments.length - media) * (pitch + gap);
      return (
        (placement.day ? metrics.day : 0) +
        (lines === 1 && blocks === 1 && !extra
          ? metrics.single[placement.layout]
          : metrics.chrome[placement.layout] +
            lines * pitch +
            Math.max(0, blocks - 1) * gap +
            extra)
      );
    },
    predict(
      row: ChannelMessage,
      placement: Placement,
      context: Context,
      compute = true,
    ): number | Reason {
      // Inputs are stable until a plugin, profile, name, channel or agent
      // changes. A row that reads only the registries keeps its prose when
      // nothing else changed; a recomputed prose that is unchanged keeps its
      // prepared text.
      const { inputs } = context;
      let entry = rows.get(row);
      if (
        !entry ||
        (entry.inputs !== inputs &&
          (entry.reads ||
            entry.inputs.messages !== inputs.messages ||
            entry.inputs.inline !== inputs.inline))
      ) {
        if (!compute) return "budget";
        const next = prose(row, inputs);
        if (entry && JSON.stringify(next) === JSON.stringify(entry.prose))
          entry.inputs = inputs;
        else {
          entry = { inputs, reads: readsInputs(row), prose: next };
          rows.set(row, entry);
        }
      } else entry.inputs = inputs;
      const text = entry.prose;
      if (typeof text === "string") return text;
      const { metrics, width } = context;
      if (
        entry.epoch !== metrics.epoch ||
        (entry.width !== width && entry.prepared === undefined)
      ) {
        if (entry.pending === context.fonts) return "font";
        if (!compute) return "budget";
        const { boxes } = metrics;
        // A box's text is a button's label; its width beyond it is the
        // icon's advance, or the whole box. A chip's is at least none and
        // at most its cap: the text must take as many lines at both.
        const items = (runs: readonly Run[], chip: number) =>
          runs.map(({ text, style, box }) => {
            const font = metrics.text[style];
            if (!box) return { text, font };
            if (box === "person" || box === "agent")
              return { text, font, box: boxes?.[box] ?? Number.NaN };
            const width = box === "chip" ? chip : boxes?.emoji;
            return { text: "", font, box: width ?? Number.NaN };
          });
        const prepare = (runs: readonly Run[]) => {
          if (!runs.some(({ box }) => box))
            return measurer.prepare(items(runs, 0));
          const low = items(runs, 0);
          if (!boxes || low.some(({ box }) => Number.isNaN(box)))
            return "boxes";
          const least = measurer.prepare(low);
          if (
            typeof least !== "object" ||
            !runs.some(({ box }) => box === "chip")
          )
            return least;
          const most = measurer.prepare(items(runs, boxes.chip));
          return typeof most === "object"
            ? ([least, most] as [object, object])
            : most;
        };
        const prepared = text.map((segments) => segments.map(prepare));
        if (prepared.some((segments) => segments.includes(undefined))) {
          entry.pending = context.fonts;
          return "font";
        }
        const reason = prepared
          .flat()
          .find((value) => typeof value === "string");
        Object.assign(entry, {
          prepared: reason ?? (prepared as (object | [object, object])[][]),
          characters: text
            .flat(2)
            .reduce((sum, run) => sum + run.text.length, 0),
          epoch: metrics.epoch,
          width: -1,
        });
        if (!reason) retain(entry, metrics.epoch);
      }
      if (typeof entry.prepared === "string") return entry.prepared;
      if (entry.width !== width) {
        entry.width = width;
        let lines: number | Reason = 0;
        // Each `<br>` segment takes at least one line.
        for (const segment of (entry.prepared ?? []).flat()) {
          let count: number | Reason | undefined;
          for (const bound of Array.isArray(segment) ? segment : [segment]) {
            const next = measurer.lines(bound, width);
            count =
              typeof next === "string" || count === undefined || count === next
                ? next
                : "link-width";
            if (typeof count === "string") break;
          }
          if (typeof count === "string") {
            lines = count;
            break;
          }
          lines += Math.max(1, count ?? 0);
        }
        entry.lines = lines;
      }
      if (typeof entry.lines === "string") return entry.lines;
      if (placement.layout === "timeline") {
        const fits = nameFits(context.name(row), context, compute);
        if (fits !== true) return fits === false ? "byline" : fits;
      }
      const lines = entry.lines ?? 0;
      const height =
        lines === 1
          ? metrics.single[placement.layout]
          : metrics.chrome[placement.layout] +
            lines * metrics.pitch +
            (text.length - 1) * metrics.gap;
      return (placement.day ? metrics.day : 0) + height;
    },
  };
}
export type RowHeights = ReturnType<typeof createRowHeights>;
