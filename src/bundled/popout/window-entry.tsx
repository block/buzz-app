import { AgentAvatarArtworkProvider } from "../../features/agents/AgentAvatarArtworkProvider";
import "../../shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { TooltipProvider } from "../../shared/design-system/ui/Tooltip";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { PopoutAction, PopoutView } from "../../features/popout/window";
import { PopoutWindowView } from "./PopoutWindowView";
import { applyDocumentAppearance } from "../../shared/theme/document-appearance";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";

/** A remote view of one thread. Main owns the session; this window only asks. */
function Companion() {
  useKeyboardFocusVisibility();
  const [view, setView] = useState<PopoutView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let mounted = true;
    const updates = new Channel<PopoutView>();
    updates.onmessage = (next) => {
      if (!mounted) return;
      applyDocumentAppearance(
        next.appearance ?? { colorMode: next.dark ? "dark" : "light" },
      );
      setView(next);
    };
    void invoke("popout_window_watch", { updates }).catch(() => {
      if (mounted)
        setError("This window is no longer connected. Reopen it from Buzz.");
    });
    return () => {
      mounted = false;
    };
  }, []);
  const act = useCallback((action: PopoutAction, text?: string) => {
    setError(undefined);
    void invoke("popout_window_action", { action, text }).catch((cause) =>
      setError(
        typeof cause === "string" && cause
          ? cause
          : "Couldn’t reach Buzz. Try again from the main window.",
      ),
    );
  }, []);
  return view ? (
    <ToastProvider>
      <PopoutWindowView view={view} act={act} error={error} />
    </ToastProvider>
  ) : error ? (
    <p role="alert" className="p-6 text-body text-secondary">
      {error}
    </p>
  ) : null;
}
const container = document.getElementById("root");
if (container) {
  // The window is the viewport: only the message list scrolls. Without this
  // a transient overflow (a tall composer, a notice) scrolls the document and
  // leaves the header off-screen above an empty page.
  for (const element of [document.documentElement, document.body]) {
    element.style.height = "100%";
    element.style.overflow = "hidden";
  }
  container.style.height = "100dvh";
  container.style.overflow = "hidden";
  createRoot(container).render(
    <AgentAvatarArtworkProvider>
      <TooltipProvider>
        <Companion />
      </TooltipProvider>
    </AgentAvatarArtworkProvider>,
  );
}
