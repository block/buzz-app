import { Children, type CSSProperties, type ReactNode } from "react";
import { HandGrabIcon, HandStopIcon, PointerIcon } from "../icons/index";

/*
 * Schematic parts draw simplified product UI (cards, rows, handles and a hand)
 * for illustrations such as Tour pages. They are decorative: the scene hides
 * itself from assistive tech, so the surrounding copy must carry the meaning.
 * Motion loops on one shared timeline; reduced motion holds the finished frame.
 */

type Vars = CSSProperties & Record<`--${string}`, string | number>;

export function SchematicScene({ children }: { children: ReactNode }) {
  return (
    <div data-buzz-ui="" className="buzz-schematic-scene" aria-hidden="true">
      <div className="buzz-schematic-stage">{children}</div>
    </div>
  );
}

type CardMotion =
  /** Rows reveal as the resize handle is dragged down. */
  | "grow"
  /** Rows reveal after the header is double-clicked. */
  | "expand"
  /** The card shrinks to its header and travels down past its neighbor. */
  | "lift"
  /** The card moves up to fill the lifted card's place. */
  | "yield";

export function SchematicCard({
  header,
  children,
  footer,
  visibleRows,
  motion,
  travel = 0,
}: {
  /** Overlays for the header, such as a pointer. */
  header?: ReactNode;
  /** SchematicRow parts. */
  children?: ReactNode;
  /** Shown beneath the card, such as a SchematicGrip. */
  footer?: ReactNode;
  /** Rows showing before the motion; the rest reveal as it plays. */
  visibleRows?: number;
  motion?: CardMotion;
  /** Distance a lift or yield travels, in row units. */
  travel?: number;
}) {
  const total = Children.count(children);
  const style: Vars = {
    "--schematic-total": total,
    "--schematic-visible": visibleRows ?? total,
    "--schematic-travel": travel,
  };
  return (
    <div className="buzz-schematic-slot" data-motion={motion} style={style}>
      <div className="buzz-schematic-card">
        <div className="buzz-schematic-header">
          <span className="buzz-schematic-bar" />
          {header}
        </div>
        {total > 0 && <div className="buzz-schematic-rows">{children}</div>}
      </div>
      {footer}
    </div>
  );
}

export function SchematicRow({
  lead = "channel",
  tone = "neutral",
  enter,
}: {
  /** The leading mark: a channel glyph, a person, or a chat bubble. */
  lead?: "channel" | "person" | "chat";
  /** Accent marks the row the scene is about. */
  tone?: "neutral" | "accent";
  /** Slide in on the timeline; the step staggers rows that arrive together. */
  enter?: 1 | 2 | 3;
}) {
  return (
    <span className="buzz-schematic-row" data-tone={tone} data-enter={enter}>
      <span className="buzz-schematic-lead" data-lead={lead} />
      <span className="buzz-schematic-bar" />
    </span>
  );
}

/** The resize handle beneath a card. */
export function SchematicGrip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent";
  /** Overlays such as a pointer. */
  children?: ReactNode;
}) {
  return (
    <span className="buzz-schematic-grip" data-tone={tone}>
      <span className="buzz-schematic-grip-bar" />
      {children}
    </span>
  );
}

/** The insertion line a drag shows where the card will land. */
export function SchematicDropLine() {
  return <span className="buzz-schematic-drop-line" />;
}

export function SchematicPointer({
  motion,
}: {
  /**
   * drag grabs, follows its host part, and releases; double-tap clicks twice
   * in place. Place the pointer inside the part it acts on.
   */
  motion: "drag" | "double-tap";
}) {
  return (
    <span className="buzz-schematic-pointer" data-motion={motion}>
      {motion === "drag" ? (
        <>
          <HandStopIcon className="buzz-schematic-hand" data-hand="open" />
          <HandGrabIcon className="buzz-schematic-hand" data-hand="grab" />
        </>
      ) : (
        <PointerIcon className="buzz-schematic-hand" data-hand="pointer" />
      )}
    </span>
  );
}
