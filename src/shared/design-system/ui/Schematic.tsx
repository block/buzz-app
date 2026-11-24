import { Children, type CSSProperties, type ReactNode, useState } from "react";
import { HandGrabIcon, HandStopIcon, PointerIcon } from "../icons/index";

/*
 * Schematic parts draw simplified product UI (cards, rows, handles and a hand)
 * for illustrations such as Tour pages. They are decorative: the scene hides
 * itself from assistive tech, so the surrounding copy must carry the meaning.
 * Motion loops on one shared timeline; reduced motion holds the finished frame.
 */

type Vars = CSSProperties & Record<`--${string}`, string | number>;

export function SchematicScene({
  children,
  alternate,
  still = false,
}: {
  children: ReactNode;
  /**
   * A second drawing that takes turns with children, one loop each, swapping
   * while the scene is faded out. Reduced motion holds children.
   */
  alternate?: ReactNode;
  /** Hold a single frame instead of looping, for a scene that only sets context. */
  still?: boolean;
}) {
  const [turn, setTurn] = useState(0);
  return (
    <div
      data-buzz-ui=""
      className="buzz-schematic-scene"
      data-still={still ? "" : undefined}
      aria-hidden="true"
    >
      <div
        className="buzz-schematic-stage"
        onAnimationIteration={(event) => {
          // Parts loop on the same timeline; only the stage's own loop counts.
          if (event.target !== event.currentTarget) return;
          if (alternate) setTurn(turn === 0 ? 1 : 0);
        }}
      >
        {/* A fresh mount restarts the drawing's parts on the stage's loop. */}
        <div key={turn} className="buzz-schematic-turn">
          {turn === 1 && alternate ? alternate : children}
        </div>
      </div>
    </div>
  );
}

type CardMotion =
  /** Rows reveal as the resize handle is dragged down. */
  | "grow"
  /** Rows reveal after the header is double-clicked. */
  | "expand"
  /** The card is raised and trades places with the card below it. */
  | "lift"
  /** The card moves up to fill the lifted card's place. */
  | "yield"
  /** Every row shows, then the card trims down to its visible rows. */
  | "trim";

export function SchematicCard({
  header,
  children,
  grip,
  footer,
  visibleRows,
  motion,
  travel = 0,
}: {
  /** Overlays for the header, such as a pointer. */
  header?: ReactNode;
  /** SchematicRow parts. */
  children?: ReactNode;
  /** The resize handle along the card's bottom edge, inside it as in the app. */
  grip?: ReactNode;
  /** Shown beneath the card, outside it, such as a SchematicDropLine. */
  footer?: ReactNode;
  /** Rows showing before the motion; the rest reveal as it plays. */
  visibleRows?: number;
  motion?: CardMotion;
  /** Rows in the other card of a lift and yield pair, so the two swap exactly. */
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
        {grip}
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

/** The resize handle along the bottom edge inside a card. */
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
