import type { ReactNode } from "react";
import { Avatar } from "./Avatar";

/** Compact artwork for a workspace title; conversation portraits keep their own size. */
export function HeaderIcon({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-6 shrink-0" aria-hidden="true">
      <Avatar
        size="fill"
        shape="circle"
        alt=""
        fallback=""
        fallbackContent={children}
      />
    </span>
  );
}
