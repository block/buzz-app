import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import { PageIcon } from "./PageIcon";
import "./SearchChoices.css";

export type SearchDestination = {
  key: string;
  label: string;
  detail?: string;
  icon: typeof ChatCircleIcon;
  image?: string | undefined;
  run: () => void;
};

const isWordChar = (char: string | undefined) =>
  /[\p{L}\p{N}]/u.test(char ?? "");

/** How well a label matches typed text: exact, then prefix, then word start,
 * then any substring, then a fuzzy match whose letters each continue a run
 * that began at a word start ("bgp" in "buzz-github-prs"), then any fuzzy
 * match (the letters appear in order). Lower is better; undefined means no
 * match. Ranks are whole numbers, so callers can add fractional tie-breaks. */
export function matchRank(label: string, needle: string) {
  const text = label.toLowerCase();
  if (text === needle) return 0;
  let rank: number | undefined;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + 1)
  ) {
    if (at === 0) return 1;
    if (!isWordChar(text[at - 1])) return 2;
    rank = 3;
  }
  if (rank !== undefined) return rank;
  // Spaces in typed text only separate words; they need not match.
  const letters = [...needle.replace(/\s+/g, "")];
  const chars = [...text];
  if (!letters.length) return undefined;
  // Can letters[i..] match chars[j..] with every run starting at a word start?
  // `inRun` means the previous letter matched chars[j - 1].
  const memo = new Map<number, boolean>();
  const wordRuns = (i: number, j: number, inRun: boolean): boolean => {
    if (i === letters.length) return true;
    if (j === chars.length) return false;
    const key = (i * (chars.length + 1) + j) * 2 + (inRun ? 1 : 0);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const startsRun = inRun || !isWordChar(chars[j - 1]);
    const result =
      (chars[j] === letters[i] && startsRun && wordRuns(i + 1, j + 1, true)) ||
      wordRuns(i, j + 1, false);
    memo.set(key, result);
    return result;
  };
  if (wordRuns(0, 0, false)) return 4;
  let i = 0;
  for (const char of chars) if (char === letters[i]) i += 1;
  return i === letters.length ? 5 : undefined;
}

export type SearchInputProps = {
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  placeholder?: string | undefined;
  scope?: { label: string; onRemove: () => void } | undefined;
};

export function SearchChoices({
  groups,
  query,
  onQueryChange,
  input,
  label = "Search Buzz",
  placeholder = "Search pages, conversations and messages…",
  scope,
  children,
}: SearchInputProps & {
  groups: readonly {
    label: string;
    destinations: readonly SearchDestination[];
    empty?: ReactNode;
  }[];
  children?: ReactNode;
}) {
  const id = useId();
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  // Typed text selects its first result, so Enter opens it without a pointer.
  // Follow a destination's identity, not its index, as relay results arrive:
  // a later row inserted above cannot redirect Enter. When the selected row
  // leaves, fall back to the first result rather than reviving the old one.
  const [selection, setSelection] = useState({ query, key: "" });
  const valid =
    selection.query === query &&
    destinations.some(({ key }) => key === selection.key);
  const fallback = query.trim() ? (destinations[0]?.key ?? "") : "";
  if (!valid && (selection.query !== query || selection.key !== fallback))
    setSelection({ query, key: fallback });
  const selected = valid ? selection.key : fallback;
  const optionId = (key: string) => `${id}-${key}`;
  // WebKit replays a pointer event when rows move under a resting cursor.
  // Only a real move may select a row, or new results would steal Enter.
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const pointerMoved = (event: PointerEvent) => {
    const last = pointer.current;
    pointer.current = { x: event.screenX, y: event.screenY };
    return !!last && (last.x !== event.screenX || last.y !== event.screenY);
  };
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  useEffect(() => {
    if (selected)
      document
        .getElementById(`${id}-${selected}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected, id]);
  return (
    <div
      className="search-palette"
      data-search-palette=""
      onPointerMove={(event) => {
        pointer.current = { x: event.screenX, y: event.screenY };
      }}
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
        inputRef={input}
        role="combobox"
        aria-controls={id}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={selected ? optionId(selected) : undefined}
        label={label}
        placeholder={placeholder}
        value={query}
        onValueChange={onQueryChange}
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
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          const index = destinations.findIndex(({ key }) => key === selected);
          if (event.key === "Enter" && index >= 0) {
            event.preventDefault();
            destinations[index]?.run();
          } else if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            destinations.length
          ) {
            event.preventDefault();
            const next =
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : destinations.length - 1
                : Math.max(
                    0,
                    Math.min(
                      destinations.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
            setSelection({ query, key: destinations[next]?.key ?? "" });
          }
        }}
      />
      <div className="search-palette-scroll">
        <div
          id={id}
          role="listbox"
          aria-label="Search results"
          className="search-palette-results"
        >
          {groups
            .filter(
              ({ destinations, empty }) =>
                destinations.length || empty !== undefined,
            )
            .map(({ label, destinations, empty }) => (
              // biome-ignore lint/a11y/useSemanticElements: A listbox option group is not a form fieldset.
              <div
                key={label}
                role="group"
                aria-label={label}
                className="search-palette-group"
              >
                <NavigationSection label={label}>
                  {destinations.map(
                    ({ key, label, detail, icon, image, run }) => (
                      <NavigationItem
                        key={key}
                        id={optionId(key)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected === key}
                        aria-current={false}
                        selected={selected === key}
                        data-search-result=""
                        aria-keyshortcuts={
                          shortcutNumbers.has(key)
                            ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                            : undefined
                        }
                        icon={
                          <span className="grid size-6 shrink-0 place-items-center">
                            <PageIcon icon={icon} image={image} size={17} />
                          </span>
                        }
                        label={
                          <>
                            <span className="block truncate text-body-sm">
                              {label}
                            </span>
                            {detail && (
                              <span className="block truncate text-caption text-subtle">
                                {detail}
                              </span>
                            )}
                          </>
                        }
                        onClick={run}
                        onPointerMove={(event) => {
                          if (
                            event.pointerType !== "touch" &&
                            pointerMoved(event) &&
                            selected !== key
                          )
                            setSelection({ query, key });
                        }}
                      />
                    ),
                  )}
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
  );
}
