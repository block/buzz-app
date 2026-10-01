import { Children, type ReactNode } from "react";
import type { VirtualizerProps } from "virtua";

/** jsdom has no layout: mount every item. */
export function Virtualizer({ children }: VirtualizerProps) {
  return (
    <ol>
      {Children.map(children as ReactNode, (child) => (
        <li>{child}</li>
      ))}
    </ol>
  );
}
