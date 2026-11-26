import { useRef, useState, type ReactNode } from "react";
import { MagnifyingGlassIcon } from "../../shared/design-system/icons";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { TranscriptFind, TranscriptSearch } from "./TranscriptFind";
import styles from "./ActivityLayout.module.css";

/** A searchable transcript with a header that stays above its matches. */
export function TranscriptView({
  scope,
  actions,
  children,
}: {
  scope: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState(scope);
  if (searchScope !== scope) {
    setSearchScope(scope);
    setFindOpen(false);
    setQuery("");
  }
  const openFind = () => {
    setFindOpen(true);
    const input =
      content.current?.previousElementSibling?.querySelector<HTMLInputElement>(
        'input[type="search"]',
      );
    input?.focus();
    input?.select();
  };
  const closeFind = () => {
    setFindOpen(false);
    findButton.current?.focus({ preventScroll: true });
  };
  return (
    <TranscriptSearch.Provider
      value={findOpen ? query.trim().toLowerCase() : ""}
    >
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
                  title="Find in transcript (⌘F / Ctrl+F)"
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
              onQueryChange={setQuery}
              onClose={closeFind}
            />
          )}
        </div>
        <div ref={content}>{children}</div>
      </section>
    </TranscriptSearch.Provider>
  );
}
