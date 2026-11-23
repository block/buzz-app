import { forwardRef } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** Tabler's MessageCircle with the latitude and longitude lines of its World
 * icon inside: a conversation anyone can read. */
export const ChatGlobeArtwork = forwardRef<SVGSVGElement, IconProps>(
  function ChatGlobeArtwork({ size = "1em", ...props }, ref) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        <path d="M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1" />
        <path d="M3.6 9.1h16.8" />
        <path d="M3.7 14.7h16.6" />
        <path d="M11.5 4a15 15 0 0 0 0 15.8" />
        <path d="M12.5 4a15 15 0 0 1 0 15.8" />
      </svg>
    );
  },
);
