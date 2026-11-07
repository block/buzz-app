import { plainText, shortText } from "../notifications/content";

/** The first paragraph, and whether more follows it. */
function firstParagraph(content: string) {
  const text = content.trim();
  const end = /\r?\n[^\S\r\n]*\r?\n/.exec(text)?.index;
  return end === undefined
    ? { text, cut: false }
    : { text: text.slice(0, end).trimEnd(), cut: true };
}

/** A compact excerpt: stop before an empty paragraph rather than clamping a blank line. */
export function messagePreviewText(content: string): string {
  const { text, cut } = firstParagraph(content);
  return cut ? `${text}…` : text;
}

/** The excerpt's rendered prose on one line: no Markdown syntax or spoiler
 * text. Source that renders no prose stays visible rather than blank. */
export function activityPreviewText(content: string) {
  const { text, cut } = firstParagraph(content);
  const prose = plainText(text, { limit: Infinity }) || text;
  return shortText(cut ? `${prose}…` : prose, 280);
}
