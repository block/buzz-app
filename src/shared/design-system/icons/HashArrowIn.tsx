import { forwardRef } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** Existing Buzz Send to channel artwork, retained at the designer's request. */
export const HashArrowInArtwork = forwardRef<SVGSVGElement, IconProps>(
  function HashArrowInArtwork({ size = "1em", ...props }, ref) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        <path d="M4 9h16M4 15h7M10 3 8 21M16 3l-1 9M21 18h-7m3-3-3 3 3 3" />
      </svg>
    );
  },
);
