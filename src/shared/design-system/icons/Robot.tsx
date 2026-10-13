import { forwardRef } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** Designer-approved Soft & wide agent mark, drawn on Tabler's 24-unit canvas. */
export const RobotArtwork = forwardRef<SVGSVGElement, IconProps>(
  function RobotArtwork(
    { size = "1em", color = "currentColor", title, ...props },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        color={color}
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {title && <title>{title}</title>}
        <rect x="5.75" y="8" width="12.5" height="11.5" rx="4" />
        <path d="M12 8V4M2.5 12v3.5M21.5 12v3.5" />
        <g fill="currentColor" stroke="none">
          <circle cx="9.5" cy="13.25" r="1.25" />
          <circle cx="14.5" cy="13.25" r="1.25" />
        </g>
      </svg>
    );
  },
);
