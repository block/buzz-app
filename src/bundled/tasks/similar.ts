// Plain word comparison for tasks: enough to catch an agent describing the
// same thing twice, never a judgment a person should make.
const SMALL = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "it",
  "this",
  "that",
  "be",
  "by",
  "at",
  "or",
  "from",
  "as",
]);

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word && !SMALL.has(word)),
  );

/** How alike two titles are, from 0 to 1: shared words over all words. */
export function sameness(a: string, b: string) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

/** Whether `text` holds every word of `query`. */
export function holdsWords(query: string, text: string) {
  const have = words(text);
  return [...words(query)].every((word) => have.has(word));
}
