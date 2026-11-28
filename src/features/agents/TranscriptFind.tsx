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
  type ReactEventHandler,
} from "react";
import {
  CaretDownIcon,
  CaretUpIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { FIND_LIMIT, findTranscriptRanges } from "../search/find-in-page";
import {
  clearHighlights,
  paintHighlights,
  revealRange,
} from "../search/range-highlights";
import remarkGfm from "remark-gfm";
import { parseForGuard } from "../markdown/guard";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import { Button } from "../../shared/design-system/ui/Button";
import { sectionTitle, type TranscriptItem } from "./activity-transcript";
import styles from "./TranscriptFind.module.css";

export type TranscriptSearchState = {
  open: boolean;
  query: string;
  active: RefObject<Range | null>;
  closing: RefObject<boolean>;
  automatic: WeakSet<HTMLDetailsElement>;
  kept: Set<HTMLDetailsElement>;
};
export const TranscriptSearch = createContext<
  TranscriptSearchState | undefined
>(undefined);

const markdownText = new WeakMap<TranscriptItem, string>();
/** A conservative candidate filter; only rendered DOM determines occurrences. */
function renderedCandidate(item: TranscriptItem & { text: string }) {
  let text = markdownText.get(item);
  if (text !== undefined) return text;
  text = item.text;
  if (text.length <= MAX_MARKDOWN_LENGTH && !scanMarkdown(text).tooDeep) {
    const tree = parseForGuard(text, {
      syntax: [remarkGfm],
      transforms: [],
      html: "literal",
    });
    const values: string[] = [];
    const visit = (node: { value?: string; children?: readonly unknown[] }) => {
      if (node.value !== undefined) values.push(node.value);
      for (const child of node.children ?? [])
        visit(child as Parameters<typeof visit>[0]);
    };
    visit(tree);
    text = values.join("");
  }
  markdownText.set(item, text.toLowerCase());
  return text.toLowerCase();
}

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
    case "message":
    case "thought":
      return includes(item.text) || renderedCandidate(item).includes(query);
    default:
      return includes(item.text);
  }
}

