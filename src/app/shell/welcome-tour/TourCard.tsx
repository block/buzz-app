import type { PopoverRoot as BasePopoverRoot } from "@base-ui/react/popover";
import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
} from "react";
import { XIcon } from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import { IconButton } from "../../../shared/design-system/ui/IconButton";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
} from "../../../shared/design-system/ui/Popover";
import styles from "./WelcomeTour.module.css";

export type TourPage = {
  id: string;
  title: string;
  description: ReactNode;
  /** A decorative drawing, hidden from assistive tech. */
  visual: ReactNode;
};

/**
 * A paged card that floats beside what it explains. It never takes focus on
 * its own or closes on an outside click, so work can continue around it;
 * Escape and the close button end it. It can be dragged by any spot that is
 * not a control, and starts fresh at each new anchor.
 */
export function TourCard({
  label,
  pages,
  index,
  onIndexChange,
  onDismiss,
  finishLabel = "Got it",
  declineLabel,
  anchor,
  side,
  align,
}: {
  /** Names the tour for assistive tech. */
  label: string;
  pages: readonly TourPage[];
  index: number;
  onIndexChange: (index: number) => void;
  onDismiss: (reason: "finished" | "declined" | "dismissed") => void;
  /** The last page's forward action. */
  finishLabel?: string;
  /** Turns the last page into a choice under its copy: this declines,
   * finishLabel accepts, and the footer keeps only Back. */
  declineLabel?: string | undefined;
} & Pick<ComponentProps<typeof PopoverPopup>, "anchor" | "side" | "align">) {
  const labelId = useId();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  // A card that moves to a new anchor starts there, not where it was dragged.
  const [placed, setPlaced] = useState(anchor);
  if (placed !== anchor) {
    setPlaced(anchor);
    setOffset({ x: 0, y: 0 });
  }
  const grab = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button, a, input")) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX - offset.x,
      y: event.clientY - offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setOffset({ x: event.clientX - start.x, y: event.clientY - start.y });
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };
  const page = pages[index];
  if (!page) return null;
  const last = index === pages.length - 1;
  const choice = last && declineLabel !== undefined;
  const go = (next: number) =>
    onIndexChange(Math.max(0, Math.min(pages.length - 1, next)));
  const change = (
    next: boolean,
    details: BasePopoverRoot.ChangeEventDetails,
  ) => {
    if (next) return;
    if (details.reason === "outside-press" || details.reason === "focus-out") {
      details.cancel();
      return;
    }
    onDismiss("dismissed");
  };
  return (
    <PopoverRoot open onOpenChange={change}>
      <PopoverPopup
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={12}
        initialFocus={false}
        finalFocus={false}
        role="dialog"
        aria-labelledby={labelId}
        style={{ translate: `${offset.x}px ${offset.y}px` }}
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") go(index + 1);
          if (event.key === "ArrowLeft") go(index - 1);
        }}
      >
        <div className={styles.card}>
          <span id={labelId} className="sr-only">
            {label}
          </span>
          {/* A fresh drawing per page restarts its loop. */}
          <div key={page.id}>{page.visual}</div>
          <span className={styles.close}>
            <IconButton
              aria-label="Close"
              icon={<XIcon />}
              variant="ghost"
              size="xs"
              onClick={() => onDismiss("dismissed")}
            />
          </span>
          {/* The page change is announced through the title and step count. */}
          <div className={styles.copy} aria-live="polite">
            <PopoverTitle>{page.title}</PopoverTitle>
            <PopoverDescription>{page.description}</PopoverDescription>
            <span className="sr-only">
              Step {index + 1} of {pages.length}
            </span>
          </div>
          {choice && (
            <div className={styles.choice}>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => onDismiss("declined")}
              >
                {declineLabel}
              </Button>
              <Button
                variant="prominent"
                size="sm"
                onClick={() => onDismiss("finished")}
              >
                {finishLabel}
              </Button>
            </div>
          )}
          <div className={styles.footer}>
            <span className={styles.dots} aria-hidden="true">
              {pages.map((item, position) => (
                <span
                  key={item.id}
                  className={styles.dot}
                  data-active={position === index ? "" : undefined}
                />
              ))}
            </span>
            <span className={styles.actions}>
              {index > 0 && (
                <Button variant="ghost" size="sm" onClick={() => go(index - 1)}>
                  Back
                </Button>
              )}
              {!choice && (
                <Button
                  variant="prominent"
                  size="sm"
                  onClick={() => (last ? onDismiss("finished") : go(index + 1))}
                >
                  {last ? finishLabel : "Next"}
                </Button>
              )}
            </span>
          </div>
        </div>
      </PopoverPopup>
    </PopoverRoot>
  );
}
