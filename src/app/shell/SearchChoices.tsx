import { matchRank } from "../../features/search/match";
import {
  useLayoutEffect,
  useRef,
  useEffect,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import { PageIcon } from "./PageIcon";
import "./SearchChoices.css";

export type SearchDestination = {
  content?: ReactNode;
  rank?: number;
  key: string;
  label: string;
  detail?: string;
  /** Code points of `label` that match the typed text. */
  matches?: readonly number[];
  icon: typeof ChatCircleIcon;
  image?: string | undefined;
  avatar?:
    | { src?: string | undefined; shape: "circle" | "squircle" }
    | undefined;
  run: () => void;
};

export type SearchGroup = {
  label: string;
  destinations: readonly SearchDestination[];
  empty?: ReactNode;
  notice?: ReactNode;
};

export type SearchInputProps = {
  inlineSettings?: readonly SearchGroup[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  scope?: { label: string; onRemove: () => void } | undefined;
  authorChip?:
    | { label: string; title: string; onRemove: () => void }
    | undefined;
  displayQuery?: string | undefined;
  onDisplayQueryChange?: ((value: string) => void) | undefined;
};

export function SearchChoices({
  groups: originalGroups,
  query,
  onQueryChange,
  authorChip,
  displayQuery,
  onDisplayQueryChange,
  input,
  label = "Search Buzz",
  scope,
  children,
  inlineSettings,
}: SearchInputProps & {
  groups: readonly SearchGroup[];
  children?: ReactNode;
}) {
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
    Math.min(
      ...group.destinations.map(
        (row) =>
          row.rank ??
          Math.min(
            matchRank(row.label, needle) ?? Infinity,
            matchRank(row.detail ?? "", needle) ?? Infinity,
          ),
      ),
    );
  const groups = [...originalGroups, ...(inlineSettings ?? [])];
  if (needle && inlineSettings?.some((group) => group.destinations.length))
    groups.sort((a, b) => score(a) - score(b));
  const hasControls = groups.some((group) =>
    group.destinations.some((row) => row.content),
  );
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  const highlight = useSearchHighlight({
    query,
    keys: destinations.map(({ key }) => key),
    onChoose: (key) => destinations.find((row) => row.key === key)?.run(),
  });
  const selected = highlight.active;
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  return (
    <div
      className="search-palette"
      data-search-palette=""
      {...highlight.listProps}
    >
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
      <SearchField
        variant="palette"
        prefix={
          authorChip ? (
            <span className="search-palette-author-prefix">
              <button
                type="button"
                className="search-palette-author-chip"
                aria-label={`Remove author ${authorChip.label}`}
                title={authorChip.title}
                onClick={authorChip.onRemove}
              >
                <span aria-hidden="true">×</span> from:@{authorChip.label}
              </button>
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
        placeholder="Search..."
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
              if (!event.repeat) destination.run();
            }
            return;
          }
          highlight.keyDown(event);
        }}
      />
      <div ref={resultsViewport} className="search-palette-height">
        <div ref={resultsContent} className="search-palette-scroll">
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid and listbox support an accessible label. */}
          <div
            id={highlight.listId}
            role={hasControls ? "grid" : "listbox"}
            aria-label="Search results"
            className="search-palette-results interaction-panel"
          >
            {groups
              .filter(
                ({ destinations, empty }) =>
                  destinations.length || empty !== undefined,
              )
              .map(({ label, destinations, empty, notice }) => (
                // biome-ignore lint/a11y/useSemanticElements: A listbox option group is not a form fieldset.
                <div
                  key={label}
                  role="group"
                  aria-label={label}
                  className="search-palette-group"
                >
                  <NavigationSection label={label}>
                    {destinations.map(
                      ({
                        content,
                        key,
                        label,
                        detail,
                        matches,
                        icon,
                        image,
                        avatar,
                        run,
                      }) =>
                        content ? (
                          // biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table.
                          <div
                            key={key}
                            {...highlight.rowProps(key)}
                            role="row"
                            aria-selected={selected === key}
                            tabIndex={-1}
                            className="search-control-row"
                            data-highlighted={selected === key || undefined}
                            onClick={(event) => {
                              if (
                                (event.target as HTMLElement).closest(
                                  "button, input, label, [role=switch], [role=combobox]",
                                )
                              )
                                return;
                              run();
                            }}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                run();
                              } else highlight.rowProps(key).onKeyDown(event);
                            }}
                          >
                            {/* biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table. */}
                            <div id={key} role="gridcell" tabIndex={-1}>
                              {content}
                            </div>
                          </div>
                        ) : (
                          <div
                            key={key}
                            role={hasControls ? "row" : "presentation"}
                          >
                            <div
                              role={hasControls ? "gridcell" : "presentation"}
                            >
                              <NavigationItem
                                variant="search"
                                key={key}
                                {...highlight.rowProps(key)}
                                role={hasControls ? "button" : "option"}
                                aria-selected={
                                  hasControls ? undefined : selected === key
                                }
                                tabIndex={-1}
                                aria-current={false}
                                highlighted={selected === key}
                                data-search-result=""
                                aria-keyshortcuts={
                                  shortcutNumbers.has(key)
                                    ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                                    : undefined
                                }
                                icon={
                                  <span className="grid size-6 shrink-0 items-center justify-items-start">
                                    {avatar ? (
                                      <Avatar
                                        alt=""
                                        fallback={label}
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
                                      <span className="block truncate text-body-sm text-subtle">
                                        {detail}
                                      </span>
                                    )}
                                  </>
                                }
                                onClick={run}
                              />
                            </div>
                          </div>
                        ),
                    )}
                    {notice}
                    {!destinations.length && (
                      <p className="search-palette-group-empty">
                        {empty ?? "No matching results."}
                      </p>
                    )}
                  </NavigationSection>
                </div>
              ))}
          </div>
          {children && <div className="search-palette-status">{children}</div>}
        </div>
      </div>
    </div>
  );
}
