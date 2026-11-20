// Picker and autocomplete share Emoji Mart's usage store: its Frequently used
// row and the counts that rank colon suggestions. Mart keeps at most the
// picker's two rows, plus the latest choice, whenever a picker opens.
const STORE = "emoji-mart.frequently";
/** The composer picker's most columns. */
const WIDEST_ROW = 8;

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

/** Seed Mart's one default row, `perLine` wide, with weights below one choice
 * before Mart reads a store it treats as empty; Mart's own seed would save its
 * defaults as whole choices. */
export function seedEmojiUsage(defaults: readonly string[], perLine: number) {
  try {
    if (!emptyStore(localStorage.getItem(STORE))) return;
    const row = defaults.slice(0, perLine);
    const seed = Object.fromEntries(
      row.map((id, index) => [id, (row.length - index) / (row.length + 1)]),
    );
    localStorage.setItem(STORE, JSON.stringify(seed));
    localStorage.removeItem("emoji-mart.last");
  } catch {
    /* Like Mart, selection works without localStorage. */
  }
}

function emptyStore(stored: string | null) {
  try {
    const counts: unknown = JSON.parse(stored || "null");
    return !counts || typeof counts !== "object" || !Object.keys(counts).length;
  } catch {
    return true;
  }
}

/** How many times each suggestion was chosen; 0 when unknown or unreadable. */
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
    // Whole choices only: default seeds stay below one.
    return typeof count === "number" && Number.isFinite(count) && count >= 1
      ? Math.floor(count)
      : 0;
  };
}

/** Record through Mart itself: it caches the counts and rewrites them whole. */
export function recordEmojiUsage(scope: string, id: string) {
  const key = usageId(scope, id);
  if (!key) return;
  void import("emoji-mart")
    .then(({ FrequentlyUsed }) => {
      // Without a picker width, seed the widest picker row.
      seedEmojiUsage(FrequentlyUsed.DEFAULTS, WIDEST_ROW);
      FrequentlyUsed.add({ id: key });
    })
    .catch(() => {
      /* Insertion already happened; usage is best effort, like Mart's own. */
    });
}
