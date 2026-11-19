import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ToastNotice,
  useToastNotification,
} from "../../shared/design-system/ui/Toast";
import type { UpdateStatus, Updates } from "./updates";

// A check already in flight resolves before its result; wait for that result.
const settled = (updates: Updates) =>
  new Promise<UpdateStatus>((resolve) => {
    const settle = () => {
      const status = updates.snapshot();
      if (status.state === "checking") return;
      unsubscribe();
      resolve(status);
    };
    const unsubscribe = updates.subscribe(settle);
    settle();
  });

/** macOS Buzz → Check for Updates… reports its result here, not in Settings. */
function useMenuCheck(updates: Updates) {
  const notify = useToastNotification();
  // Repeated clicks during one check report its result once.
  const pending = useRef(false);
  useEffect(() => {
    const check = async () => {
      if (pending.current) return;
      pending.current = true;
      try {
        await updates.checkForUpdate();
        const status = await settled(updates);
        // A clean result retires a recovery notice; the toast reports it instead.
        if (
          (status.state === "up-to-date" || status.state === "unavailable") &&
          updates.noticePinned()
        )
          updates.dismissNotice();
        // A found update, or a failure while recovering, shows in the notice below.
        if (updates.noticePinned()) return;
        if (status.state === "up-to-date")
          notify("You're on the latest version.", "success");
        else if (status.state === "unavailable")
          notify("Automatic updates aren't available on this build.", "info");
        else if (status.state === "error")
          notify(`Couldn't check for updates: ${status.message}`, "error");
        // The top-bar action carries a ready update; say so for the click.
        else if (status.state === "ready")
          notify("An update is ready. Restart Buzz to install.", "info");
      } finally {
        pending.current = false;
      }
    };
    const request = () => void check();
    window.addEventListener("buzz:check-for-updates", request);
    return () => window.removeEventListener("buzz:check-for-updates", request);
  }, [updates, notify]);
}

/**
 * Follows a requested download with its progress and keeps a failed install's
 * retry reachable outside Settings; the top-bar action offers ready updates.
 * Dismissal lasts until another request pins the notice again.
 */
export function UpdateNotice({ updates }: { updates: Updates }) {
  useMenuCheck(updates);
  const status = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  const inline = useSyncExternalStore(
    updates.subscribe,
    updates.inlineVisible,
    updates.inlineVisible,
  );
  const pinned = useSyncExternalStore(
    updates.subscribe,
    updates.noticePinned,
    updates.noticePinned,
  );
  if (!pinned || inline) return null;
  const { state } = status;
  const downloading = state === "available" || state === "downloading";
  const descriptions = {
    idle: "",
    ready: "",
    installing: "",
    checking: "Checking for updates...",
    available: "Preparing update...",
    downloading:
      status.state === "downloading"
        ? `Downloading Buzz ${status.version}…${status.progress === null ? "" : ` ${status.progress}%`}`
        : "",
    "up-to-date": "You're on the latest version.",
    unavailable:
      "Automatic updates aren't available on this build. Download the latest release manually.",
    error: "",
  };
  return (
    <ToastNotice
      title={
        state === "error"
          ? "Update failed"
          : downloading
            ? "Update available"
            : "Software Updates"
      }
      description={
        status.state === "error" ? status.message : descriptions[state]
      }
      tone={state === "error" ? "error" : "info"}
      onDismiss={updates.dismissNotice}
      closeLabel="Dismiss update notification"
    >
      {!downloading && (
        <Button
          type="button"
          size="sm"
          loading={state === "checking"}
          onClick={() => void updates.checkForUpdate()}
        >
          Retry
        </Button>
      )}
    </ToastNotice>
  );
}
