import { forwardRef, useId } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** The existing public/buzz-mark.svg, inheriting the surrounding icon color. */
export const BuzzArtwork = forwardRef<SVGSVGElement, IconProps>(
  function BuzzArtwork({ size = "1em", ...props }, ref) {
    const cutouts = useId();
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 64 48"
        aria-hidden="true"
        {...props}
      >
        <mask id={cutouts}>
          <rect width="64" height="48" fill="white" />
          <circle cx="25" cy="14" r="4" fill="black" />
          <circle cx="39" cy="14" r="4" fill="black" />
          <rect x="23" y="24" width="18" height="5" fill="black" />
          <rect x="23" y="35" width="18" height="5" fill="black" />
        </mask>
        <path
          d="M18 9a8 8 0 0 1 8-8h12a8 8 0 0 1 8 8v3h4a12 12 0 1 1 0 24h-4v3a8 8 0 0 1-8 8H26a8 8 0 0 1-8-8v-3h-4a12 12 0 1 1 0-24h4V9Z"
          fill="currentColor"
          mask={`url(#${cutouts})`}
        />
      </svg>
    );
  },
);
