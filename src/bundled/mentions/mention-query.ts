/** Syntax only. Multi-word queries are admitted separately against current names. */
export function mentionQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 160), caret);
  const match = before.match(/(?:^|[\s([{])@([^@\n\r\t]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  // A bounded slice beginning in the middle of a word is not a boundary.
  if (start && !/[\s([{]/u.test(text[start - 1] ?? "")) return null;
  return { start, end: caret, query };
}

export function matchesMentionQuery(query: string, names: readonly string[]) {
  if (!query.includes(" ")) return true;
  const lower = query.toLowerCase();
  if (
    lower.endsWith(" ") &&
    names.some((name) => name.toLowerCase() === lower.trimEnd())
  )
    return false;
  return names.some((name) => name.toLowerCase().startsWith(lower));
}
