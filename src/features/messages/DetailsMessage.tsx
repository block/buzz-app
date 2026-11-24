import {
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

const HEADING = /^H[1-6]$/;

/** Whether the chat holds back any of the message: a later block, or a brief
 * longer than its lines. The brief follows a leading heading when an older
 * details message has one. */
function holdsBack(clip: HTMLElement) {
  const text = clip.firstElementChild;
  if (!text) return false;
  const blocks = [...text.children];
  const shown = blocks[0] && HEADING.test(blocks[0].tagName) ? 2 : 1;
  return (
    blocks.length > shown ||
    blocks
      .slice(0, shown)
      .some((block) => block.scrollHeight > block.clientHeight + 1)
  );
}

/** A Details message opens in its own row when read in a thread. */
export function DetailsMessage({
  children,
  onToggle,
}: {
  children: ReactNode;
  onToggle?: (() => void) | undefined;
}) {
  const contentId = useId();
  const clip = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An edit can change what is clipped without resizing the row.
  useLayoutEffect(() => {
    const element = clip.current;
    if (!element || expanded) return;
    const measure = () => setClipped(holdsBack(element));
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [children, expanded]);
  const toggle = () => {
    onToggle?.();
    setExpanded(!expanded);
  };
  return (
    <div
      className={styles.detailsPreview}
      data-clipped={(clipped && !expanded) || undefined}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Show more is the keyboard path; this only widens the pointer target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Show more is the keyboard path; this only widens the pointer target. */}
      <div
        id={contentId}
        ref={clip}
        className={expanded ? undefined : styles.detailsClip}
        onClick={(event) => {
          // Links, mentions and selected text keep their own meaning.
          if (
            !clipped ||
            expanded ||
            (event.target instanceof Element &&
              event.target.closest("a, button, [role=button]")) ||
            !getSelection()?.isCollapsed
          )
            return;
          toggle();
        }}
      >
        {children}
      </div>
      {(clipped || expanded) && (
        <span className={styles.detailsMore}>
          <Button
            variant="link"
            size="inline"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggle}
          >
            {expanded ? "Show less" : "Show more"}
          </Button>
        </span>
      )}
    </div>
  );
}
