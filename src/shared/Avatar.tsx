import { Avatar as SharedAvatar } from "./design-system/ui/Avatar";

/** Compatibility for newer feature callers; the design system owns rendering. */
export function Avatar({
  name,
  src,
  className = "",
  shape = "circle",
}: {
  name: string;
  src?: string | undefined;
  className?: string;
  shape?: "circle" | "squircle";
}) {
  return (
    <span className={`relative inline-grid shrink-0 ${className}`}>
      <SharedAvatar
        src={src}
        alt=""
        fallback={name}
        size="fill"
        shape={shape}
      />
    </span>
  );
}
