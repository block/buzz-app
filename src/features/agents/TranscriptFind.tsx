import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  CaretDownIcon,
  CaretUpIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { FIND_LIMIT, findRanges } from "../search/find-in-page";
import {
  clearHighlights,
  paintHighlights,
  revealRange,
} from "../search/range-highlights";
import { sectionTitle, type TranscriptItem } from "./activity-transcript";
import styles from "./TranscriptFind.module.css";

export const TranscriptSearch = createContext("");

/** Only matching disclosures mount their bodies while searching. */
export function itemMatches(item: TranscriptItem, query: string): boolean {
  const includes = (text: string) => text.toLowerCase().includes(query);
  switch (item.type) {
    case "system":
      return item.sections.some(
        (section) =>
          includes(sectionTitle(section.tag)) || includes(section.body),
      );
    case "prompt":
      return (
        includes(item.text) ||
        item.sections.some(
          (section) =>
            includes(sectionTitle(section.tag)) || includes(section.body),
        )
      );
    case "tool":
      return (
        includes(item.title) ||
        includes(item.input) ||
        includes(item.output) ||
        item.diffs.some(
          (diff) =>
            includes(diff.path) ||
            includes(diff.oldText ?? "") ||
            includes(diff.newText),
        ) ||
        !!item.children?.some((child) => itemMatches(child, query))
      );
    case "plan":
      return item.entries.some((entry) => includes(entry.content));
    default:
      return includes(item.text);
  }
}

/** Restore the reader's expansion when a search no longer needs it open. */
export function useSearchDisclosure(matches: (query: string) => boolean) {
  const query = useContext(TranscriptSearch);
  const ref = useRef<HTMLDetailsElement>(null);
  const matching = Boolean(query && matches(query));
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query reopens matches the reader closed during the previous query.
  useLayoutEffect(() => {
    const details = ref.current;
    if (!details || !matching) return;
    const wasOpen = details.open;
    details.open = true;
    return () => {
      details.open = wasOpen;
    };
  }, [matching, query]);
  return { ref, matching };
}

/** Find in the loaded transcript, never in the surrounding conversation. */
export function TranscriptFind({
  content,
  query,
  onQueryChange,
  onClose,
}: {
  content: RefObject<HTMLDivElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}) {
  const id = `transcript-find-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const input = useRef<HTMLElement>(null);
  const ranges = useRef<Range[]>([]);
  const active = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [count, setCount] = useState({ active: 0, total: 0, query: "" });
  const latest = useRef(query);
  latest.current = query;

  const show = useCallback(
    (index: number, scroll: boolean) => {
      const list = ranges.current;
      active.current = list.length ? (index + list.length) % list.length : 0;
      paintHighlights(id, list, active.current);
      setCount({
        active: active.current,
        total: list.length,
        query: latest.current.trim(),
      });
      const range = list[active.current];
      if (scroll && range)
        revealRange(range, content.current?.previousElementSibling);
    },
    [id, content],
  );
  const search = useCallback(
    (scroll: boolean) => {
      clearTimeout(pending.current);
      pending.current = undefined;
      if (!content.current) return;
      const previous = ranges.current[active.current];
      ranges.current = findRanges(content.current, latest.current);
      const next = previous
        ? ranges.current.findIndex(
            (range) =>
              range.compareBoundaryPoints(Range.START_TO_START, previous) >= 0,
          )
        : 0;
      show(Math.max(0, next), scroll);
    },
    [content, show],
  );

  useEffect(() => {
    input.current?.focus();
    if (input.current instanceof HTMLInputElement) input.current.select();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: typed text starts at its first match after matching disclosures have mounted.
  useEffect(() => {
    ranges.current = [];
    clearHighlights(id);
    pending.current = setTimeout(() => search(true), 100);
    return () => clearTimeout(pending.current);
  }, [query, search, id]);
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let since = 0;
    const observer = new MutationObserver(() => {
      if (timer === undefined) since = Date.now();
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = undefined;
          search(false);
        },
        Math.min(250, since + 1000 - Date.now()),
      );
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: ["open"],
    });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [content, search]);
  useEffect(() => () => clearHighlights(id), [id]);
  const step = (by: number) => {
    if (pending.current !== undefined) search(true);
    else show(active.current + by, true);
  };
  const total =
    count.total === FIND_LIMIT ? `${FIND_LIMIT}+` : String(count.total);
  const label =
    !query.trim() || count.query !== query.trim()
      ? ""
      : count.total
        ? `${count.active + 1} of ${total}`
        : "No results";
  return (
    <search
      className={styles.bar}
      aria-label="Find in transcript"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <style>{`::highlight(${id}) { background-color: var(--surface-find-match); color: var(--text-on-find-match); }
::highlight(${id}-active) { background-color: var(--surface-find-match-active); color: var(--text-on-find-match); }`}</style>
      <div className={styles.field}>
        <SearchField
          variant="capsule"
          label="Find in transcript"
          placeholder="Find in transcript"
          value={query}
          onValueChange={onQueryChange}
          inputRef={input}
          trailing={
            <span className={`text-caption ${styles.count}`} role="status">
              {label}
            </span>
          }
        />
      </div>
      <IconButton
        title="Previous match"
        aria-label="Previous match"
        disabled={!count.total}
        onClick={() => step(-1)}
        icon={<CaretUpIcon size={16} aria-hidden="true" />}
      />
      <IconButton
        title="Next match"
        aria-label="Next match"
        disabled={!count.total}
        onClick={() => step(1)}
        icon={<CaretDownIcon size={16} aria-hidden="true" />}
      />
      <IconButton
        title="Close find in transcript"
        aria-label="Close find in transcript"
        onClick={onClose}
        icon={<XIcon size={16} aria-hidden="true" />}
      />
    </search>
  );
}
