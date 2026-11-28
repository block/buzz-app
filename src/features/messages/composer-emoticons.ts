import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import {
  composerMarkdownContext,
  composerSchema as schema,
  markdownRanges,
  projectComposerDocument,
} from "./composer-document";

// Forms that also read as ordinary text (`8)`, `D:`, `):`) stay literal.
const EMOTICONS: Readonly<Record<string, readonly string[]>> = {
  "🙂": [":)", ":-)", "=)"],
  "😞": [":(", ":-("],
  "😉": [";)", ";-)"],
  "😄": [":D", ":-D"],
  "😛": [":P", ":-P", ":p", ":-p"],
  "😜": [";P", ";-P", ";p", ";-p"],
  "😮": [":O", ":-O", ":o", ":-o"],
  "😕": [":/", ":-/", ":\\", ":-\\"],
  "😐": [":|", ":-|"],
  "😢": [":'(", ":'-("],
  "😠": [">:(", ">:-("],
  "😘": [":*", ":-*"],
  "❤️": ["<3"],
  "💔": ["</3"],
};

const replacements = Object.entries(EMOTICONS)
  .flatMap(([emoji, texts]) => texts.map((text) => ({ text, emoji })))
  .sort((a, b) => b.text.length - a.text.length);
const longest = replacements[0]?.text.length ?? 0;

const leafText = (node: Node) =>
  node.type === schema.nodes.hard_break ? "\n" : "￼";

/** Replace the emoticon ending at `end` with its emoji when whitespace or the
 * line's edges surround it. Code, links and literal text keep it, including
 * raw Markdown code that was pasted or restored rather than typed. */
export function applyComposerEmoticon(tr: Transaction, end: number): boolean {
  const $end = tr.doc.resolve(end);
  const parent = $end.parent;
  if (!parent.isTextblock || parent.type.spec.code) return false;
  const offset = $end.parentOffset;
  const text = (from: number, to: number) =>
    parent.textBetween(
      Math.max(0, from),
      Math.min(parent.content.size, to),
      undefined,
      leafText,
    );
  if (!/^\s?$/u.test(text(offset, offset + 1))) return false;
  const before = text(offset - longest - 1, offset);
  const match = replacements.find(
    (item) =>
      before.endsWith(item.text) &&
      /^\s?$/u.test(
        text(offset - item.text.length - 1, offset - item.text.length),
      ),
  );
  if (!match) return false;
  const from = end - match.text.length;
  const source = projectComposerDocument(tr.doc);
  const context = composerMarkdownContext(tr.doc, source);
  const start = source.source(from),
    stop = source.source(end);
  if (
    [...context.protected, ...markdownRanges(context.text).literal].some(
      (range) => start < range.end && stop > range.start,
    )
  )
    return false;
  tr.insertText(match.emoji, from, end);
  return true;
}
