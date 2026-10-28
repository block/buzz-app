import { createPortal } from "react-dom";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ComposerInputElement } from "../messages/composer-dom";
import {
  COMPLETION_RETRY,
  type CompletionGeneration,
  type CompletionPresentation,
  type CompletionSession,
} from "./completion-session";
import { useCompletionPosition } from "./useCompletionPosition";
import styles from "./Completions.module.css";

/** Presentation acknowledges only the exact immutable snapshot it committed. */
export function CompletionMenu({
  session,
  generation,
  input,
}: {
  session: CompletionSession;
  generation: CompletionGeneration;
  input: RefObject<ComposerInputElement | null>;
}) {
  // Presentation is a React state projection, not the command store. Provider
  // publication remains synchronous, while ordinary/transition render priority
  // is preserved instead of forcing every external result into a sync commit.
  const [snapshot, show] = useState<CompletionPresentation | undefined>(
    session.snapshot,
  );
  useLayoutEffect(() => {
    const update = () => show(session.snapshot());
    const release = session.subscribe(update);
    update(); // A layout-publishing provider may precede this subscription.
    return release;
  }, [session]);
  const presentation =
    snapshot?.generation === generation ? snapshot : undefined;
  const result = presentation?.publication?.result;
  const provider = generation.provider;
  const compact = provider.pluginId === "buzz.emoji";
  const mention = provider.pluginId === "buzz.mentions";
  const channel = provider.pluginId === "buzz.channels";
  const named = mention || channel;
  const popup = useCompletionPosition(
    input,
    compact ? 0.375 : 1,
    named
      ? { preferAbove: true, gap: 4, maxWidth: channel ? 480 : 380 }
      : undefined,
  );
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const items = result?.items ?? [];
  const count = items.length + (result?.retry ? 1 : 0);
  const visible = !!(count || result?.status);
  const status = result?.status;
  const index =
    presentation?.selected === COMPLETION_RETRY && result?.retry
      ? items.length
      : items.findIndex((item) => item.id === presentation?.selected);
  const selectedIndex = index < 0 ? 0 : index;
  useLayoutEffect(() => {
    const reveal = session.committed(generation, presentation);
    const element = input.current;
    if (!element) return;
    if (visible) {
      element.setAttribute("aria-autocomplete", "list");
      element.setAttribute("aria-haspopup", "listbox");
      element.setAttribute("aria-controls", id);
      if (count)
        element.setAttribute("aria-activedescendant", `${id}-${selectedIndex}`);
      else element.removeAttribute("aria-activedescendant");
    }
    if (reveal)
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    return () => {
      element.removeAttribute("aria-autocomplete");
      element.removeAttribute("aria-haspopup");
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
    };
  });
  return visible && input.current
    ? createPortal(
        <section
          ref={popup}
          className={styles.popup}
          aria-label={`${provider.title} suggestions`}
          data-compact={compact || undefined}
          data-mention={named || undefined}
          data-channel={channel || undefined}
        >
          <div
            id={id}
            role="listbox"
            aria-label={`${provider.title} suggestions`}
            ref={list}
            className={styles.list}
          >
            {items.map((item, i) => (
              // The textarea owns keyboard focus/selection via aria-activedescendant.
              // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
              <div
                role="option"
                tabIndex={-1}
                aria-selected={i === selectedIndex}
                aria-disabled={!!item.disabled}
                aria-label={
                  compact && item.detail
                    ? `${item.label} ${item.detail}`
                    : undefined
                }
                id={`${id}-${i}`}
                key={item.id}
                onPointerDown={(event) => {
                  if (event.button === 0) event.preventDefault();
                }}
                onPointerMove={
                  compact || named
                    ? () => {
                        session.select(generation, item.id);
                      }
                    : undefined
                }
                onClick={() => session.accept(generation, item.id)}
                className={styles.option}
              >
                {item.preview && (
                  <span aria-hidden="true" className={styles.preview}>
                    {item.preview}
                  </span>
                )}
                <span className={styles.label} data-completion-label>
                  {named ? (
                    <span className={styles.name}>{item.label}</span>
                  ) : (
                    item.label
                  )}
                  {item.detail && (
                    <small
                      aria-hidden={compact || undefined}
                      data-recipient-key={
                        (mention && /^[0-9a-f]{64}$/.test(item.detail)) ||
                        undefined
                      }
                      title={mention ? item.detail : undefined}
                    >
                      {item.detail}
                    </small>
                  )}
                </span>
                {channel && i === selectedIndex && (
                  <span aria-hidden="true" className={styles.acceptKey}>
                    Enter
                  </span>
                )}
              </div>
            ))}
            {result?.retry && (
              // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
              <div
                role="option"
                tabIndex={-1}
                id={`${id}-${items.length}`}
                aria-selected={selectedIndex === items.length}
                className={styles.option}
                onPointerDown={(event) => {
                  if (event.button === 0) event.preventDefault();
                }}
                onPointerMove={
                  compact || named
                    ? () => {
                        session.select(generation, COMPLETION_RETRY);
                      }
                    : undefined
                }
                onClick={() => session.accept(generation, COMPLETION_RETRY)}
              >
                Retry suggestions
              </div>
            )}
          </div>
          {status && <p role="status">{status}</p>}
        </section>,
        // A body sibling would sit behind a fullscreen modal and outside its
        // accessibility boundary. Ordinary composers keep the body portal.
        input.current.closest('[role="dialog"][aria-modal="true"]') ??
          input.current.ownerDocument.body,
      )
    : null;
}
