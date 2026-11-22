import {
  Children,
  createElement,
  isValidElement,
  type ElementType,
  type ReactNode,
} from "react";
import type { VirtualizerProps } from "virtua";

/** The items a test's viewport holds beyond those kept mounted: all by default. */
export const viewport = { holds: (_index: number) => true };

const itemKey = (child: ReactNode, index: number) =>
  (isValidElement(child) && child.key) || index;

/** jsdom has no layout: mount the items the viewport holds, in the container
 * and item types the owner chose. */
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
    Children.toArray(children as ReactNode).flatMap((child, index) =>
      viewport.holds(index) || keepMounted?.includes(index)
        ? [
            typeof item === "string"
              ? createElement(Item, { key: itemKey(child, index) }, child)
              : createElement(
                  Item,
                  { key: itemKey(child, index), index, style: {} },
                  child,
                ),
          ]
        : [],
    ),
  );
}
