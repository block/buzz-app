import type { Ref } from "react";
import type { Contribution } from "../../../plugins/contributions";
import { formatItemTimestamp } from "../../../shared/datetime";
import { AtIcon, RobotIcon } from "../../../shared/design-system/icons/index";
import reference from "../../../shared/InlineReference.module.css";
import { ContributionBoundary } from "../../conversation/ContributionBoundary";
import type { InlineRenderer } from "../../conversation/contracts";
import links from "../../conversation/LinkPreview.module.css";
import type { ChannelMessage } from "../../relay/contracts";
import styles from "../Messages.module.css";
import { type Font, KANA_SAMPLE, type Metrics } from "./model";

const LATIN_SAMPLE = "The quick brown fox jumps over a lazy dog.";
// Paragraphs of one, two and three lines, as remark-breaks renders them.
const one = <p>x</p>;
const two = (
  <p>
    x<br />x
  </p>
);
const three = (
  <p>
    x<br />x<br />x
  </p>
);
// Text styles (strong, emphasis and both), the canvas font size, kana
// shaping, and a link chip at its cap (its paragraph is as wide as it).
const styled = (
  <>
    <p>
      x<strong>x</strong>
      <em>
        x<strong>x</strong>
      </em>
      <span data-sample="latin">{LATIN_SAMPLE}</span>
      <span data-sample="kana">{KANA_SAMPLE}</span>
    </p>
    <p data-sample="chip">
      <a href="#chip" className={links.chip}>
        {LATIN_SAMPLE.repeat(4)}
      </a>
    </p>
  </>
);
// One line of every atomic inline box, as MessageMarkdown renders them: a
// person's and an agent's mention button, a link chip with the bundled
// renderer's class, and a custom emoji when the bundled renderer is
// registered (its placeholder: the same box as an image).
const message = {
  id: "probe",
  channelId: "probe",
  authorId: "probe",
  content: ":probe:",
  createdAt: 0,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  emoji: [{ shortcode: "probe", url: "https://probe.invalid/probe.png" }],
} satisfies ChannelMessage;
const unavailable = () => undefined;
const boxes = (emoji?: Contribution<InlineRenderer>) => (
  <p data-sample="boxes">
    x{" "}
    <button type="button" className={reference.link} data-mention-kind="person">
      <AtIcon aria-hidden="true" className={reference.icon} />x
    </button>{" "}
    <button type="button" className={reference.link} data-mention-kind="agent">
      <RobotIcon aria-hidden="true" className={reference.icon} />x
    </button>{" "}
    <a href="#chip" className={`${links.chip} ${reference.link}`}>
      x
    </a>
    {emoji && (
      <span data-sample="emoji">
        <ContributionBoundary fallback={null}>
          <emoji.component
            text=":probe:"
            content={{ text: ":probe:", message }}
            media={unavailable}
          />
        </ContributionBoundary>
      </span>
    )}
  </p>
);
const rows = [
  ["t1", "timeline", one],
  ["t2", "timeline", two],
  ["t3", "timeline", three],
  [
    "tp",
    "timeline",
    <>
      {one}
      {one}
    </>,
  ],
  ["td", "timeline", one, true],
  ["c1", "continuation", one],
  ["c2", "continuation", two],
  ["c3", "continuation", three],
  ["ts", "continuation", styled],
  ["tb", "timeline", boxes],
] as const;

/** Calibration rows after the list, in its inline size: mounted only while
 * the font epoch is uncalibrated, and never painted or scrollable. The
 * wrapper stays as the list-width reference. Each row is a message row as
 * MessageRow renders it with hover, without `data-message-id` (the anchor,
 * reading and reveal code query it) and no `ol` (the timeline watches
 * Virtua's). */