/** Search expansion is temporary; a reader's own toggles remain theirs. */
export function useSearchDisclosure(
  matches: (query: string) => boolean,
  initiallyVisited = false,
) {
  const search = useContext(TranscriptSearch);
  const query = search?.query ?? "";
  const ref = useRef<HTMLDetailsElement>(null);
  const prior = useRef<{ open: boolean } | undefined>(undefined);
  const [visited, setVisited] = useState(initiallyVisited);
  const matching = Boolean(query && matches(query));
  if (initiallyVisited && !visited) setVisited(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: query changes reopen matches; the search session's refs are stable.
  useLayoutEffect(() => {
    const details = ref.current;
    if (!details || !matching || !search) return;
    const snapshot = { open: details.open };
    prior.current = snapshot;
    if (!details.open) {
      search.automatic.add(details);
      details.open = true;
    }
    return () => {
      prior.current = undefined;
      if (search.closing.current && search.kept.has(details)) {
        setVisited(true);
      } else if (details.open && details.open !== snapshot.open) {
        search.automatic.add(details);
        details.open = snapshot.open;
      }
    };
  }, [matching, query]);
  const onClick: ReactEventHandler<HTMLElement> = (event) => {
    const details = ref.current;
    if (!details) return;
    const target = event.target;
    if (event.defaultPrevented || !(target instanceof Element)) return;
    if (
      target.closest("summary")?.parentElement !== details ||
      target.closest("a, button, input, select, textarea")
    )
      return;
    // Native toggle arrives later; record the summary's default action now.
    if (prior.current) prior.current.open = !details.open;
    if (!details.open) setVisited(true);
  };
  const onToggle: ReactEventHandler<HTMLDetailsElement> = (event) => {
    const details = event.currentTarget;
    if (search?.automatic.delete(details)) return;
    if (prior.current) prior.current.open = details.open;
    if (details.open) setVisited(true);
  };
  return {
    ref,
    mounted:
      visited ||
      matching ||
      !!(
        search?.closing.current &&
        ref.current &&
        search.kept.has(ref.current)
      ),
    onToggle,
    onClick,
  };
}

export type TranscriptHistory = {
  omitted: boolean;
  loadEarlier?: (() => void) | undefined;
  loading?: boolean | undefined;
};

/** Find in the loaded transcript, never in the surrounding conversation. */
export function TranscriptFind({
  content,
  query,
  onQueryChange,
  onClose,
  settledQuery,
  history,
}: {
  content: RefObject<HTMLDivElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  settledQuery: string;
  history?: TranscriptHistory | undefined;
}) {
  const id = `transcript-find-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const input = useRef<HTMLElement>(null);
  const session = useContext(TranscriptSearch);
  const ranges = useRef<Range[]>([]);
  const active = useRef(0);
  const [count, setCount] = useState({ active: 0, total: 0, query: "" });

  const show = useCallback(
    (index: number, scroll: boolean) => {
      const list = ranges.current;
      active.current = list.length ? (index + list.length) % list.length : 0;
      paintHighlights(id, list, active.current);
      setCount({
        active: active.current,
        total: list.length,
        query: settledQuery.trim(),
      });
      const range = list[active.current];
      if (session) session.active.current = range ?? null;
      if (scroll && range) {
        for (
          let element = range.startContainer.parentElement;
          element;
          element = element.parentElement
        ) {
          if (element instanceof HTMLDetailsElement && !element.open) {
            session?.automatic.add(element);
            element.open = true;
          }
        }
        revealRange(range, content.current?.previousElementSibling);
      }
    },
    [id, content, session, settledQuery],
  );
  const search = useCallback(
    (scroll: boolean) => {
      if (!content.current) return;
      const previous = ranges.current[active.current];
      ranges.current = findTranscriptRanges(content.current, settledQuery);
      const next = previous
        ? ranges.current.findIndex(
            (range) =>
              range.compareBoundaryPoints(Range.START_TO_START, previous) >= 0,
          )
        : 0;
      show(Math.max(0, next), scroll);
    },
    [content, show, settledQuery],
  );

  useEffect(() => {
    input.current?.focus();
    if (input.current instanceof HTMLInputElement) input.current.select();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: typed text starts at its first match after matching disclosures have mounted.
  useEffect(() => {
    ranges.current = [];
    clearHighlights(id);
    if (session) session.active.current = null;
    search(true);
  }, [settledQuery, search, id]);
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
  useEffect(() => {
    if (query.trim() !== settledQuery.trim()) {
      clearHighlights(id);
      if (session) session.active.current = null;
    }
  }, [query, settledQuery, id, session]);
  useEffect(() => () => clearHighlights(id), [id]);
  const step = (by: number) => {
    if (query.trim() === settledQuery.trim()) show(active.current + by, true);
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
          aria-describedby={history?.omitted ? `${id}-scope` : undefined}
        />
      </div>
      <div className={styles.navigation}>
        <span className={`text-caption ${styles.count}`} role="status">
          {label}
        </span>
        <IconButton
          title="Previous match"
          aria-label="Previous match"
          disabled={!count.total || count.query !== query.trim()}
          onClick={() => step(-1)}
          icon={<CaretUpIcon size={16} aria-hidden="true" />}
        />
        <IconButton
          title="Next match"
          aria-label="Next match"
          disabled={!count.total || count.query !== query.trim()}
          onClick={() => step(1)}
          icon={<CaretDownIcon size={16} aria-hidden="true" />}
        />
        <IconButton
          title="Close find in transcript"
          aria-label="Close find in transcript"
          onClick={onClose}
          icon={<XIcon size={16} aria-hidden="true" />}
        />
      </div>
      {history?.omitted && (
        <div
          id={`${id}-scope`}
          className={`text-caption text-subtle ${styles.scope}`}
        >
          Search covers loaded activity only.{" "}
          {history.loadEarlier && (
            <Button
              variant="plain"
              size="inline"
              loading={history.loading ?? false}
              onClick={() => {
                input.current?.focus({ preventScroll: true });
                history.loadEarlier?.();
              }}
            >
              Load earlier activity
            </Button>
          )}
        </div>
      )}
    </search>
  );
}
