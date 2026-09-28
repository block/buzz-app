import type { Menu } from "@base-ui/react/menu";
import { useCallback, useRef, type ComponentProps, type Ref } from "react";

/** Menu, Popover and Dialog popups share this Base UI prop. */
type FinalFocus = ComponentProps<typeof Menu.Popup>["finalFocus"];
type CloseType = Parameters<
  Extract<FinalFocus, (...args: never) => unknown>
>[0];

/**
 * Keep an explicit `finalFocus` from pulling focus back after the user moved it.
 *
 * Base UI returns focus when a popup finishes closing. For the default `true`
 * it first checks whether focus already moved somewhere else, but an explicit
 * target skips that check. A user who pressed Escape and at once clicked
 * another menu button then lost that new menu: the old popup finished its
 * exit, focused its own trigger, and the new menu closed on focus loss.
 *
 * The popup element is kept after unmount so the check still works when Base
 * UI resolves focus after React clears the ref.
 */
export function useFinalFocusUnlessMoved(
  finalFocus: FinalFocus,
  ref: Ref<HTMLDivElement> | undefined,
) {
  const popup = useRef<HTMLDivElement | null>(null);
  const setPopup = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) popup.current = element;
      if (typeof ref === "function") return ref(element);
      if (ref) ref.current = element;
    },
    [ref],
  );
  const resolve = useCallback(
    (closeType: CloseType) => {
      const target =
        typeof finalFocus === "function"
          ? finalFocus(closeType)
          : typeof finalFocus === "object"
            ? finalFocus.current
            : finalFocus;
      const doc = popup.current?.ownerDocument ?? document;
      const active = doc.activeElement;
      const moved =
        active instanceof HTMLElement &&
        active !== doc.body &&
        active !== target &&
        !popup.current?.contains(active) &&
        !active.closest("[data-closed]");
      return moved ? false : target;
    },
    [finalFocus],
  );
  return {
    ref: setPopup,
    finalFocus:
      finalFocus === undefined || typeof finalFocus === "boolean"
        ? finalFocus
        : resolve,
  };
}
