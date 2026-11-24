import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { EditorState, Transaction } from "prosemirror-state";
import {
  composerSchema as schema,
  projectComposerDocument,
  composerMarkdownContext,
} from "./composer-document";

// Slack's table, so faces convert as Slack users expect, then a few common
// faces it lacks. The curly-quote cry is what macOS smart quotes type.
export const EMOTICONS: Readonly<Record<string, string>> = {
  ":o)": "🐵",
  "</3": "💔",
  "=)": "😃",
  "=-)": "😃",
  ":D": "😄",
  ":-D": "😄",
  ":>": "😆",
  ":->": "😆",
  ";)": "😉",
  ";-)": "😉",
  "8)": "😎",
  ":|": "😐",
  ":-|": "😐",
  ":\\": "😕",
  ":-\\": "😕",
  ":/": "😕",
  ":-/": "😕",
  ":*": "😘",
  ":-*": "😘",
  ":p": "😛",
  ":-p": "😛",
  ":P": "😛",
  ":-P": "😛",
  ":b": "😛",
  ":-b": "😛",
  ";p": "😜",
  ";-p": "😜",
  ";b": "😜",
  ";-b": "😜",
  ";P": "😜",
  ";-P": "😜",
  "):": "😞",
  ":(": "😞",
  ":-(": "😞",
  ">:(": "😠",
  ">:-(": "😠",
  ":'(": "😢",
  "D:": "😧",
  ":o": "😮",
  ":-o": "😮",
  ":O": "😮",
  ":-O": "😮",
  ":)": "🙂",
  "(:": "🙂",
  ":-)": "🙂",
  "<3": "❤️",
  ":’(": "😢",
  XD: "😆",
  xD: "😆",
  "B-)": "😎",
  "8-)": "😎",
  "-_-": "😑",
};
// Longest first, so >:( wins over :(.
const FACES = Object.keys(EMOTICONS).sort((a, b) => b.length - a.length);
const LONGEST = FACES[0]?.length ?? 0;

// Markdown the timeline renders as prose. Code, links, images and HTML keep
// their typed text.
const PROSE = new Set([
  "root",
  "paragraph",
  "heading",
  "strong",
  "emphasis",
  "delete",
  "blockquote",
  "list",
  "listItem",
  "text",
]);

/** Whether `text` leaves a parenthesis open on its last line: one pass, no
 * regex, so a long paragraph costs only its length. */
function openParen(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "\n") depth = 0;
    else if (char === "(") depth++;
    else if (char === ")" && depth) depth--;
  }
  return depth > 0;
}

const children = (node: Nodes): readonly Nodes[] =>
  "children" in node ? node.children : [];

/** An emoticon such as `:D` or `<3`, typed as its own word right before the
 * caret, becomes its emoji. `typed` is the Space just typed after it, or empty
 * when Enter ends it. Faces in code, links or literal text, inside an unclosed
 * backtick on their line, or inside authored fenced source stay as typed. The
 * caller closes history around the transaction, so one undo restores the face. */
export function composerEmoticon(
  state: EditorState,
  typed: string,
): Transaction | undefined {
  if (typed !== " " && typed !== "") return;
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.spec.code) return;
  // Space is typed constantly; read only the end of the line before parsing.
  const end = $from.parentOffset - typed.length;
  if (end < 0) return;
  const window = $from.parent.textBetween(
    Math.max(0, end - LONGEST - 1),
    $from.parentOffset,
    undefined,
    "￼",
  );
  if (!window.endsWith(typed)) return;
  const before = window.slice(0, window.length - typed.length);
  // The window holds one character before the longest face unless the line
  // starts sooner, so a face at its start begins the paragraph.
  const face = FACES.find((face) => {
    const at = before.length - face.length;
    return (
      before.endsWith(face) && (at === 0 || /\s/.test(before[at - 1] ?? ""))
    );
  });
  if (!face) return;
  const to = $from.pos - typed.length,
    from = to - face.length;
  // In "(see page 8)" the ")" closes the parenthesis. Other faces, such as
  // the :) in "(nice :)", still convert there.
  if (
    face === "8)" &&
    openParen(
      $from.parent.textBetween(0, from - $from.start(), undefined, "\ufffc"),
    )
  )
    return;
  if (
    (["code", "link", "literal"] as const).some((name) =>
      state.doc.rangeHasMark(from, to, schema.marks[name]),
    )
  )
    return;
  const source = projectComposerDocument(state.doc);
  const start = source.source(from),
    stop = source.source(to);
  if (stop - start !== face.length) return;
  const markdown = composerMarkdownContext(state.doc, source).text;
  // An odd backtick may still open inline code once its closer is typed.
  const line = markdown.slice(markdown.lastIndexOf("\n", start - 1) + 1, start);
  if ((line.match(/`/g)?.length ?? 0) % 2) return;
  let node: Nodes | undefined = fromMarkdown(markdown);
  while (node) {
    if (!PROSE.has(node.type)) return;
    node = children(node).find(
      (child) =>
        (child.position?.start.offset ?? Infinity) <= start &&
        (child.position?.end.offset ?? -1) >= stop,
    );
  }
  const emoji = EMOTICONS[face];
  return emoji ? state.tr.insertText(emoji, from, to) : undefined;
}
