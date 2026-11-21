import type { PopoverRoot as BasePopoverRoot } from "@base-ui/react/popover";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
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
  onDismiss: (reason: "finished" | "dismissed") => void;
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
 * continue around it; Escape and the close button dismiss it.
 */
export function Tour({
  open,
  onDismiss,
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
  const page = pages[Math.min(index, pages.length - 1)];
  if (!page) return null;
  const last = index >= pages.length - 1;
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
        initialFocus={false}
        finalFocus={false}
        role="dialog"
        aria-labelledby={labelId}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") go(index + 1);
          if (event.key === "ArrowLeft") go(index - 1);
        }}
      >
        <div data-buzz-ui="" className="buzz-tour">
          <span id={labelId} className="sr-only">
            {label}
          </span>
          <div className="buzz-tour-visual" aria-hidden="true">
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
              <Button
                variant="prominent"
                size="sm"
                onClick={() => (last ? onDismiss("finished") : go(index + 1))}
              >
                {last ? "Got it" : "Next"}
              </Button>
            </span>
          </div>
        </div>
      </PopoverPopup>
    </PopoverRoot>
  );
}
