import { mergeProps } from "@base-ui/react/merge-props";
import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
  type RefObject,
  type FocusEvent,
  type SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";

type ElementProps = Record<string, unknown>;
type Handler = (event: SyntheticEvent) => void;
type RefCallback = (element: HTMLElement | null) => (() => void) | undefined;

// Base UI's focus hook on macOS WebKit shows a popup for a focus without a
// related target only if no pointerdown followed the last keydown since the
// hook mounted. Count those inputs once, so that a root mounted by such a
// focus decides as one mounted with its trigger would have.
const macWebKit =
  typeof navigator !== "undefined" &&
  navigator.platform.toLowerCase().startsWith("mac") &&
  (navigator.maxTouchPoints ?? 0) <= 1 &&
  typeof CSS !== "undefined" &&
  !!CSS.supports?.("-webkit-backdrop-filter:none");
const typeable =
  "input:not([type='hidden']):not([disabled]),[contenteditable]:not([contenteditable='false']),textarea:not([disabled])";
const input = { count: 0, pointer: false, tracking: false };
function countInputs() {
  if (input.tracking || !macWebKit) return input.count;
  input.tracking = true;
  const count = (pointer: boolean) => () => {
    input.count++;
    input.pointer = pointer;
  };
  window.addEventListener("keydown", count(false), true);
  window.addEventListener("pointerdown", count(true), true);
  return input.count;
}

/** Whether Base UI, mounted with the trigger, would ignore this focus. */
function ignoredFocus(event: SyntheticEvent, mountedAt: number) {
  return (
    macWebKit &&
    event.type === "focus" &&
    !(event as FocusEvent<Element>).relatedTarget &&
    input.count !== mountedAt &&
    input.pointer &&
    !(event.target instanceof Element && event.target.matches(typeable))
  );
}

/**
 * Most hint, preview and menu triggers are never used, yet a Base UI root and
 * trigger build a store, floating interaction hooks and context providers when
 * they mount. A deferred trigger renders its element with the closed
 * trigger's attributes until the first pointer, focus or press reaches it.
 * That interaction mounts the root synchronously, inside the same input
 * event, and is then handed to Base UI as if it had always been mounted, so
 * a press can never land before the root does.
 *
 * Base UI's trigger renders into a relay instead of the element: the element
 * keeps its place in the tree and is never remounted, and the relay forwards
 * the trigger's ref, attributes and handlers to it.
 */
