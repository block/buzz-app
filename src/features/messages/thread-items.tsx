import {
  cloneElement,
  useMemo,
  type CSSProperties,
  type ReactElement,
  type Ref,
} from "react";
import type { CustomItemComponentProps } from "virtua";

type ItemElement = ReactElement<{
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
}>;

/** Virtua's item for a top-level reply: the reply's own list item, which Virtua
 * places and measures. Its class, data attributes and ref stay the reply's. */
export function ThreadItem({ children, style, ref }: CustomItemComponentProps) {
  const item = children as ItemElement;
  const own = item.props.ref;
  // One ref per pair: a new callback each render would detach and attach the
  // reply's own ref on every render.
  const merged = useMemo(() => mergeRefs(ref, own), [ref, own]);
  return cloneElement(item, {
    style: { ...item.props.style, ...style },
    ref: merged,
  });
}
function assign(ref: unknown, node: HTMLElement | null) {
  if (typeof ref === "function") return ref(node) as unknown;
  if (ref && typeof ref === "object")
    (ref as { current: HTMLElement | null }).current = node;
}
function mergeRefs(outer: unknown, inner: unknown) {
  return (node: HTMLElement | null) => {
    assign(outer, node);
    const cleanup = assign(inner, node);
    return () => {
      assign(outer, null);
      if (typeof cleanup === "function") cleanup();
      else assign(inner, null);
    };
  };
}

/**
 * The order to render before `next`. Virtua's `shift` holds the scroll position
 * from the list's end, so it is right only for a change at the start. A sliding
 * window can change both ends in one snapshot: an older page lands at the start
 * while a newer one is evicted at the end. Render the start's change first, with
 * `shift`, keeping the rest as it was; `next` then changes only the end.
 */
export function stageEdges(
  previous: readonly string[],
  next: readonly string[],
): { ids: readonly string[]; shift: boolean } {
  const present = new Set(next);
  const first = previous.findIndex((id) => present.has(id));
  const at = first < 0 ? -1 : next.indexOf(previous[first] ?? "");
  // Nothing kept (a new window), or nothing changed at the start.
  if (first < 0 || (first === 0 && at === 0))
    return { ids: next, shift: false };
  return {
    ids: [...next.slice(0, at), ...previous.slice(first)],
    shift: true,
  };
}
