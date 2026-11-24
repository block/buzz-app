import type { PopoverRoot as BasePopoverRoot } from "@base-ui/react/popover";
import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
} from "react";
import { XIcon } from "../icons/index";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
} from "./Popover";

export type TourPage = {
  id: string;
  title: string;
  description?: ReactNode;
  /** Decorative illustration, usually a Schematic scene. Hidden from assistive tech. */
  visual: ReactNode;
};

type TourProps = {
  open: boolean;
  /** Called once the person finishes or dismisses the tour. */
  onDismiss: (reason: "finished" | "declined" | "dismissed") => void;
  /** The last page's forward action; "Got it" by default. */
  finishLabel?: string;
  /** Turns the last page into a choice under its copy: this answer declines,
   * finishLabel accepts, and the footer keeps only Back. */
  declineLabel?: string;
  pages: readonly TourPage[];
  /** Names the tour for assistive tech, such as "What's new in the sidebar". */
  label: string;
} & Pick<
  ComponentProps<typeof PopoverPopup>,
  "anchor" | "side" | "align" | "sideOffset" | "alignOffset"
>;

/**
 * A short paged introduction that floats beside the feature it explains. It
 * never takes focus on its own or closes on an outside click, so work can
 * continue around it; Escape and the close button dismiss it. It opens at its
 * anchor, and the person can drag it by any spot that is not a control.
 */
export function Tour({
  open,
  onDismiss,
  finishLabel = "Got it",
  declineLabel,
  pages,
  label,
  side = "right",
  align = "end",
  sideOffset = 12,
  alignOffset,
  anchor,
}: TourProps) {
  const [index, setIndex] = useState(0);
  const labelId = useId();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
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
  const page = pages[Math.min(index, pages.length - 1)];
  if (!page) return null;
  const last = index >= pages.length - 1;
  const choice = last && declineLabel !== undefined;
  const go = (next: number) =>
    setIndex(Math.max(0, Math.min(pages.length - 1, next)));
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
    <PopoverRoot open={open} onOpenChange={change}>
      <PopoverPopup
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        elevation="overlay"
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
        <div data-buzz-ui="" className="buzz-tour">
          <span id={labelId} className="sr-only">
            {label}
          </span>
          {/* A fresh scene per page restarts its loop, so the fade stays in
              step with the motion instead of carrying over mid-loop. */}
          <div key={page.id} className="buzz-tour-visual" aria-hidden="true">
            {page.visual}
          </div>
          <span className="buzz-tour-close">
            <IconButton
              aria-label="Close"
              icon={<XIcon />}
              variant="ghost"
              size="xs"
              onClick={() => onDismiss("dismissed")}
            />
          </span>
          {/* The page change is announced through the title and step count. */}
          <div className="buzz-tour-copy" aria-live="polite">
            <PopoverTitle>{page.title}</PopoverTitle>
            {page.description != null && (
              <PopoverDescription>{page.description}</PopoverDescription>
            )}
            <span className="sr-only">
              Step {index + 1} of {pages.length}
            </span>
          </div>
          {/* A choice is the last page's answer, not a step, so it sits with
              the question and the footer keeps Back meaning back. */}
          {choice && (
            <div className="buzz-tour-choice">
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
          <div className="buzz-tour-footer">
            {pages.length > 1 ? (
              <span className="buzz-tour-dots" aria-hidden="true">
                {pages.map((item, position) => (
                  <span
                    key={item.id}
                    className="buzz-tour-dot"
                    data-active={position === index ? "" : undefined}
                  />
                ))}
              </span>
            ) : (
              <span />
            )}
            <span className="buzz-tour-actions">
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