export function RowHeightProbe({
  ref,
  calibrating,
  emoji,
}: {
  ref: Ref<HTMLDivElement>;
  calibrating: boolean;
  /** The bundled custom emoji renderer, when registered. */
  emoji?: Contribution<InlineRenderer> | undefined;
}) {
  return (
    <div ref={ref} className={styles.rowProbe} aria-hidden="true" inert>
      {calibrating &&
        rows.map(([name, layout, text, day]) => (
          <div key={name} data-probe={name}>
            <div>
              {day && (
                <div className={styles.day}>
                  <span>Today</span>
                </div>
              )}
              <div className={styles.message} data-layout={layout}>
                {layout === "timeline" ? (
                  <span className="buzz-avatar" data-size="large" />
                ) : (
                  <span className={styles.messageGutter}>
                    <time className={styles.continuationTime}>
                      <span>1:00</span>
                    </time>
                  </span>
                )}
                <div className={styles.messageBody} data-probe-column="">
                  <div className={styles.messageHeader}>
                    <div
                      className={
                        layout === "timeline" ? styles.byline : "sr-only"
                      }
                    >
                      <strong className={styles.author}>A</strong>
                      {layout === "timeline" && (
                        <time>
                          <span>1:00 PM</span>
                        </time>
                      )}
                    </div>
                  </div>
                  <div className={styles.text}>
                    {typeof text === "function" ? text(emoji) : text}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

/** A text style as a canvas font, at `size` when given. */
function font(element: Element | null, size?: number): Font | undefined {
  if (!element) return undefined;
  const style = getComputedStyle(element);
  return {
    font: `${style.fontStyle} ${style.fontWeight} ${size ?? Number.parseFloat(style.fontSize)}px ${style.fontFamily}`,
    letterSpacing: Number.parseFloat(style.letterSpacing) || 0,
  };
}
/** The size body text lays out in, as canvas measures it. Chromium can lay
 * text out a hundredth of a pixel smaller than computed (18.2px at a 1.3
 * text scale as 18.19px): the size whose sample width equals the DOM's. */
function bodySize(paragraph: Element | null) {
  const sample = paragraph?.querySelector('[data-sample="latin"]');
  const canvas = new OffscreenCanvas(1, 1).getContext("2d");
  if (!paragraph || !sample || !canvas) return undefined;
  const width = sample.getBoundingClientRect().width;
  const size = Number.parseFloat(getComputedStyle(paragraph).fontSize);
  return [size, (Math.ceil(size * 100) - 1) / 100].find((candidate) => {
    canvas.font = font(paragraph, candidate)?.font ?? "";
    return Math.abs(canvas.measureText(LATIN_SAMPLE).width - width) <= 1 / 64;
  });
}
/** Every byline time form here, from today's time to an earlier year's date:
 * each weekday with each month. The model bounds the digits. */
function timeLabels(now = new Date()) {
  const labels = new Set<string>();
  const at = (date: Date) =>
    labels.add(
      formatItemTimestamp(date.getTime() / 1000, {
        withTime: true,
        nowSeconds: now.getTime() / 1000,
      }),
    );
  const year = now.getFullYear();
  for (const hour of [10, 22]) {
    for (let day = 0; day < 7; day++)
      at(new Date(year, now.getMonth(), now.getDate() - day, hour, 58));
    for (let month = 0; month < 12; month++) {
      for (let day = 22; day <= 28; day++)
        at(new Date(year, month, day, hour, 58));
      at(new Date(year - 1, month, 28, hour, 58));
    }
  }
  return [...labels];
}
/** One batched read of the mounted probe. Heights are what Virtua measures:
 * each probe row, like its item, contains its children's margins. */
export function readProbe(
  probe: HTMLElement,
): Omit<Metrics, "epoch"> | undefined {
  const row = (name: string) =>
    probe.querySelector(`[data-probe="${name}"]`)?.getBoundingClientRect()
      .height ?? Number.NaN;
  const [
    t1 = Number.NaN,
    t2 = Number.NaN,
    t3 = Number.NaN,
    tp = Number.NaN,
    td = Number.NaN,
    c1 = Number.NaN,
    c2 = Number.NaN,
    c3 = Number.NaN,
  ] = ["t1", "t2", "t3", "tp", "td", "c1", "c2", "c3"].map(row);
  const pitch = t3 - t2;
  const first = probe.querySelector('[data-probe="t1"]');
  const styles = probe.querySelector('[data-probe="ts"] p');
  const size = bodySize(styles);
  if (size === undefined) return undefined;
  // Every style at the body size; a byline time's width has a pixel's slack.
  const style = (selector: string, root = styles) =>
    font(root?.querySelector(selector) ?? null, size);
  const body = font(styles, size);
  const bold = style(":scope > strong");
  const italic = style(":scope > em");
  const boldItalic = style("em > strong");
  const name = style("strong", first);
  const time = font(first?.querySelector("time") ?? null);
  const byline = first?.querySelector("strong")?.parentElement;
  const column = probe.querySelector('[data-probe="c1"] [data-probe-column]');
  // Lines must stack by one pitch in both layouts, or the model is wrong here.
  if (!(pitch > 0) || c3 - c2 !== pitch || !body || !name || !time)
    return undefined;
  const kana = styles
    ?.querySelector('[data-sample="kana"]')
    ?.getBoundingClientRect().width;
  if (!bold || !italic || !boldItalic || !kana) return undefined;
  if (!byline || !column) return undefined;
  return {
    pitch,
    gap: tp - t2,
    day: td - t1,
    single: { timeline: t1, continuation: c1 },
    chrome: { timeline: t2 - 2 * pitch, continuation: c2 - 2 * pitch },
    inset:
      probe.getBoundingClientRect().width -
      column.getBoundingClientRect().width,
    bylineGap: Number.parseFloat(getComputedStyle(byline).columnGap) || 0,
    text: { body, bold, italic, "bold-italic": boldItalic },
    name,
    time,
    times: timeLabels(),
    kana,
    boxes: readBoxes(probe, t1),
  };
}
/** A box's advance: its width and inline margins. */
function advance(element: Element | null | undefined) {
  if (!element) return Number.NaN;
  const style = getComputedStyle(element);
  return (
    element.getBoundingClientRect().width +
    Number.parseFloat(style.marginLeft) +
    Number.parseFloat(style.marginRight)
  );
}
const fontProperties = [
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "letterSpacing",
] as const;
/** Atomic boxes, when a line holding one of each is one body line and a
 * button lays its label out in the paragraph's font. */
function readBoxes(probe: HTMLElement, single: number): Metrics["boxes"] {
  const row = probe.querySelector('[data-probe="tb"]');
  const line = row?.querySelector('[data-sample="boxes"]');
  const chip = probe.querySelector('[data-sample="chip"] a');
  if (!row || !line || !chip || row.getBoundingClientRect().height !== single)
    return undefined;
  const paragraph = getComputedStyle(line);
  const buttons = [...line.querySelectorAll("button")];
  if (
    buttons.some((button) => {
      const style = getComputedStyle(button);
      return fontProperties.some((key) => style[key] !== paragraph[key]);
    })
  )
    return undefined;
  const [person = Number.NaN, agent = Number.NaN] = buttons.map((button) =>
    advance(button.querySelector("svg")),
  );
  if (!(person >= 0 && agent >= 0)) return undefined;
  // The renderer's output for unavailable media: one image, no text.
  const sample = line.querySelector('[data-sample="emoji"]');
  const image = sample?.firstElementChild;
  const emoji =
    sample?.childElementCount === 1 &&
    image?.tagName === "IMG" &&
    !sample.textContent
      ? advance(image)
      : undefined;
  return {
    person,
    agent,
    ...(emoji === undefined ? {} : { emoji }),
    chip: chip.getBoundingClientRect().width,
  };
}
