import { Avatar } from "./Avatar";
import styles from "./AvatarStack.module.css";

type StackAvatar = {
  id: string;
  name: string;
  src?: string | undefined;
  shape: "circle" | "squircle";
};

/** Compact identity artwork. The enclosing control supplies its accessible name. */
export function AvatarStack({
  items,
  size = "compact",
  max = 3,
}: {
  items: readonly StackAvatar[];
  size?: "compact" | "small" | "mini" | "large";
  /** How many avatars show before the overflow count. */
  max?: number;
}) {
  if (!items.length) return null;
  return (
    <span
      className={`${styles.root} text-caption`}
      aria-hidden="true"
      data-avatar-stack=""
      data-size={size}
    >
      {items.slice(0, max).map((item, index) => (
        <span
          key={item.id}
          className={styles.item}
          // Each overlaps the one before it.
          style={{ zIndex: index + 1 }}
          data-avatar-shape={item.shape}
          title={item.name}
        >
          <Avatar
            src={item.src}
            alt=""
            fallback={item.name}
            fallbackContent={
              size === "mini" ? (
                <span className={`${styles.miniInitial} text-caption`}>
                  {Array.from(item.name.trim())[0]?.toUpperCase() || "?"}
                </span>
              ) : undefined
            }
            shape={item.shape}
            size="fill"
          />
        </span>
      ))}
      {items.length > max && (
        <span
          className={`${styles.count}${size === "large" ? " text-label" : ""}`}
        >
          +{items.length - max}
        </span>
      )}
    </span>
  );
}
