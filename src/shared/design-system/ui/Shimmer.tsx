import type { ComponentPropsWithoutRef } from "react";

/** A visual working signal. The caller owns status semantics and freshness. */
export function Shimmer({
  active = true,
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & { active?: boolean }) {
  return (
    <span
      {...props}
      data-buzz-ui=""
      data-active={active || undefined}
      className={["buzz-shimmer", className].filter(Boolean).join(" ")}
    />
  );
}
