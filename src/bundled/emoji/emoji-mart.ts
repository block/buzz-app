// Emoji Mart config adapted from block/buzz's shared picker; see NOTICE.md.
import data from "@emoji-mart/data";
import { Data, Picker, SearchIndex } from "emoji-mart";
import { parseColorMode } from "../../shared/theme/service";
import type { CustomEmoji } from "../../features/relay/emoji";

const prefix = "buzz-custom/";
let active: (() => void) | undefined;

/** Mart owns a module-global dictionary/search index. Only one mounted picker
 * may use it; a React remount alone neither removes old emoji nor isolates scope. */
export function mountEmojiMart({
  host,
  scope,
  perLine,
  search,
  entries,
  media,
  select,
  close,
}: {
  host: HTMLDivElement;
  scope: string;
  perLine: number;
  search: string;
  entries: readonly CustomEmoji[];
  media(url: string): string | undefined;
  select(value: string): void;
  close(): void;
}) {
  active?.();
  let disposed = false;
  const values = new Map<string, string>();
  const emojis = entries.flatMap(({ shortcode, url }) => {
    const src = media(url);
    if (!src) return [];
    const id = `${prefix}${encodeURIComponent(scope)}/${shortcode}`;
    const literal = `:${shortcode}:`;
    values.set(id, literal);
    // Match Mart's first-hyphen query normalization as well as individual words.
    const terms = [shortcode, literal].flatMap((name) => [
      name,
      ...name.replace(/(\w)-/, "$1 ").split(/[\s|,]+/),
      ...name.split(/[-_]+/),
    ]);
    return [
      {
        id,
        name: literal,
        keywords: [shortcode],
        // Supplying search/shortcodes prevents Mart from exposing its scoped ID.
        search: `,${terms.join(",")}`,
        skins: [{ src, shortcodes: literal }],
      },
    ];
  });
  // Restore Mart's default Frequent row if storage contains a poisoned empty map.
  try {
    if (localStorage.getItem("emoji-mart.frequently") === "{}") {
      localStorage.removeItem("emoji-mart.frequently");
      localStorage.removeItem("emoji-mart.last");
    }
  } catch {
    /* Like Mart, selection works without localStorage. */
  }
  const picker = new Picker({
    data,
    custom: emojis.length
      ? [{ id: "buzz-custom", name: "Custom", emojis }]
      : [],
    autoFocus: false,
    maxFrequentRows: 2,
    // Ten category tabs overlap in narrow thread panes; search/scroll still work.
    navPosition: perLine < 8 ? "none" : "top",
    perLine,
    previewPosition: "bottom",
    set: "native",
    skinTonePosition: "search",
    // Widget mode follows the host, never the OS independently.
    theme: parseColorMode(host.ownerDocument.documentElement.dataset.colorMode),
    onEmojiSelect: (emoji: { native?: string; id?: string }) => {
      if (disposed) return;
      const value = emoji.native ?? values.get(emoji.id ?? "");
      if (value) select(value);
    },
  }) as unknown as HTMLElement;
  // The documented web-component attribute updates in place: do not recreate the
  // picker/dictionary (or lose search, focus and scroll) just to change appearance.
  const documentRoot = host.ownerDocument.documentElement;
  const themeObserver = new MutationObserver(() => {
    picker.setAttribute(
      "theme",
      parseColorMode(documentRoot.dataset.colorMode),
    );
  });
  themeObserver.observe(documentRoot, {
    attributes: true,
    attributeFilter: ["data-color-mode"],
  });
  // Like the legacy picker, own search focus/corrections after async shadow render.
  const root = picker.shadowRoot;
  const focusSearch = () => {
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input || disposed) return;
    input.spellcheck = false;
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    if (search) {
      input.value = search;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.focus();
    observer.disconnect();
  };
  const observer = new MutationObserver(focusSearch);
  if (root) observer.observe(root, { childList: true, subtree: true });
  host.appendChild(picker);
  focusSearch();
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    themeObserver.disconnect();
    picker.remove(); // unregisters Mart's document listeners and observers
    for (const id of values.keys()) delete Data?.emojis[id];
    if (Data) {
      Data.categories = Data.categories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
      Data.originalCategories = Data.originalCategories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
    }
    SearchIndex.reset();
    if (active === dismiss) active = undefined;
  }
  function dismiss() {
    dispose();
    close();
  }
  active = dismiss;
  // Search also caches results after deletion/replacement; recreate rather than update.
  SearchIndex.reset();
  return dispose;
}
