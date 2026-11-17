import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";

/**
 * The native Close All Tabs command, owned by the page that owns the tab
 * state. It acts only while that page's workspace is on screen and no modal
 * surface is open, and claims the command only when something closed.
 */
export function useCloseAllTabsCommand(
  workspace: () => Element | null | undefined,
  closeAll: () => boolean,
) {
  const latest = useRef({ workspace, closeAll });
  latest.current = { workspace, closeAll };
  useLayoutEffect(() => {
    const close = (event: Event) => {
      const element = latest.current.workspace();
      if (
        event.defaultPrevented ||
        !element?.isConnected ||
        element.closest('[hidden], [inert], [aria-hidden="true"]') ||
        !element.getClientRects().length ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      )
        return;
      flushSync(() => {
        if (latest.current.closeAll()) event.preventDefault();
      });
    };
    window.addEventListener("buzz:close-all-tabs", close);
    return () => window.removeEventListener("buzz:close-all-tabs", close);
  }, []);
}
