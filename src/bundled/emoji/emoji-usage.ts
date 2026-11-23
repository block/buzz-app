// Picker and autocomplete share one usage history under Emoji Mart's storage
// key: it fills the picker's Frequently used row and ranks colon suggestions.
// It is read fresh on every use, so each window keeps the others' choices.
const STORE = "emoji-mart.frequently";
const LAST = "emoji-mart.last";
const SEED_REMOVED = "buzz.emoji-usage.seed-removed";
// Emoji Mart 5.6 seeded a new history with these defaults at perLine - i, as
// if chosen, and saved them with the first pick. Copied so that suggestions do
// not load Mart.
const MART_SEED = [
  "+1",
  "grinning",
  "kissing_heart",
  "heart_eyes",
  "laughing",
  "stuck_out_tongue_winking_eye",
  "sweat_smile",
  "joy",
  "scream",
  "disappointed",
  "unamused",
  "weary",
  "sob",
  "sunglasses",
  "heart",
];

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

function readCounts(): Record<string, unknown> {
  let counts: Record<string, unknown> = {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored))
      counts = stored as Record<string, unknown>;
  } catch {
    /* Without storage, nothing has been chosen. */
  }
  try {
    if (localStorage.getItem(SEED_REMOVED) === null) {
      if (removeMartSeed(counts))
        localStorage.setItem(STORE, JSON.stringify(counts));
      localStorage.setItem(SEED_REMOVED, "1");
    }
  } catch {
    /* Retried on the next read. */
  }
  return counts;
}

/** Subtracts Mart's seed once, keeping the picks made on top of it. The seed
 * width is unknown, so take the widest run every count can contain. */
function removeMartSeed(counts: Record<string, unknown>) {
  const count = (i: number) => uses(counts, MART_SEED[i] ?? "");
  let width = 0;
  for (let size = 1; size <= MART_SEED.length; size++) {
    let fits = true;
    for (let i = 0; i < size && fits; i++) fits = count(i) >= size - i;
    if (fits) width = size;
  }
  for (let i = 0; i < width; i++) {
    const id = MART_SEED[i] ?? "";
    const left = count(i) - (width - i);
    if (left > 0) counts[id] = left;
    else delete counts[id];
  }
  return width > 0;
}

function uses(counts: Record<string, unknown>, key: string) {
  const count = Object.hasOwn(counts, key) ? counts[key] : 0;
  return typeof count === "number" && Number.isFinite(count) && count >= 1
    ? Math.floor(count)
    : 0;
}

/** How many times each suggestion was chosen; 0 when unknown or unreadable. */
export function emojiUsage(scope: string): (id: string) => number {
  const counts = readCounts();
  return (id) => {
    const key = usageId(scope, id);
    return key ? uses(counts, key) : 0;
  };
}

/** Count one inserted emoji by its picker ID. */
export function addEmojiUsage(key: string) {
  try {
    const counts = readCounts();
    counts[key] = uses(counts, key) + 1;
    localStorage.setItem(STORE, JSON.stringify(counts));
    localStorage.setItem(LAST, JSON.stringify(key));
  } catch {
    /* Insertion already happened; usage is best effort, like Mart's own. */
  }
}

/** Count one inserted suggestion. */
export function recordEmojiUsage(scope: string, id: string) {
  const key = usageId(scope, id);
  if (key) addEmojiUsage(key);
}

/** The Frequently used row, as Mart orders it: most chosen first, the latest
 * choice always shown, and Mart's defaults filling the rest of a first row. */
export function frequentEmoji(
  { maxFrequentRows, perLine }: { maxFrequentRows: number; perLine: number },
  defaults: readonly string[],
  shown: (id: string) => boolean,
) {
  if (!maxFrequentRows) return [];
  const counts = readCounts();
  const max = maxFrequentRows * perLine;
  const ids = Object.keys(counts)
    .filter((id) => uses(counts, id) && shown(id))
    .sort((a, b) => uses(counts, b) - uses(counts, a) || a.localeCompare(b));
  let last: unknown;
  try {
    last = JSON.parse(localStorage.getItem(LAST) ?? "null");
  } catch {
    /* No latest choice to keep. */
  }
  const row = ids.slice(0, max);
  if (typeof last === "string" && ids.indexOf(last) >= max)
    row.splice(-1, 1, last);
  for (const id of defaults) {
    if (row.length >= perLine) break;
    if (!row.includes(id) && shown(id)) row.push(id);
  }
  return row;
}
