import { pickerIcons } from "../../shared/design-system/icons/svg";
// Emoji Mart config adapted from block/buzz's shared picker; see NOTICE.md.
import data from "@emoji-mart/data";
import { Data, Picker, SearchIndex } from "emoji-mart";
import { parseColorMode } from "../../shared/theme/service";
import type { CustomEmoji } from "../../features/relay/emoji";

const prefix = "buzz-custom/";
const categoryIcons = {
  frequent: { svg: pickerIcons.clock },
  people: { svg: pickerIcons.smiley },
  nature: { svg: pickerIcons["paw-print"] },
  foods: { svg: pickerIcons.orange },
  activity: { svg: pickerIcons.barbell },
  places: { svg: pickerIcons.car },
  objects: { svg: pickerIcons.lightbulb },
  symbols: { svg: pickerIcons.shapes },
  flags: { svg: pickerIcons.flag },
  custom: { svg: pickerIcons.asterisk },
  "buzz-custom": { svg: pickerIcons.asterisk },
};
let active: (() => void) | undefined;

/** Mart owns a module-global dictionary/search index. Only one mounted picker
 * may use it; a React remount alone neither removes old emoji nor isolates scope. */
export function mountEmojiMart({
  host,
  scope,
  perLine,
  emojiSize,
  emojiButtonSize,
  search,
  searchChange,
  entries,
  media,
  select,
  close,
}: {
  host: HTMLDivElement;
  scope: string;
  perLine: number;
  emojiSize: number;
  emojiButtonSize: number;
  search: string;
  searchChange(value: string): void;
  entries: readonly CustomEmoji[];
  media(url: string): string | undefined;
  select(value: string, customEmoji?: string): void;
  close(): void;
}) {
  active?.();
  let disposed = false;
  const values = new Map<string, { literal: string; shortcode: string }>();
  const emojis = entries.flatMap(({ shortcode, url }) => {
    const src = media(url);
    if (!src) return [];
    const id = `${prefix}${encodeURIComponent(scope)}/${shortcode}`;
    const literal = `:${shortcode}:`;
    values.set(id, { literal, shortcode });
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
    categoryIcons,
    emojiButtonSize,
    emojiSize,
    dynamicWidth: false,
    maxFrequentRows: 2,
    // Ten category tabs overlap in narrow thread panes; search/scroll still work.
    navPosition: perLine < 6 ? "none" : "bottom",
    perLine,
    previewPosition: "none",
    set: "native",
    skinTonePosition: "search",
    // Widget mode follows the host, never the OS independently.
    theme: parseColorMode(host.ownerDocument.documentElement.dataset.colorMode),
    onEmojiSelect: (emoji: { native?: string; id?: string }) => {
      if (disposed) return;
      if (emoji.native) {
        select(emoji.native);
        return;
      }
      const custom = values.get(emoji.id ?? "");
      if (custom) select(custom.literal, custom.shortcode);
    },
  }) as unknown as HTMLElement;
  // The documented web-component attribute updates in place: do not recreate the
  // picker/dictionary (or lose search, focus and scroll) just to change appearance.
  const documentRoot = host.ownerDocument.documentElement;
  const syncAppearance = () => {
    picker.setAttribute(
      "theme",
      parseColorMode(documentRoot.dataset.colorMode),
    );
    picker.toggleAttribute(
      "data-keyboard-navigation",
      documentRoot.hasAttribute("data-keyboard-navigation"),
    );
  };
  syncAppearance();
  const themeObserver = new MutationObserver(syncAppearance);
  themeObserver.observe(documentRoot, {
    attributes: true,
    attributeFilter: ["data-color-mode", "data-keyboard-navigation"],
  });
  // Like the legacy picker, own search focus/corrections after async shadow render.
  const root = picker.shadowRoot;
  const navigationStyle = host.ownerDocument.createElement("style");
  navigationStyle.textContent = `
    :host {
      --font-family: var(--font-sans);
      --font-size: var(--text-body-sm);
    }
    #root, input, button {
      color: var(--text-standard);
      font-family: var(--font-sans);
      font-size: var(--text-body-sm);
      line-height: var(--text-body-sm--line-height);
    }
    #root {
      --color-a: var(--text-standard);
      --color-b: var(--text-subtle);
      --color-c: var(--text-metadata);
      --em-color-border: var(--border-standard);
      --em-color-border-over: var(--affordance-selected);
      --buzz-category-fill: var(--affordance-selected);
      --buzz-category-icon: var(--text-subtle);
      --buzz-category-icon-selected: var(--text-standard);
      --buzz-category-label: var(--text-subtle);
      --buzz-scrollbar-thumb: var(--border-prominent);
      background: var(--surface-panel);
      color: var(--text-standard);
      font-family: var(--font-sans);
    }
    #root {
      --padding: var(--space-2);
      position: relative;
      width: 100% !important;
    }
    .scroll {
      padding-inline: var(--space-3);
      scrollbar-width: none;
    }
    .scroll::-webkit-scrollbar {
      display: none;
    }
    .buzz-scrollbar-track {
      position: absolute;
      right: 4px;
      z-index: 4;
      width: 8px;
      opacity: .6;
      pointer-events: none;
    }
    .buzz-scrollbar-thumb {
      position: absolute;
      top: 0;
      left: 0;
      width: 8px;
      min-height: 32px;
      border-radius: var(--radius-pill);
      background: var(--buzz-scrollbar-thumb);
    }
    .scroll > div {
      width: 100% !important;
    }
    .category .sticky {
      background: var(--surface-panel);
      color: var(--buzz-category-label);
      font-size: var(--text-caption);
      font-weight: var(--type-weight-normal);
      letter-spacing: 0;
      line-height: var(--text-caption--line-height);
    }
    .search input[type="search"] {
      width: 100%;
      min-height: var(--size-control);
      height: auto;
      padding: var(--space-2)
        calc(var(--space-control-inset) + var(--space-4) + var(--space-2));
      margin: 0;
      border: 1px solid transparent;
      border-radius: var(--radius-control);
      background: var(--surface-inset);
      box-shadow: none;
      color: var(--text-standard);
      font-family: var(--font-sans);
      font-size: var(--text-body);
      line-height: var(--text-body--line-height);
      transition: border-color var(--duration-field-focus) var(--easing-state);
    }
    .search input[type="search"]:focus {
      background: var(--surface-inset);
      box-shadow: none;
      border-color: var(--border-prominent);
      outline: none;
    }
    :host([data-keyboard-navigation]) .search input[type="search"] {
      transition: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .search input[type="search"] { transition: none; }
    }
    .search input[type="search"]::placeholder,
    .search .icon {
      color: var(--text-metadata);
      opacity: 1;
    }
    .search .loupe {
      visibility: hidden;
    }
    .search .delete {
      right: var(--space-1);
      width: var(--size-control-sm);
      height: var(--size-control-sm);
      padding: var(--space-2);
      border-radius: var(--radius-pill);
      color: var(--text-standard);
    }
    .search .delete svg {
      width: 16px;
      height: 16px;
    }

    .spacer {
      height: 0;
    }
    .spacer + .flex.flex-middle {
      padding-block: var(--space-2);
    }
    .spacer + .flex.flex-middle > .flex.flex-auto.flex-center.flex-middle {
      width: 0 !important;
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;
    }
    .category .emoji-mart-emoji img {
      max-width: 32px !important;
      max-height: 32px !important;
    }
    .scroll .category > :not(.sticky) > .flex {
      justify-content: space-between;
    }
    .scroll .category button {
      flex-shrink: 0;
    }
    #nav button {
      position: relative;
      z-index: 1;
      color: var(--buzz-category-icon);
    }
    #nav {
      box-sizing: border-box;
      width: 100%;
      padding-inline: var(--padding);
    }
    #nav > .flex.relative > button {
      flex: 1 1 0;
    }
    #nav .buzz-skin-tone-nav-button {
      height: 18px;
      flex: 1 1 0;
      border: 0;
    }

    #nav button::before {
      position: absolute;
      top: 50%;
      left: 50%;
      z-index: -1;
      width: 28px;
      height: 28px;
      border-radius: var(--radius-pill);
      background: transparent;
      content: "";
      pointer-events: none;
      transform: translate(-50%, -50%);
      transition: background-color 120ms ease;
    }
    #nav button[aria-selected] {
      color: var(--buzz-category-icon-selected);
    }
    #nav button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button:hover::before,
    #nav .buzz-skin-tone-nav-button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button .skin-tone {
      position: relative;
      z-index: 1;
    }
    .buzz-skin-tone-source {
      width: 0 !important;
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;
    }
    #nav .bar {
      display: none;
    }
    #root > .menu {
      background: var(--surface-popover);
      border-color: var(--border-standard);
      border-radius: var(--radius-row);
      padding: var(--space-1);
      box-shadow: var(--shadow-sm);
      backdrop-filter: none;
      top: auto !important;
      right: 8px !important;
      bottom: 42px !important;
      left: auto !important;
      z-index: 100 !important;
      transform-origin: 100% 100%;
    }
    .menu .option {
      border-radius: var(--radius-chip);
      padding: var(--space-1) var(--space-1h);
    }
    .menu .option:hover {
      background: var(--affordance-selected);
      color: var(--text-standard);
    }
    .menu input[type="radio"]:checked + .option {
      box-shadow: 0 0 0 2px var(--text-standard);
    }
    @media (prefers-reduced-motion: reduce) {
      #nav button::before {
        transition-duration: 0ms;
      }
    }
  `;
  root?.appendChild(navigationStyle);
  let skinToneObserver: MutationObserver | undefined;
  let scrollbarCleanup: (() => void) | undefined;
  let scrollbarScroll: HTMLElement | undefined;
  let scrollbarUpdate: (() => void) | undefined;
  const installPersistentScrollbar = () => {
    const scroll = root?.querySelector<HTMLElement>(".scroll");
    const pickerRoot = root?.querySelector<HTMLElement>("#root");
    if (!scroll || !pickerRoot) return;
    if (scroll === scrollbarScroll) {
      scrollbarUpdate?.();
      return;
    }
    scrollbarCleanup?.();
    pickerRoot.querySelector(".buzz-scrollbar-track")?.remove();
    const track = host.ownerDocument.createElement("div");
    track.className = "buzz-scrollbar-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = host.ownerDocument.createElement("div");
    thumb.className = "buzz-scrollbar-thumb";
    track.appendChild(thumb);
    pickerRoot.appendChild(track);
    const update = () => {
      const pickerBounds = pickerRoot.getBoundingClientRect();
      const scrollBounds = scroll.getBoundingClientRect();
      const trackHeight = Math.max(0, scroll.clientHeight - 16);
      const overflow = scroll.scrollHeight - scroll.clientHeight;
      track.hidden = overflow <= 0;
      track.style.top = `${scrollBounds.top - pickerBounds.top + 8}px`;
      track.style.height = `${trackHeight}px`;
      if (overflow <= 0) return;
      const thumbHeight = Math.max(
        32,
        trackHeight * (scroll.clientHeight / scroll.scrollHeight),
      );
      const offset =
        (scroll.scrollTop / overflow) * Math.max(0, trackHeight - thumbHeight);
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    };
    const resize = new ResizeObserver(update);
    resize.observe(scroll);
    if (scroll.firstElementChild) resize.observe(scroll.firstElementChild);
    scroll.addEventListener("scroll", update, { passive: true });
    scrollbarScroll = scroll;
    scrollbarUpdate = update;
    scrollbarCleanup = () => {
      resize.disconnect();
      scroll.removeEventListener("scroll", update);
      track.remove();
      scrollbarScroll = undefined;
      scrollbarUpdate = undefined;
    };
    update();
  };
  const placeSkinToneInNavigation = () => {
    const source = root?.querySelector<HTMLButtonElement>(".skin-tone-button");
    const navigation = root?.querySelector<HTMLElement>(
      "#nav > .flex.relative",
    );
    const bar = navigation?.querySelector<HTMLElement>(":scope > .bar");
    if (!source || !navigation || !bar) return false;
    if (navigation.querySelector(".buzz-skin-tone-nav-button")) return true;
    source.parentElement?.classList.add("buzz-skin-tone-source");
    const button = host.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "buzz-skin-tone-nav-button flex flex-center flex-middle";
    button.setAttribute(
      "aria-label",
      source.getAttribute("aria-label") ?? "Choose skin tone",
    );
    button.title = source.title;
    const tone = host.ownerDocument.createElement("span");
    button.appendChild(tone);
    let menuOpen = source.hasAttribute("aria-selected");
    const sync = () => {
      const selected = source.hasAttribute("aria-selected");
      button.toggleAttribute("aria-selected", selected);
      tone.className =
        source.querySelector(".skin-tone")?.className ?? "skin-tone";
      if (menuOpen && !selected) button.focus();
      menuOpen = selected;
    };
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => source.click());
    sync();
    navigation.insertBefore(button, bar);
    skinToneObserver?.disconnect();
    skinToneObserver = new MutationObserver(sync);
    skinToneObserver.observe(source, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    return true;
  };
  const installSearchClearIcon = () => {
    const icon = root?.querySelector<SVGSVGElement>(".search .delete svg");
    if (!icon || icon.dataset.buzzCircleX) return;
    const template = document.createElement("template");
    template.innerHTML = pickerIcons["x-circle"];
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    // Preserve the widget-owned node so its renderer does not insert a second SVG.
    for (const attribute of [...icon.attributes])
      icon.removeAttribute(attribute.name);
    for (const attribute of [...replacement.attributes])
      icon.setAttribute(attribute.name, attribute.value);
    icon.innerHTML = replacement.innerHTML;
    icon.dataset.buzzCircleX = "true";
    icon.setAttribute("aria-hidden", "true");
  };
  const focusSearch = () => {
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!root || !input || disposed) return;
    placeSkinToneInNavigation();
    installPersistentScrollbar();
    installSearchClearIcon();
    if (input.dataset.buzzSearchReady) return;
    input.dataset.buzzSearchReady = "true";
    input.addEventListener("input", () => searchChange(input.value));
    input.spellcheck = false;
    input.placeholder = "Search emoji";
    input.setAttribute("aria-label", "Search emoji");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    if (search) {
      input.value = search;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.focus();
  };
  const observer = new MutationObserver(focusSearch);
  if (root) observer.observe(root, { childList: true, subtree: true });
  host.appendChild(picker);
  focusSearch();
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    skinToneObserver?.disconnect();
    scrollbarCleanup?.();
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
