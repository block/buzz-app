import { useCallback, useLayoutEffect, useRef } from "react";

/** Only transfer focus when it belonged to the request being replaced. */
export function useHuddleRequestFocus(connected: boolean) {
  const request = useRef<HTMLElement | null>(null);
  const restore = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const mute = useRef<HTMLButtonElement>(null);
  const requestRef = useCallback((node: HTMLElement | null) => {
    if (!node && request.current?.contains(document.activeElement)) {
      restore.current = true;
      // Cancel/failure removes the request. Search survives it in the main app;
      // the native companion closes and returns focus to its owning window.
      document
        .querySelector<HTMLButtonElement>('[aria-label="Search Buzz"]')
        ?.focus({ preventScroll: true });
    }
    if (node) restore.current = false;
    request.current = node;
  }, []);
  useLayoutEffect(() => {
    if (connected && restore.current) {
      mute.current?.focus({ preventScroll: true });
      restore.current = false;
    }
  }, [connected]);
  return { requestRef, cancel, mute };
}
