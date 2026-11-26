import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import type { ReactNode } from "react";
import { Avatar } from "./Avatar";
import styles from "./AvatarStack.module.css";

type StackAvatar = {
  id: string;
  name: string;
  src?: string | undefined;
  /** Shown instead of the name's initial, such as a workflow's icon. */
  fallbackContent?: ReactNode;
  shape: "circle" | "squircle";
};

/** Compact identity artwork. The enclosing control supplies its accessible name. */
export function AvatarStack({
  items,
  size = "compact",
  max = 3,
  animateEntrance = false,
  animateChanges = false,
}: {
  items: readonly StackAvatar[];
  /** badge: small enough to sit on another avatar's corner. */
  size?: "compact" | "small" | "mini" | "badge" | "hero" | "hero-large";
  /** How many avatars show before the overflow count. */
  max?: number;
  /** Playful hero entry, matching the huddle avatar spring. */
  animateEntrance?: boolean;
  /** Avatars that join after mount slide out from behind the last one, and
   * leaving ones slide back behind it. The stack stays mounted while empty,
   * so the last ones can leave too. */
  animateChanges?: boolean;
}) {
  const reduced = useReducedMotion();
  const Item = animateEntrance
    ? EntranceItem
    : animateChanges
      ? motion.span
      : "span";
  if (!items.length && !animateChanges) return null;
  const shown = Math.min(items.length, max);
  const avatars = items.slice(0, max).map((item, index) => (
    <Item
      key={item.id}
      className={styles.item}
      // Each overlaps the one before it.
      style={{ zIndex: index + 1 }}
      {...(animateChanges && change(index, shown, reduced))}
      data-avatar-shape={item.shape}
      title={item.name}
    >
      <Avatar
        src={item.src}
        alt=""
        fallback={item.name}
        fallbackContent={
          item.fallbackContent ??
          (size === "mini" || size === "badge" ? (
            <span className={`${styles.miniInitial} text-caption`}>
              {Array.from(item.name.trim())[0]?.toUpperCase() || "?"}
            </span>
          ) : undefined)
        }
        shape={item.shape}
        size="fill"
      />
    </Item>
  ));
  const Root = animateChanges ? motion.span : "span";
  return (
    <Root
      className={`${styles.root} text-caption`}
      aria-hidden="true"
      data-avatar-stack=""
      data-size={size}
      // Faces slide within the stack, never with a row that moves.
      {...(animateChanges && { layoutRoot: true })}
    >
      {animateChanges ? (
        <AnimatePresence initial={false}>{avatars}</AnimatePresence>
      ) : (
        avatars
      )}
      {items.length > max &&
        (size === "hero" || size === "hero-large" ? (
          // A hero count is one more stack item, shaped like the avatars.
          <span
            className={styles.item}
            data-avatar-shape={items[0]?.shape}
            style={{ zIndex: max + 1 }}
          >
            <span
              className={`${styles.countFill} text-label`}
              data-avatar-shape={items[0]?.shape}
            >
              +{items.length - max}
            </span>
          </span>
        ) : (
          <span className={styles.count}>+{items.length - max}</span>
        ))}
    </Root>
  );
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** How far apart overlapping badge avatars start, in pixels. */
const STACK_STEP = 9;

/** The stack grows leftward from its front (last) avatar: avatars slide out
 * from behind it as they join, and the others slide over to make room.
 * Leaving avatars fade together while sliding back behind it; the front one
 * fades in place. */
function change(index: number, shown: number, reduced: boolean | null) {
  const behind = { opacity: 0, x: (shown - 1 - index) * STACK_STEP };
  return {
    layout: "position" as const,
    initial: behind,
    animate: { opacity: 1, x: 0 },
    // Even easing, so the slide back stays visible as they fade.
    exit: {
      ...behind,
      transition: { duration: reduced ? 0 : 0.25, ease: "easeInOut" as const },
    },
    transition: { duration: reduced ? 0 : 0.22, ease: EASE_OUT },
  };
}

/** Only opted-in stacks pay for Motion's component and animation lifecycle. */
function EntranceItem(props: HTMLMotionProps<"span">) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      {...props}
      initial={reduced ? false : { scale: 0.9, rotate: -10 }}
      animate={{ scale: 1, rotate: 0 }}
      transition={
        reduced
          ? { duration: 0 }
          : {
              scale: { type: "spring", stiffness: 380, damping: 16 },
              rotate: { type: "spring", stiffness: 380, damping: 20 },
            }
      }
    />
  );
}
