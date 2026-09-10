import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Smile } from "lucide-react";
import type { RelaySession } from "../relay/session";
import styles from "./Messages.module.css";

/** Reusable composer picker; data/signing remain owned by the community session. */
export function EmojiPicker({
  session,
  scope,
  disabled,
  insert,
}: {
  session: RelaySession;
  scope: string;
  disabled: boolean;
  insert(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [perLine, setPerLine] = useState(0);
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const search = useRef("");
  const onInsert = useRef(insert);
  onInsert.current = insert;
  const id = useId();
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  useEffect(() => {
    // The popover is positioned against the action row; intermediate tool groups
    // may be narrower and are not its available width.
    const container = controls.current?.offsetParent;
    if (!open || disabled || !(container instanceof HTMLElement)) return;
    const resize = () =>
      setPerLine(
        Math.max(1, Math.min(8, Math.floor((container.clientWidth - 28) / 36))),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [open, disabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed lazy import.
  useEffect(() => {
    if (!open || disabled || !host.current || !perLine) return;
    const container = host.current;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setError(undefined);
    // Keep the Unicode dataset and search work out of startup/channel opening.
    void import("./emoji-mart")
      .then(({ mountEmojiMart }) => {
        if (cancelled) return;
        dispose = mountEmojiMart({
          host: container,
          scope,
          perLine,
          search: search.current,
          entries: catalog.status === "ready" ? catalog.entries : [],
          media: session.media,
          select: (value) => {
            onInsert.current(value);
            setOpen(false);
          },
          close: () => setOpen(false),
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !controls.current?.contains(event.target)
      )
        setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => {
      cancelled = true;
      search.current =
        container
          .querySelector("em-emoji-picker")
          ?.shadowRoot?.querySelector<HTMLInputElement>('input[type="search"]')
          ?.value ?? search.current;
      dispose?.();
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, disabled, session, scope, catalog, attempt, perLine]);
  return (
    <fieldset
      ref={controls}
      disabled={disabled}
      aria-label="Emoji controls"
      className={styles.emojiPicker}
      onKeyDownCapture={(event) => {
        // Mart stops search key events before they bubble out of its shadow root.
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Insert emoji"
        title="Insert emoji"
        aria-expanded={open && !disabled}
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          if (!open) void session.emoji.ensure();
        }}
      >
        <Smile size={20} aria-hidden="true" />
      </button>
      {open && !disabled && (
        <section
          id={id}
          className={styles.emojiPopover}
          aria-label="Emoji picker"
          style={{ width: perLine * 36 + 28 }}
        >
          <div ref={host} className={styles.emojiMart} />
          {error && (
            <div role="alert" className={styles.emojiStatus}>
              Could not load emoji picker: {error}
              <button type="button" onClick={() => retry(attempt + 1)}>
                Retry picker
              </button>
            </div>
          )}
          {catalog.error && (
            <div className={styles.emojiStatus}>
              <p role="alert">{catalog.error}</p>
              <button
                type="button"
                onClick={() => void session.emoji.refresh()}
              >
                Retry emoji
              </button>
            </div>
          )}
        </section>
      )}
    </fieldset>
  );
}
