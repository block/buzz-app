import type { ReactNode } from "react";
import {
  AtIcon,
  BellIcon,
  HashIcon,
  LockIcon,
  PlugIcon,
  RobotIcon,
  ThreadIcon,
  UserIcon,
} from "../../../shared/design-system/icons";
import styles from "./WelcomeTour.module.css";

/*
 * Small decorative drawings for the welcome tour's cards: a conversation, a
 * list or the search field. They hide from assistive tech, so each card's copy
 * carries the meaning. Motion loops on one shared timeline; reduced motion
 * holds the finished frame.
 */

export function Scene({
  children,
  still = false,
  wide = false,
}: {
  children: ReactNode;
  /** Hold one frame instead of looping, for a drawing that only sets context. */
  still?: boolean;
  /** Use more of the frame, for a conversation's messages. */
  wide?: boolean;
}) {
  return (
    <div
      className={styles.scene}
      data-still={still ? "" : undefined}
      data-wide={wide ? "" : undefined}
      aria-hidden="true"
    >
      <div className={styles.stage}>{children}</div>
    </div>
  );
}

/** A conversation or list: a title bar, then its rows. */
export function Sketch({
  header,
  children,
}: {
  /** Shown with the title, such as a Bell. */
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.sketch}>
      <div className={styles.header}>
        <span className={styles.bar} />
        {header}
      </div>
      {children}
    </div>
  );
}

/** Someone's avatar: a person (circle) or an agent (squircle), with its icon. */
export function Mark({ lead }: { lead: "person" | "agent" }) {
  return (
    <span className={styles.mark} data-lead={lead}>
      {lead === "agent" ? <RobotIcon /> : <UserIcon />}
    </span>
  );
}

export function Row({
  lead = "plugin",
  tone = "neutral",
  enter,
  kind,
  trail,
}: {
  /** The leading mark: a plugin (rounded square), a person (circle) or an agent (squircle). */
  lead?: "plugin" | "person" | "agent";
  /** Accent marks the row the drawing is about. */
  tone?: "neutral" | "accent";
  /** Arrive on the timeline; the step staggers rows that arrive together. */
  enter?: 1 | 2 | 3;
  /** What it is, shown before its text: a mention (@) or a thread reply. */
  kind?: "mention" | "reply";
  /** A control at the row's end, such as a Switch. */
  trail?: ReactNode;
}) {
  return (
    <span className={styles.row} data-tone={tone} data-enter={enter}>
      {lead === "plugin" ? (
        <span className={styles.lead}>
          <PlugIcon />
        </span>
      ) : (
        <Mark lead={lead} />
      )}
      {kind != null && (
        <span className={styles.kind}>
          {kind === "mention" ? <AtIcon /> : <ThreadIcon />}
        </span>
      )}
      <span className={styles.bar} />
      {trail != null && <span className={styles.trail}>{trail}</span>}
    </span>
  );
}

/**
 * A message in a conversation. Someone else's has their mark beside it; your
 * own sits at the end, as in Buzz. With reply, it shows typing dots first and
 * becomes the message at that later step.
 */
export function Message({
  from = "person",
  own = false,
  length = "long",
  enter,
  reply,
}: {
  /** Who sent it: a person (circle) or an agent (squircle). */
  from?: "person" | "agent";
  own?: boolean;
  length?: "short" | "long";
  enter?: 1 | 2 | 3 | 4;
  reply?: 2 | 3 | 4;
}) {
  return (
    <span
      className={styles.message}
      data-own={own ? "" : undefined}
      data-length={length}
      data-enter={enter}
    >
      {!own && <Mark lead={from} />}
      <span className={styles.bubble} data-reply={reply}>
        {reply && (
          <span className={styles.typing}>
            <span className={styles.pip} />
            <span className={styles.pip} />
            <span className={styles.pip} />
          </span>
        )}
        <span className={styles.bar} />
      </span>
    </span>
  );
}

/** Who is in a conversation, overlapping as avatar stacks do. */
export function Faces({
  of,
  at = "start",
}: {
  of: readonly ("person" | "agent")[];
  /** Before the title, or at the header's end. */
  at?: "start" | "end";
}) {
  return (
    <span className={styles.faces} data-at={at}>
      {of.map((lead, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <Mark key={index} lead={lead} />
      ))}
    </span>
  );
}

/** A channel's # before its title. */
export function Hash() {
  return <HashIcon className={styles.glyph} />;
}

export function Plug() {
  return <PlugIcon className={styles.glyph} />;
}

/** A lock at the header's end, for something private. */
export function Lock() {
  return <LockIcon className={`${styles.glyph} ${styles.end}`} />;
}

/** The bell before a title, ringing once as the first item arrives. */
/** The Activity bell; it rings, and shows a dot, as things arrive. */
export function Bell() {
  return (
    <span className={styles.bell}>
      <BellIcon />
      <span className={styles.badge} />
    </span>
  );
}

/** An on/off switch; flip turns on during the loop. */
export function Switch({ state = "off" }: { state?: "off" | "on" | "flip" }) {
  return (
    <span className={styles.switch} data-state={state}>
      <span className={styles.knob} />
    </span>
  );
}

/** The search field: an agent's face unless agent is false, then a question typing itself out. */
export function Search({ agent = true }: { agent?: boolean }) {
  return (
    <span className={styles.search} data-agent={agent}>
      {agent && <Mark lead="agent" />}
      <span className={styles.typed} />
    </span>
  );
}
