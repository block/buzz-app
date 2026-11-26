import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MagnifyingGlassIcon } from "../../shared/design-system/icons";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useDebounced } from "../../shared/search-debounce";
import { formatBinding, isApplePlatform } from "../shortcuts/format";
import { revealRange } from "../search/range-highlights";
import {
  TranscriptFind,
  TranscriptSearch,
  type TranscriptHistory,
} from "./TranscriptFind";
import styles from "./ActivityLayout.module.css";

/** A searchable transcript with a header that stays above its matches. */
type Props = {
  scope: string;
  actions?: ReactNode;
  history?: TranscriptHistory;
  children: ReactNode;
};
export function TranscriptView(props: Props) {
  return <ScopedTranscriptView key={props.scope} {...props} />;
}
function ScopedTranscriptView({ actions, history, children }: Props) {
  const content = useRef<HTMLDivElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const active = useRef<Range | null>(null);
  const closing = useRef(false);
  const automatic = useRef(new WeakSet<HTMLDetailsElement>()).current;
  const kept = useRef(new WeakSet<HTMLDetailsElement>()).current;
  const anchor = useRef<{ range: Range; top: number } | undefined>(undefined);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const settledQuery = useDebounced(query, 100);
  const search = useMemo(
    () => ({
      open: findOpen,
      query: findOpen ? settledQuery.trim().toLowerCase() : "",
      active,
      closing,
      automatic,
      kept,
    }),
    [findOpen, settledQuery, automatic, kept],
  );
  const openFind = () => {
    if (!findOpen) {
      opener.current =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : null;
      closing.current = false;
      active.current = null;
      setFindOpen(true);
    }
    const input =
      content.current?.previousElementSibling?.querySelector<HTMLInputElement>(
        'input[type="search"]',
      );
    input?.focus();
    input?.select();
  };
  const closeFind = () => {
    const range = active.current;
    const chain: HTMLDetailsElement[] = [];
    for (
      let element = range?.startContainer.parentElement;
      element;
      element = element.parentElement
    ) {
      if (element instanceof HTMLDetailsElement) chain.push(element);
    }
    if (chain.every((details) => details.open)) {
      for (const details of chain) kept.add(details);
    }
    if (range?.getBoundingClientRect)
      anchor.current = { range, top: range.getBoundingClientRect().top };
    closing.current = true;
    setFindOpen(false);
    const target = opener.current?.isConnected
      ? opener.current
      : findButton.current;
    target?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (findOpen) return;
    const held = anchor.current;
    anchor.current = undefined;
    if (held?.range.startContainer.isConnected && !held.range.collapsed) {
      for (
        let element = content.current?.parentElement;
        element;
        element = element.parentElement
      ) {
        element.scrollTop += held.range.getBoundingClientRect().top - held.top;
      }
      revealRange(held.range, content.current?.previousElementSibling);
    }
    closing.current = false;
  }, [findOpen]);
  const shortcut = formatBinding(
    { key: "f", mod: true },
    isApplePlatform(navigator.platform),
  ).text;
  return (
    <TranscriptSearch.Provider value={search}>
      <section
        className={styles.transcript}
        data-transcript
        aria-label="Agent transcript"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "f"
          ) {
            event.preventDefault();
            event.stopPropagation();
            openFind();
          }
        }}
      >
        <div className={styles.transcriptHeader} data-transcript-header>
          <InlineHeader
            title="Transcript"
            actions={
              <>
                <IconButton
                  ref={findButton}
                  hint="familiar"
                  aria-label="Find in transcript"
                  title={`Find in transcript (${shortcut})`}
                  onClick={openFind}
                  icon={<MagnifyingGlassIcon size="1rem" aria-hidden="true" />}
                />
                {actions}
              </>
            }
          />
          {findOpen && (
            <TranscriptFind
              content={content}
              query={query}
              settledQuery={settledQuery}
              onQueryChange={setQuery}
              onClose={closeFind}
              history={history}
            />
          )}
        </div>
        <div ref={content}>{children}</div>
      </section>
    </TranscriptSearch.Provider>
  );
}
