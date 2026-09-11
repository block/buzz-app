/** Start/whitespace/opening-bracket boundaries exclude URLs, times and closed codes. */
export function emojiQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const match = before.match(/(?:^|[\s([{]):([a-zA-Z0-9_+-]{2,64})$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, end: caret, query };
}
