import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaretDownIcon,
  CaretUpIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { activeModal } from "../../shared/design-system/overlayLayer";
import { FIND_LIMIT, findRanges } from "../../features/search/find-in-page";
import type { ShortcutsService } from "../../features/shortcuts/service";
import { HOST_SHORTCUT_ORDER } from "../shortcuts";
import styles from "./FindInPage.module.css";

const MATCHES = "buzz-find";
const ACTIVE = "buzz-find-active";
/** Typing waits this long; arriving messages recount after a longer pause. */
const TYPING_DELAY = 100;
const MUTATION_DELAY = 250;
/** Content that never pauses, such as a streaming reply, still recounts. */
const MUTATION_MAX_WAIT = 1000;
/** Attributes that show, hide or cover content without changing its text. */
const VISIBILITY = [
  "class",
  "style",
  "hidden",
  "inert",
  "aria-hidden",
  "aria-modal",
  "open",
];

function paint(ranges: readonly Range[], active: number) {
  // Without the Custom Highlight API the bar still counts and scrolls.
  const highlights = globalThis.CSS?.highlights;
  if (!highlights) return;
  highlights.set(
    MATCHES,
    new Highlight(...ranges.filter((_, index) => index !== active)),
  );
  highlights.set(ACTIVE, new Highlight(...ranges.slice(active, active + 1)));
}
function unpaint() {
  globalThis.CSS?.highlights?.delete(MATCHES);
  globalThis.CSS?.highlights?.delete(ACTIVE);
}
/**
 * Find on screen: Chrome's find bar over the rendered window. It paints with
 * the Custom Highlight API, so the DOM React and the composer own is never
 * touched. While a modal is open it searches, and sits inside, that modal.
 */
export function FindInPage({
  shortcuts,
}: {
  shortcuts?: Pick<ShortcutsService, "registerHost"> | undefined;
}) {
  const [root, setRoot] = useState<Element | null>(null);
  const [query, setQuery] = useState("");
  // The count names the query it was taken for: "No results" waits for a search.
  const [count, setCount] = useState({ active: 0, total: 0, query: "" });
  const [opened, setOpened] = useState(0);
  const bar = useRef<HTMLElement>(null);
  const input = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const ranges = useRef<Range[]>([]);
  const active = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef({ root, query });
  latest.current = { root, query };

  const show = useCallback((index: number, scroll: boolean) => {
    const list = ranges.current;
    active.current = list.length ? (index + list.length) % list.length : 0;
    paint(list, active.current);
    setCount({
      active: active.current,
      total: list.length,
      query: latest.current.query.trim(),
    });
    if (scroll)
      list[active.current]?.startContainer.parentElement?.scrollIntoView({
        block: "center",
        inline: "nearest",
      });
  }, []);
  const close = useCallback(() => {
    const scope = latest.current.root;
    unpaint();
    ranges.current = [];
    setRoot(null);
    const focus = returnFocus.current;
    returnFocus.current = null;
    // Not into the page behind a dialog that opened meanwhile.
    if (focus?.isConnected && scope?.contains(focus))
      focus.focus({ preventScroll: true });
  }, []);
  /** Recount from the DOM, keeping the active match where it was. */
  const search = useCallback(
    (scroll: boolean) => {
      const { root, query } = latest.current;
      clearTimeout(typing.current);
      typing.current = undefined;
      if (!root) return;
      if (!root.isConnected) return close();
      const previous = ranges.current[active.current];
      ranges.current = findRanges(root, query, bar.current);
      const next = previous
        ? ranges.current.findIndex(
            (range) =>
              range.compareBoundaryPoints(Range.START_TO_START, previous) >= 0,
          )
        : 0;
      show(Math.max(next, 0), scroll);
    },
    [close, show],
  );
  const open = useCallback(() => {
    const focused = document.activeElement;
    if (!bar.current?.contains(focused))
      returnFocus.current = focused instanceof HTMLElement ? focused : null;
    setRoot(activeModal(document) ?? document.body);
    setOpened((count) => count + 1);
  }, []);

  useEffect(
    () =>
      shortcuts?.registerHost({
        id: "find-in-page",
        title: "Find on screen",
        binding: { key: "f", mod: true, shift: true },
        order: HOST_SHORTCUT_ORDER.search + 2,
        allowInEditable: true,
        allowInModal: true,
        run: open,
      }),
    [shortcuts, open],
  );
  // Each opening, including one while already open, selects the query.
  useEffect(() => {
    if (!opened) return;
    const field = input.current;
    field?.focus();
    if (field instanceof HTMLInputElement) field.select();
  }, [opened]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each query restarts the typing pause.
  useEffect(() => {
    if (!root) return;
    typing.current = setTimeout(() => search(true), TYPING_DELAY);
    return () => clearTimeout(typing.current);
  }, [root, query, search]);
  // Messages arrive, tabs change and dialogs open underneath; keep the scope
  // and count current.
  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let since = 0;
    const observer = new MutationObserver((records) => {
      if (records.every((record) => bar.current?.contains(record.target)))
        return;
      // The bar follows the top modal in and out, so it stays reachable.
      const scope = activeModal(document) ?? document.body;
      if (scope !== latest.current.root) return setRoot(scope);
      if (timer === undefined) since = Date.now();
      clearTimeout(timer);
      const wait = Math.min(
        MUTATION_DELAY,
        since + MUTATION_MAX_WAIT - Date.now(),
      );
      timer = setTimeout(() => {
        timer = undefined;
        search(false);
      }, wait);
    });
    // The body, not the root: modals open and close outside it.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: VISIBILITY,
    });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [root, search]);
  useEffect(() => unpaint, []);

  if (!root) return null;
  const total =
    count.total === FIND_LIMIT ? `${FIND_LIMIT}+` : String(count.total);
  const label =
    !query.trim() || !count.query
      ? ""
      : count.total
        ? `${count.active + 1} of ${total}`
        : "No results";
  const step = (by: number) => show(active.current + by, true);
  return createPortal(
    <search
      ref={bar}
      aria-label="Find on screen"
      className={styles.bar}
      onKeyDown={(event) => {
        // Enter and Escape belong to an input method while it composes.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          return;
        if (event.key === "Escape") {
          // Close only the bar, never a dialog underneath.
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault();
          // Enter before the typing pause ends finds the new text first.
          if (typing.current !== undefined) search(true);
          else step(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className={styles.field}>
        <SearchField
          variant="capsule"
          label="Find on screen"
          placeholder="Find on screen"
          value={query}
          onValueChange={setQuery}
          inputRef={input}
          trailing={
            <span className={styles.count} role="status">
              {label}
            </span>
          }
        />
      </div>
      <IconButton
        aria-label="Previous match"
        icon={<CaretUpIcon size={16} aria-hidden="true" />}
        disabled={!count.total}
        onClick={() => step(-1)}
      />
      <IconButton
        aria-label="Next match"
        icon={<CaretDownIcon size={16} aria-hidden="true" />}
        disabled={!count.total}
        onClick={() => step(1)}
      />
      <IconButton
        aria-label="Close find on screen"
        icon={<XIcon size={16} aria-hidden="true" />}
        onClick={close}
      />
    </search>,
    root,
  );
}
