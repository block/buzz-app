import { matchRank } from "../../features/search/match";
import {
  useLayoutEffect,
  useRef,
  useEffect,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import {
  CaretRightIcon,
  ClockIcon,
  MagnifyingGlassIcon,
  type ChatCircleIcon,
} from "../../shared/design-system/icons/index";
import type { PeekTarget } from "./SearchPreview";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import { channelIconClass } from "../../shared/inline-reference";
import { PageIcon } from "./PageIcon";
import "./SearchChoices.css";

export type SearchDestination = {
  content?: ReactNode;
  rank?: number;
  key: string;
  label: string;
  detail?: string;
  /** Quiet metadata at the row's end, such as a count. */
  trailing?: ReactNode;
  /** Leads `detail`, as a channel mention's icon leads its name in a
   * message. */
  detailIcon?: typeof ChatCircleIcon | undefined;
  /** What `detailIcon` shows, read before `detail` but neither shown nor
   * matched. */
  detailIconLabel?: string | undefined;
  /** Code points of `label` that match the typed text. */
  matches?: readonly number[];
  icon: typeof ChatCircleIcon;
  image?: string | undefined;
  avatar?:
    | {
        src?: string | undefined;
        shape: "circle" | "squircle";
        /** Whose initials stand in for a missing image; the label's if not given. */
        name?: string | undefined;
      }
    | undefined;
  /** What the preview beside the results reads for this row. */
  peek?: PeekTarget | undefined;
  /** The row's own kind, where its group mixes kinds. */
  kind?: SearchTone | undefined;
  run: () => void;
};

export type SearchGroup = {
  label: string;
  /** Name the group for assistive technology only, when the view's own tab
   * already says what it holds. */
  hideLabel?: boolean;
  /** Message-content scores are not comparable to named destinations. */
  rank?: number;
  destinations: readonly SearchDestination[];
  /** How many rows the whole list holds when only its first are drawn, so
   * assistive technology counts them all. */
  total?: number;
  empty?: ReactNode;
  notice?: ReactNode;
  /** Non-interactive visual status; callers own its live announcement. */
  headingStatus?: string | undefined;
  /** Why the group sits where it does, e.g. "Exact name". */
  why?: string | undefined;
  /** How many it holds when that differs from its rows, e.g. "20+". */
  count?: string | undefined;
  /** The group's icon in the rail. */
  icon?: typeof ChatCircleIcon | undefined;
  /** The hue Peek tints the group's icons with. */
  tone?: SearchTone | undefined;
  /** Rows show their whole detail, wrapped, rather than one line of it. */
  multiline?: boolean | undefined;
  /** Peek lists it beside Top results and shows it whole when chosen, but
   * not among them. */
  browse?: boolean | undefined;
};

/** What kind of thing a group holds, for Peek's icon tints. */
export type SearchTone =
  | "channel"
  | "person"
  | "chat"
  | "agent"
  | "plugin"
  | "page"
  | "message";

/** Results beside a preview of the highlighted row, with a rail of the
 * groups they fall in. Ranked, the Top results view shows a few rows of each
 * group, and Tab shows one group whole. */
export type SearchPeek = {
  ranked: boolean;
  /** `tone` is the hue of the group the row is in. */
  preview: (
    row: SearchDestination | undefined,
    tone: SearchTone | undefined,
  ) => ReactNode;
  /** Shown under the field, such as filters to add. */
  hints?: ReactNode;
  /** Results that may still arrive, so the list is busy. */
  busy?: boolean;
  /** Heard once per text, when the person first moves the highlight: the
   * groups keep their order from then on, so nothing reorders under them. */
  onFreeze?: () => void;
};

/** Top results shows this many rows of its first group, and of the rest. */
const LEAD_ROWS = 5;
const GROUP_ROWS = 3;

/** A chosen filter shown before the typed text. */
export type SearchChip = {
  /** As the query holds it, e.g. `from:<key>` or `in:<channel id>`. */
  operand: string;
  /** What the chip shows, e.g. `from:@Wes`. */
  text: string;
  /** The text Backspace restores for editing. */
  edit: string;
  /** The remove button's accessible name. */
  label: string;
  title?: string;
};

export type SearchInputProps = {
  inlineSettings?: readonly SearchGroup[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  scope?: { label: string; onRemove: () => void } | undefined;
  /** A control that refines the scoped results, beside the scope chip. */
  scopeAction?: ReactNode;
  chips?: readonly SearchChip[] | undefined;
  onRemoveChip?: ((chip: SearchChip) => void) | undefined;
  /** Backspace before the text edits the last chip. */
  onEditLastChip?: (() => void) | undefined;
  displayQuery?: string | undefined;
  onDisplayQueryChange?: ((value: string) => void) | undefined;
  /** False while the palette closes, so a held Enter chooses nothing. */
  open?: boolean | undefined;
};

/** Views of one search, switched from the field with Ctrl+Tab and
 * Ctrl+Shift+Tab, drawn between the field and the results. */
export type SearchViews = {
  tabs?: ReactNode;
  /** Names the results list for the view shown. */
  resultsLabel: string;
  /** The shown view's tab panel, which its tab controls. */
  panelId?: string;
  onSwitch?: (delta: 1 | -1) => void;
  /** Where the results were: their scroll position and highlighted row,
   * restored as the view mounts and kept as they change. */
  place: SearchPlace;
};

/** A kept place in the results. `anchor` is the first row in view and how
 * far above the view's top it sat, so a list whose order changed while
 * closed reopens on the same rows rather than the same pixels. */
export type SearchPlace = {
  top: number;
  key: string;
  anchor?: { key: string; offset: number } | undefined;
};

const rowKeysOf = (elements: readonly Element[]) =>
  elements.flatMap((row) =>
    row instanceof HTMLElement && row.dataset.searchKey
      ? [row.dataset.searchKey]
      : [],
  );

export function SearchChoices({
  groups: originalGroups,
  query,
  onQueryChange,
  chips,
  onRemoveChip,
  onEditLastChip,
  displayQuery,
  onDisplayQueryChange,
  input,
  label = "Search Buzz",
  scope,
  scopeAction,
  children,
  footer,
  inlineSettings,
  open = true,
  pending = false,
  isAction,
  views,
  highlightEmpty = false,
  onRowsShown,
  peek,
}: SearchInputProps & {
  groups: readonly SearchGroup[];
  children?: ReactNode;
  /** Kept below the results, outside their scrollport, so it stays in view
   * however long the list: a limit on what is searched and its recovery. */
  footer?: ReactNode;
  /** A row that should lead may still arrive, so Enter before any row
   * waits until it has. */
  pending?: boolean;
  /** Whether a row acts on the search rather than being a result, so Enter
   * on it can wait for `pending` like Enter before any row. */
  isAction?: (key: string) => boolean;
  views?: SearchViews | undefined;
  /** Highlight the first row before anything is typed, for a view whose
   * unfiltered list is the list to choose from. */
  highlightEmpty?: boolean;
  /** Hears the keys of rows scrolled into (or near) view, for details worth
   * reading only for the rows someone can see. */
  onRowsShown?: ((keys: readonly string[]) => void) | undefined;
  peek?: SearchPeek | undefined;
}) {
  const palette = useRef<HTMLDivElement>(null);
  const resultsViewport = useRef<HTMLDivElement>(null);
  const resultsContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = resultsViewport.current;
    const content = resultsContent.current;
    if (!viewport || !content) return;
    let initialized = false;
    let frame = 0;
    const measure = () => {
      const height = content.offsetHeight;
      viewport.style.height = `${height}px`;
      if (!initialized) {
        initialized = true;
        frame = requestAnimationFrame(() => {
          viewport.dataset.measured = "";
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const needle = query.trim().toLowerCase();
  const score = (group: SearchGroup) =>
    group.rank ??
    Math.min(
      matchRank(group.label, needle) ?? Infinity,
      ...group.destinations.map(
        (row) =>
          row.rank ??
          Math.min(
            matchRank(row.label, needle) ?? Infinity,
            matchRank(row.detail ?? "", needle) ?? Infinity,
          ),
      ),
    );
  // Upstream order includes usage and remembered choices. Only insert the new
  // groups; never re-rank existing destinations from their display labels.
  const merged = [...originalGroups];
  for (const group of [...(inlineSettings ?? [])].sort(
    (a, b) => score(a) - score(b),
  )) {
    const index = merged.findIndex(
      (existing) => score(existing) > score(group),
    );
    merged.splice(index < 0 ? merged.length : index, 0, group);
  }
  // Peek: Top results, or one group whole.
  const [peekScope, setPeekScope] = useState<string>();
  // Once the person moves, the groups shown keep their places for this text,
  // and groups that arrive later go after them.
  const frozen = useRef<{ query: string; labels: string[] }>(undefined);
  if (frozen.current && frozen.current.query !== query)
    frozen.current = undefined;
  const order = peek?.ranked ? frozen.current?.labels : undefined;
  if (order) {
    const place = (group: SearchGroup) => {
      const index = order.indexOf(group.label);
      return index < 0 ? order.length : index;
    };
    merged.sort((a, b) => place(a) - place(b));
  }
  const resultRows = (group: SearchGroup) =>
    group.destinations.filter((row) => !isAction?.(row.key));
  const ranked = peek?.ranked
    ? merged.filter((group) => resultRows(group).length)
    : [];
  const scoped = ranked.find((group) => group.label === peekScope);
  const countOf = (group: SearchGroup) =>
    group.count ?? String(resultRows(group).length);
  const truncated = new Map<string, number>();
  const groups: SearchGroup[] = !peek?.ranked
    ? merged
    : scoped
      ? [scoped]
      : merged
          .filter((group) => !group.browse)
          .map((group) => {
            const place = ranked.indexOf(group);
            if (place < 0) return group;
            const rows = resultRows(group);
            const limit = place === 0 ? LEAD_ROWS : GROUP_ROWS;
            if (rows.length <= limit && !group.count)
              return { ...group, destinations: rows };
            truncated.set(group.label, rows.length);
            return { ...group, destinations: rows.slice(0, limit) };
          });
  const showScope = (label: string | undefined) => {
    setPeekScope(label);
    const first = (
      label ? ranked.find((group) => group.label === label) : ranked[0]
    )?.destinations[0]?.key;
    if (first) highlight.select(first);
    if (resultsContent.current) resultsContent.current.scrollTop = 0;
    input.current?.focus();
  };
  const hasControls = groups.some((group) =>
    group.destinations.some((row) => row.content),
  );
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  const place = views?.place;
  const keys = destinations.map(({ key }) => key);
  const highlight = useSearchHighlight({
    query,
    keys,
    onChoose: (key) => destinations.find((row) => row.key === key)?.run(),
    open,
    pending,
    isAction,
    highlightEmpty,
    followFirst: !!peek?.ranked,
    // A kept place keeps its row: Enter never chooses a row scrolled away.
    ...(place?.key && keys.includes(place.key)
      ? { initial: place.key }
      : place?.top
        ? { initial: "" }
        : {}),
  });
  const selected = highlight.active;
  const moved = !!peek?.ranked && highlight.moved;
  const freeze = peek?.onFreeze;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Freezes the order just shown, once per text.
  useLayoutEffect(() => {
    if (!moved || frozen.current) return;
    frozen.current = { query, labels: merged.map(({ label }) => label) };
    freeze?.();
  }, [moved, query]);
  // A highlight is kept only while its row is in view: one scrolled away
  // would reopen with Enter choosing a row nobody can see.
  useEffect(() => {
    if (place) place.key = selected;
  }, [place, selected]);
  const rowBox = (key: string) =>
    document.getElementById(highlight.rowId(key))?.getBoundingClientRect();
  const inView = (key: string) => {
    const content = resultsContent.current;
    const box = key ? rowBox(key) : undefined;
    if (!content || !box) return false;
    const view = content.getBoundingClientRect();
    return box.bottom > view.top && box.top < view.bottom;
  };
  const keepPlace = () => {
    const content = resultsContent.current;
    if (!place || !content) return;
    place.key = inView(selected) ? selected : "";
    // Rows stack in order: find the first one reaching into the view.
    const top = content.getBoundingClientRect().top;
    let low = 0;
    let high = keys.length - 1;
    let anchor: SearchPlace["anchor"];
    while (low <= high) {
      const middle = (low + high) >> 1;
      const key = keys[middle];
      const box = key ? rowBox(key) : undefined;
      if (!key || !box) break;
      if (box.bottom > top) {
        anchor = { key, offset: top - box.top };
        high = middle - 1;
      } else low = middle + 1;
    }
    place.anchor = anchor;
  };
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  // macOS sends Ctrl+Tab from its menu as a request to the focused control.
  const switchView = views?.onSwitch;
  useEffect(() => {
    const root = palette.current;
    if (!root || !switchView) return;
    const request = (delta: 1 | -1) => (event: Event) => {
      event.preventDefault();
      switchView(delta);
    };
    const next = request(1);
    const previous = request(-1);
    root.addEventListener("buzz:next-tab", next);
    root.addEventListener("buzz:previous-tab", previous);
    return () => {
      root.removeEventListener("buzz:next-tab", next);
      root.removeEventListener("buzz:previous-tab", previous);
    };
  }, [switchView]);
  const resultsLabel = views?.resultsLabel ?? "Search results";
  // A group drawn in part says where each row sits in the whole of it.
  const positions = new Map<
    string,
    { "aria-setsize": number; "aria-posinset": number }
  >();
  for (const { destinations, total } of groups)
    if (total !== undefined)
      for (const [index, { key }] of destinations.entries())
        positions.set(key, {
          "aria-setsize": total,
          "aria-posinset": index + 1,
        });
  // A view returns to its kept position, waiting for late rows to make room
  // until the person scrolls or moves the highlight themselves.
  const restore = useRef(place?.top ?? 0);
  const restoreScroll = () => {
    const content = resultsContent.current;
    if (!content || !restore.current) return;
    const anchor = place?.anchor;
    const box = anchor && rowBox(anchor.key);
    const target =
      anchor && box
        ? content.scrollTop +
          box.top -
          content.getBoundingClientRect().top +
          anchor.offset
        : restore.current;
    content.scrollTop = target;
    if (Math.abs(content.scrollTop - target) <= 1) restore.current = 0;
  };
  /** Once the kept place is back, a highlight left out of view is dropped,
   * so Enter never chooses a row nobody can see. */
  const settling = useRef(!!place?.top);
  const settle = () => {
    if (!settling.current || restore.current) return;
    settling.current = false;
    if (selected && !inView(selected)) highlight.clear();
  };
  // Before paint, and again after the highlight reveals its first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rows arriving give the kept position room.
  useLayoutEffect(() => {
    const target = restore.current;
    restoreScroll();
    restore.current = target;
  }, [destinations.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rows arriving give the kept position room.
  useEffect(() => {
    restoreScroll();
    settle();
  }, [destinations.length]);
  const shown = useRef(onRowsShown);
  shown.current = onRowsShown;
  const watching = !!onRowsShown;
  const rowsObserver = useRef<
    { observer: IntersectionObserver; watched: Set<Element> } | undefined
  >(undefined);
  useEffect(() => {
    const root = resultsContent.current;
    if (!root || !watching || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = rowKeysOf(
          entries.flatMap((entry) =>
            entry.isIntersecting ? [entry.target] : [],
          ),
        );
        if (visible.length) shown.current?.(visible);
      },
      // Half a view ahead, so details are usually there before the row is.
      { root, rootMargin: "50% 0px" },
    );
    rowsObserver.current = { observer, watched: new Set() };
    return () => {
      observer.disconnect();
      rowsObserver.current = undefined;
    };
  }, [watching]);
  const rowKeys = destinations.map(({ key }) => key).join("\n");
  // Only rows not yet watched start watching, so a list that grows as it
  // scrolls doesn't observe its earlier rows again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: New rows need watching.
  useEffect(() => {
    const root = resultsContent.current;
    if (!root || !watching) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-search-key]")];
    const watch = rowsObserver.current;
    if (!watch) {
      shown.current?.(rowKeysOf(rows));
      return;
    }
    for (const row of watch.watched)
      if (!row.isConnected) {
        watch.observer.unobserve(row);
        watch.watched.delete(row);
      }
    for (const row of rows)
      if (!watch.watched.has(row)) {
        watch.watched.add(row);
        watch.observer.observe(row);
      }
  }, [watching, rowKeys]);
  return (
    <div
      ref={palette}
      className="search-palette"
      data-search-palette=""
      data-modal-tab-switch={views?.onSwitch ? "" : undefined}
      data-search-views={views?.tabs ? "" : undefined}
      data-search-footer={footer ? "" : undefined}
      data-search-peek={peek ? "" : undefined}
      {...highlight.listProps}
    >
      {(scope || scopeAction) && (
        <div className="search-palette-scope-row">
          {scope && (
            <button
              type="button"
              className="search-palette-scope"
              aria-label={`Remove ${scope.label} search scope`}
              onClick={scope.onRemove}
            >
              {scope.label} <span aria-hidden="true">×</span>
            </button>
          )}
          {scopeAction}
        </div>
      )}
      <SearchField
        variant="palette"
        prefix={
          chips?.length ? (
            <span className="search-palette-author-prefix">
              {chips.map((chip) => (
                <button
                  key={chip.operand}
                  type="button"
                  className="search-palette-author-chip"
                  aria-label={chip.label}
                  title={chip.title}
                  onClick={() => onRemoveChip?.(chip)}
                >
                  <span aria-hidden="true">×</span> {chip.text}
                </button>
              ))}
            </span>
          ) : undefined
        }
        inputRef={input}
        role="combobox"
        aria-controls={highlight.listId}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-haspopup={hasControls ? "grid" : "listbox"}
        {...highlight.fieldProps}
        label={label}
        placeholder="Search people, channels, plugins and messages"
        value={displayQuery ?? query}
        onValueChange={onDisplayQueryChange ?? onQueryChange}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        maxLength={256}
        onKeyDown={(event) => {
          const shortcutNumber = /^Digit([1-9])$/.exec(event.code)?.[1];
          if (
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !event.altKey &&
            event.shiftKey &&
            event.metaKey === apple &&
            event.ctrlKey !== apple &&
            shortcutNumber
          ) {
            const destination = destinations[Number(shortcutNumber) - 1];
            if (destination) {
              event.preventDefault();
              if (!event.repeat) highlight.choose(destination.key);
            }
            return;
          }
          if (
            event.key === "Backspace" &&
            chips?.length &&
            event.currentTarget.selectionStart === 0 &&
            event.currentTarget.selectionEnd === 0
          ) {
            event.preventDefault();
            onEditLastChip?.();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp")
            restore.current = 0;
          if (
            ranked.length > 1 &&
            event.key === "Tab" &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const order = [undefined, ...ranked.map(({ label }) => label)];
            const index = order.indexOf(scoped?.label);
            showScope(
              order[
                (index + (event.shiftKey ? -1 : 1) + order.length) %
                  order.length
              ],
            );
            return;
          }
          // Escape from one group returns to Top results, not out of search.
          if (event.key === "Escape" && scoped) {
            event.preventDefault();
            event.stopPropagation();
            showScope(undefined);
            return;
          }
          if (
            switchView &&
            event.key === "Tab" &&
            event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();
            switchView(event.shiftKey ? -1 : 1);
            return;
          }
          highlight.keyDown(event);
        }}
      />
      {peek?.hints}
      {views?.tabs && <div className="search-palette-views">{views.tabs}</div>}
      <div className={peek?.ranked ? "search-peek-body" : "contents"}>
        <div
          ref={resultsViewport}
          className="search-palette-height"
          {...(views?.panelId
            ? {
                role: "tabpanel",
                id: views.panelId,
                "aria-labelledby": `${views.panelId}-tab`,
              }
            : {})}
        >
          <div
            ref={resultsContent}
            className="search-palette-scroll"
            onWheel={() => {
              restore.current = 0;
            }}
            onPointerDown={() => {
              restore.current = 0;
            }}
            onScroll={(event) => {
              if (restore.current) return;
              // Enter never chooses a row scrolled out of sight.
              if (selected && !inView(selected)) highlight.clear();
              if (!place) return;
              place.top = event.currentTarget.scrollTop;
              keepPlace();
            }}
          >
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid and listbox support an accessible label. */}
            <div
              id={highlight.listId}
              role={hasControls ? "grid" : "listbox"}
              aria-label={resultsLabel}
              aria-busy={peek?.busy || undefined}
              className="search-palette-results interaction-panel"
            >
              {groups
                .filter(
                  ({ destinations, empty, headingStatus }) =>
                    destinations.length || empty !== undefined || headingStatus,
                )
                .map(
                  ({
                    label,
                    hideLabel,
                    destinations,
                    empty,
                    notice,
                    headingStatus,
                    why,
                    tone,
                    icon: GroupIcon = destinations[0]?.icon,
                    multiline,
                  }) => (
                    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid rowgroups and listbox groups are named.
                    <div
                      key={label}
                      role={hasControls ? "rowgroup" : "group"}
                      aria-label={label}
                      // A status-only group has no rows yet; busy states why.
                      aria-busy={
                        (!!headingStatus && !destinations.length) || undefined
                      }
                      className="search-palette-group"
                      data-tone={tone}
                    >
                      <div className="navigation-section" data-buzz-ui="">
                        {!hideLabel && (
                          <div
                            className="navigation-section-heading"
                            aria-hidden={hasControls || undefined}
                          >
                            <h2
                              className={`navigation-section-label text-body text-secondary${headingStatus ? " truncate" : ""}`}
                            >
                              {peek?.ranked && GroupIcon && (
                                <span
                                  className="search-peek-tile"
                                  data-tone={tone}
                                  aria-hidden="true"
                                >
                                  <GroupIcon size={12} />
                                </span>
                              )}
                              <span className="search-peek-group-label">
                                {label}
                              </span>
                              {peek?.ranked &&
                                ranked.some(
                                  (group) => group.label === label,
                                ) && (
                                  <span
                                    className="search-peek-count"
                                    aria-hidden="true"
                                  >
                                    {" "}
                                    {countOf(
                                      ranked.find(
                                        (group) => group.label === label,
                                      ) ?? { label, destinations },
                                    )}
                                  </span>
                                )}
                              {why && (
                                <span
                                  className="search-peek-why"
                                  aria-hidden="true"
                                >
                                  {" "}
                                  · {why}
                                </span>
                              )}
                              {headingStatus && (
                                <span aria-hidden="true">
                                  {" "}
                                  · {headingStatus}
                                </span>
                              )}
                            </h2>
                            {truncated.has(label) && (
                              <button
                                type="button"
                                tabIndex={-1}
                                className="search-peek-see-all text-body-sm"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => showScope(label)}
                              >
                                See all{" "}
                                {countOf(
                                  ranked.find(
                                    (group) => group.label === label,
                                  ) ?? {
                                    label,
                                    destinations,
                                  },
                                )}
                                <CaretRightIcon size={12} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        )}
                        <div className="navigation-section-rows">
                          {destinations.map(
                            ({
                              content,
                              key,
                              label,
                              detail,
                              detailIcon: DetailIcon,
                              detailIconLabel,
                              trailing,
                              matches,
                              icon,
                              image,
                              avatar,
                              kind,
                            }) =>
                              content ? (
                                // biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table.
                                <div
                                  key={key}
                                  {...highlight.rowProps(key)}
                                  role="row"
                                  aria-label={[label, detail]
                                    .filter(Boolean)
                                    .join(" — ")}
                                  aria-selected={selected === key}
                                  tabIndex={-1}
                                  className="search-control-row"
                                  data-highlighted={
                                    selected === key || undefined
                                  }
                                  onClick={(event) => {
                                    if (
                                      !event.currentTarget.contains(
                                        event.target as Node,
                                      )
                                    )
                                      return;
                                    if (
                                      (event.target as HTMLElement).closest(
                                        "button, input, label, [role=switch], [role=combobox]",
                                      )
                                    )
                                      return;
                                    highlight.choose(key);
                                  }}
                                  onKeyDownCapture={(event) => {
                                    const target = event.target as HTMLElement;
                                    if (
                                      target !== event.currentTarget &&
                                      event.currentTarget.contains(target) &&
                                      !target.closest(
                                        '[role="combobox"][aria-expanded="true"]',
                                      )
                                    )
                                      highlight.rowProps(key).onKeyDown(event);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.target !== event.currentTarget)
                                      return;
                                    if (
                                      event.key === "Enter" ||
                                      event.key === " "
                                    ) {
                                      event.preventDefault();
                                      highlight.choose(key);
                                    } else
                                      highlight.rowProps(key).onKeyDown(event);
                                  }}
                                >
                                  {/* biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table. */}
                                  <div id={key} role="gridcell" tabIndex={-1}>
                                    {content}
                                  </div>
                                </div>
                              ) : (
                                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Selection and label apply only to the grid row.
                                // biome-ignore lint/a11y/noStaticElementInteractions: Keyboard handling applies only to the grid row.
                                <div
                                  key={key}
                                  {...(hasControls
                                    ? highlight.rowProps(key)
                                    : {})}
                                  role={hasControls ? "row" : "presentation"}
                                  aria-label={
                                    hasControls
                                      ? [
                                          label,
                                          detail && detailIconLabel
                                            ? `${detailIconLabel}, ${detail}`
                                            : detail,
                                        ]
                                          .filter(Boolean)
                                          .join(" — ")
                                      : undefined
                                  }
                                  aria-selected={
                                    hasControls ? selected === key : undefined
                                  }
                                  tabIndex={hasControls ? -1 : undefined}
                                  data-search-result={
                                    hasControls ? "" : undefined
                                  }
                                  data-search-key={watching ? key : undefined}
                                  data-highlighted={
                                    (hasControls && selected === key) ||
                                    undefined
                                  }
                                  onKeyDown={
                                    hasControls
                                      ? (event) => {
                                          if (
                                            event.target ===
                                              event.currentTarget &&
                                            event.key === "Enter"
                                          ) {
                                            event.preventDefault();
                                            highlight.choose(key);
                                          } else
                                            highlight
                                              .rowProps(key)
                                              .onKeyDown(event);
                                        }
                                      : undefined
                                  }
                                >
                                  <div
                                    role={
                                      hasControls ? "gridcell" : "presentation"
                                    }
                                  >
                                    <NavigationItem
                                      variant="search"
                                      key={key}
                                      {...(!hasControls
                                        ? highlight.rowProps(key)
                                        : {})}
                                      role={hasControls ? "button" : "option"}
                                      aria-selected={
                                        hasControls
                                          ? undefined
                                          : selected === key
                                      }
                                      {...(!hasControls && positions.get(key))}
                                      tabIndex={-1}
                                      aria-current={false}
                                      multiline={!!multiline}
                                      highlighted={selected === key}
                                      data-search-result={
                                        !hasControls ? "" : undefined
                                      }
                                      aria-keyshortcuts={
                                        shortcutNumbers.has(key)
                                          ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                                          : undefined
                                      }
                                      icon={
                                        <span
                                          className="search-row-icon grid size-6 shrink-0 items-center justify-items-start"
                                          data-tile={
                                            (!avatar && !image) || undefined
                                          }
                                          data-tone={kind}
                                        >
                                          {avatar ? (
                                            <Avatar
                                              alt=""
                                              fallback={avatar.name ?? label}
                                              src={avatar.src}
                                              size="small"
                                              shape={avatar.shape}
                                            />
                                          ) : (
                                            <PageIcon
                                              icon={icon}
                                              image={image}
                                              size={21}
                                            />
                                          )}
                                        </span>
                                      }
                                      label={
                                        <>
                                          <span className="block truncate text-body-sm">
                                            <MatchedLabel
                                              label={label}
                                              positions={matches}
                                            />
                                          </span>
                                          {detail && (
                                            <span
                                              className={`block text-body-sm text-subtle ${multiline ? "whitespace-pre-wrap" : "truncate"}`}
                                            >
                                              {/* Read in place of the icon. jsdom (dom-accessibility-api) trims
                                                each element's text, so the space sits outside the span;
                                                browsers don't trim it. Shown, the space collapses at the
                                                line's start. */}
                                              {detailIconLabel && (
                                                <>
                                                  <span className="sr-only">{`${detailIconLabel},`}</span>{" "}
                                                </>
                                              )}
                                              {/* Text-sized and spaced as LinkLabel shows a channel mention's icon. */}
                                              {DetailIcon && (
                                                <DetailIcon
                                                  className={channelIconClass(
                                                    DetailIcon,
                                                  )}
                                                />
                                              )}
                                              {detail}
                                            </span>
                                          )}
                                        </>
                                      }
                                      trailing={trailing}
                                      onClick={() => highlight.choose(key)}
                                    />
                                  </div>
                                </div>
                              ),
                          )}
                          {(notice ||
                            (!destinations.length && !headingStatus)) && (
                            <div role={hasControls ? "row" : "presentation"}>
                              <div
                                role={hasControls ? "gridcell" : "presentation"}
                              >
                                {notice}
                                {!destinations.length && (
                                  <p className="search-palette-group-empty">
                                    {empty ?? "No matching results."}
                                  </p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ),
                )}
            </div>
            {children && (
              <div className="search-palette-status">{children}</div>
            )}
          </div>
        </div>
        {peek?.ranked && (
          <aside className="search-peek-side" aria-label="Preview">
            <div className="search-peek-preview" aria-live="polite">
              {(() => {
                const row =
                  destinations.find(({ key }) => key === selected) ??
                  (selected
                    ? undefined
                    : destinations.find(({ key }) => !isAction?.(key)));
                return peek.preview(
                  row,
                  row &&
                    merged.find((group) =>
                      group.destinations.some(({ key }) => key === row.key),
                    )?.tone,
                );
              })()}
            </div>
            {ranked.length > 1 && (
              <nav className="search-peek-rail" aria-label="Result groups">
                <div className="search-peek-rail-head text-body-sm text-subtle">
                  <span>{query.trim() ? "Show" : "Browse"}</span>
                  <kbd>Tab</kbd>
                </div>
                {[undefined, ...ranked].map((group, index) => {
                  const Icon = group
                    ? (group.icon ?? group.destinations[0]?.icon)
                    : query.trim()
                      ? MagnifyingGlassIcon
                      : ClockIcon;
                  return (
                    <button
                      key={group?.label ?? ""}
                      type="button"
                      tabIndex={-1}
                      className="search-peek-rail-item text-body-sm"
                      aria-pressed={
                        (scoped?.label ?? undefined) === group?.label
                      }
                      title={group?.why}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => showScope(group?.label)}
                    >
                      {Icon && (
                        <span
                          className="search-peek-tile"
                          data-tone={group?.tone}
                          aria-hidden="true"
                        >
                          <Icon size={12} />
                        </span>
                      )}
                      <span className="search-peek-rail-label">
                        {group?.label ??
                          (query.trim() ? "Top results" : "Jump back in")}
                        {index === 1 && !!query.trim() && (
                          <small className="search-peek-best">Best match</small>
                        )}
                      </span>
                      <span className="search-peek-count">
                        {group
                          ? countOf(group)
                          : ranked.reduce(
                              (sum, item) =>
                                sum +
                                (item.browse ? 0 : resultRows(item).length),
                              0,
                            )}
                      </span>
                    </button>
                  );
                })}
              </nav>
            )}
          </aside>
        )}
      </div>
      {footer && <div className="search-palette-footer">{footer}</div>}
      {peek?.ranked && (
        <div
          className="search-peek-keys text-body-sm text-subtle"
          aria-hidden="true"
        >
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Move
          </span>
          {ranked.length > 1 && (
            <span>
              <kbd>Tab</kbd> Next group
            </span>
          )}
          {ranked.length > 1 && (
            <span>
              <kbd>⇧</kbd>
              <kbd>Tab</kbd> Previous
            </span>
          )}
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>esc</kbd> {scoped ? "Back to top" : "Close"}
          </span>
        </div>
      )}
    </div>
  );
}