export function useDeferredTrigger({
  node,
  child,
  own,
  open,
  resting,
  activateOn,
}: {
  /** Receives the trigger element. */
  node: RefObject<HTMLElement | null>;
  /** The trigger element, rendered as Base UI's `render` element would be. */
  child: ReactElement;
  /** Props the component adds to the trigger, as Base UI element props. */
  own?: ElementProps | undefined;
  /** A controlled open needs the root even without an interaction. */
  open: boolean | undefined;
  /** The attributes Base UI's closed trigger renders. */
  resting: ElementProps;
  /** The interactions that need Base UI, such as `onPointerEnter`. */
  activateOn: readonly string[];
}) {
  const [live, setLive] = useState(false);
  const [mountedAt] = useState(countInputs);
  if (open && !live) setLive(true);
  const liveRef = useRef(live);
  liveRef.current = live;
  const latest = useRef<ElementProps>({});
  const attached = useRef<{
    ref?: RefCallback | undefined;
    cleanup?: undefined | (() => void);
  }>({});
  const [applied, setApplied] = useState<{
    attributes: ElementProps;
    handlers: string[];
  }>({ attributes: {}, handlers: [] });
  const delegates = useRef(new Map<string, Handler>());
  const focused = useRef<{
    name: string;
    event: SyntheticEvent;
    currentTarget: EventTarget & Element;
  }>(undefined);

  const deliver = useCallback(
    (props: ElementProps | null) => {
      const { ref, ...rest } = props ?? {};
      latest.current = rest;
      if (ref !== attached.current.ref) {
        const previous = attached.current;
        if (previous.cleanup) previous.cleanup();
        else previous.ref?.(null);
        const next = ref as RefCallback | undefined;
        attached.current = {
          ref: next,
          cleanup: next?.(node.current) ?? undefined,
        };
      }
      const attributes: ElementProps = {};
      const handlers: string[] = [];
      for (const [name, value] of Object.entries(rest)) {
        if (typeof value === "function") handlers.push(name);
        else if (value !== undefined) attributes[name] = value;
      }
      setApplied((current) =>
        sameEntries(current.attributes, attributes) &&
        current.handlers.join() === handlers.join()
          ? current
          : { attributes, handlers },
      );
    },
    [node],
  );

  const relay = useCallback(
    (props: object) => (
      <TriggerRelay props={props as ElementProps} deliver={deliver} />
    ),
    [deliver],
  );

  const childProps = child.props as ElementProps;
  const childRef = childProps.ref as Ref<HTMLElement> | undefined;
  const ref = useCallback(
    (element: HTMLElement | null) => {
      node.current = element;
      const cleanup =
        typeof childRef === "function" ? childRef(element) : undefined;
      if (childRef && typeof childRef === "object") childRef.current = element;
      return () => {
        node.current = null;
        if (typeof cleanup === "function") cleanup();
        else if (typeof childRef === "function") childRef(null);
        else if (childRef) childRef.current = null;
      };
    },
    [childRef, node],
  );

  // Runs after Base UI's own effects, as a flushed mount would have.
  useEffect(() => {
    const pending = focused.current;
    focused.current = undefined;
    if (!live || !pending) return;
    const { name, event, currentTarget } = pending;
    // React clears the target it dispatched to once dispatch ends.
    event.currentTarget = currentTarget;
    (latest.current[name] as Handler | undefined)?.(event);
  }, [live]);

  const props: ElementProps = live ? { ...applied.attributes } : { ...resting };
  for (const name of live ? applied.handlers : activateOn) {
    let handler = delegates.current.get(name);
    if (!handler) {
      handler = (event) => {
        if (!liveRef.current) {
          // A script may focus the trigger while handling another event, and
          // flushing there would commit that handler's updates before it
          // finishes. Focus cannot race a press, so it mounts the root with
          // those updates and reaches Base UI once the root has mounted.
          if (event.type === "focus") {
            const pending = { name, event, currentTarget: event.currentTarget };
            focused.current = ignoredFocus(event, mountedAt)
              ? undefined
              : pending;
            // Focus that leaves before the root mounts never reaches it.
            pending.currentTarget.addEventListener(
              "focusout",
              () => {
                if (focused.current === pending) focused.current = undefined;
              },
              { once: true },
            );
            setLive(true);
            return;
          }
          flushSync(() => setLive(true));
          // Base UI hears mouseenter natively. Input always reaches the
          // element with pointer events first, but a mouse-only sequence
          // may already have dispatched mouseenter before React's mouseover.
          if (event.type === "mouseenter") {
            const { clientX, clientY, relatedTarget } =
              event.nativeEvent as MouseEvent;
            node.current?.dispatchEvent(
              new MouseEvent("mouseenter", {
                clientX,
                clientY,
                relatedTarget,
              }),
            );
          }
        }
        (latest.current[name] as Handler | undefined)?.(event);
      };
      delegates.current.set(name, handler);
    }
    props[name] = handler;
  }
  const merged = mergeProps(
    props,
    own ? mergeProps(own, childProps) : childProps,
  ) as ElementProps;
  merged.ref = ref;

  return {
    live,
    /** Pass as Base UI trigger's `render` prop. */
    relay,
    element: cloneElement(child, merged),
  };
}

function TriggerRelay({
  props,
  deliver,
}: {
  props: ElementProps;
  deliver(props: ElementProps | null): void;
}) {
  useLayoutEffect(() => deliver(props));
  useLayoutEffect(() => () => deliver(null), [deliver]);
  return null;
}

function sameEntries(a: ElementProps, b: ElementProps) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is(a[key], b[key]))
  );
}
