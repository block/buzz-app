// Picker and autocomplete share Emoji Mart's usage store: its Frequently used
// row and the counts that rank colon suggestions.
const STORE = "emoji-mart.frequently";

/** The picker's ID for a community emoji, scoped like its catalog. */
export const customEmojiId = (scope: string, shortcode: string) =>
  `buzz-custom/${encodeURIComponent(scope)}/${shortcode}`;

/** Mart's usage ID for a suggestion ID: the base emoji across skin tones. */
function usageId(scope: string, id: string) {
  if (id.startsWith("unicode/")) return id.slice("unicode/".length);
  if (id.startsWith("custom/"))
    return customEmojiId(scope, id.slice("custom/".length));
  return undefined;
}

/** How often each suggestion was chosen; 0 when unknown or unreadable. */
export function emojiUsage(scope: string): (id: string) => number {
  let counts: Record<string, unknown> = {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    if (stored && typeof stored === "object")
      counts = stored as Record<string, unknown>;
  } catch {
    /* Without storage, suggestions keep their query order. */
  }
  return (id) => {
    const key = usageId(scope, id);
    const count = key && Object.hasOwn(counts, key) ? counts[key] : 0;
    return typeof count === "number" && count > 0 ? count : 0;
  };
}

/** Record through Mart itself: it caches the counts and rewrites them whole. */
export function recordEmojiUsage(scope: string, id: string) {
  const key = usageId(scope, id);
  if (!key) return;
  void import("emoji-mart")
    .then(({ FrequentlyUsed }) => FrequentlyUsed.add({ id: key }))
    .catch(() => {
      /* Insertion already happened; usage is best effort, like Mart's own. */
    });
}
