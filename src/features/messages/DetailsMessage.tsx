import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import styles from "./Messages.module.css";

const HEADING = /^H[1-6]$/;

/** The blocks the chat shows: the opening brief, after a leading heading when
 * an older details message has one. */
const shownBlocks = (blocks: Element[]) =>
  blocks[0] && HEADING.test(blocks[0].tagName) ? 2 : 1;

/** Whether the chat holds back any of the message: a later block, or a brief
 * longer than its lines. */
function holdsBack(clip: HTMLElement) {
  const text = clip.firstElementChild;
  if (!text) return false;
  const blocks = [...text.children];
  const shown = shownBlocks(blocks);
  return (
    blocks.length > shown ||
    blocks
      .slice(0, shown)
      .some((block) => block.scrollHeight > block.clientHeight + 1)
  );
}

/** A details message reads in the chat as its opening brief; Show more opens
 * it whole in a dialog. */
export function DetailsMessage({
  author,
  createdAt,
  preview,
  children,
}: {
  author: string;
  createdAt: number;
  /** The whole message as the chat renders it; only its brief shows. */
  preview: ReactNode;
  /** The dialog's body. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = clip.current;
    if (!element) return;
    const measure = () => setClipped(holdsBack(element));
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  return (
    <div className={styles.detailsPreview} data-clipped={clipped || undefined}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Show more is the keyboard path; this only widens the pointer target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Show more is the keyboard path; this only widens the pointer target. */}
      <div
        ref={clip}
        className={styles.detailsClip}
        onClick={(event) => {
          // Links, mentions and selected text keep their own meaning.
          if (
            !clipped ||
            (event.target instanceof Element &&
              event.target.closest("a, button, [role=button]")) ||
            !getSelection()?.isCollapsed
          )
            return;
          setOpen(true);
        }}
      >
        {preview}
      </div>
      {clipped && (
        <span className={styles.detailsMore}>
          <Button
            ref={trigger}
            variant="link"
            size="inline"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            Show more
          </Button>
        </span>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={author}
        description={formatItemTimestamp(createdAt, { withTime: true })}
        closeLabel="Close details"
        finalFocus={trigger}
      >
        <div className={styles.detailsReader}>{children}</div>
      </Dialog>
    </div>
  );
}
