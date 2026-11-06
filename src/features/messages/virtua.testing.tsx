import {
  Children,
  createElement,
  type ElementType,
  type ReactNode,
} from "react";
import type { VirtualizerProps } from "virtua";

/** jsdom has no layout: mount every item, in the container and item types the
 * owner chose. */
export function Virtualizer({
  children,
  as = "div",
  item = "div",
  keepMounted,
}: VirtualizerProps) {
  const Item = item as ElementType;
  return createElement(
    as as ElementType,
    // What a real Virtualizer would keep mounted away from its viewport.
    { "data-keep-mounted": keepMounted?.join(",") },
    Children.map(children as ReactNode, (child, index) =>
      typeof item === "string"
        ? createElement(Item, {}, child)
        : createElement(Item, { index, style: {} }, child),
    ),
  );
}
