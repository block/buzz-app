import { useEffect, useSyncExternalStore } from "react";
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
  useEffect(() => {
    const check = async () => {
      await updates.checkForUpdate();
      const status = await settled(updates);
      // A found update, or a result while recovering, shows in the notice below.
      if (updates.noticePinned()) return;
      if (status.state === "up-to-date")
        notify("You're on the latest version.", "success");
      else if (status.state === "unavailable")
        notify("Automatic updates aren't available on this build.", "info");
      else if (status.state === "error")
        notify(`Couldn't check for updates: ${status.message}`, "error");
    };
    const request = () => void check();
    window.addEventListener("buzz:check-for-updates", request);
    return () => window.removeEventListener("buzz:check-for-updates", request);
  }, [updates, notify]);
}

/**
 * Offers restart once a downloaded update is ready, and follows a requested
 * download with its progress, except while Settings shows it inline; dismissal
 * lasts until it resolves.
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
  const dismissed = useSyncExternalStore(
    updates.subscribe,
    updates.noticeDismissed,
    updates.noticeDismissed,
  );
  const pinned = useSyncExternalStore(
    updates.subscribe,
    updates.noticePinned,
    updates.noticePinned,
  );
  const { state } = status;
  const visible = state === "ready" || state === "installing" || pinned;
  if (!visible || dismissed || inline) return null;
  const pending = [
    "checking",
    "available",
    "downloading",
    "installing",
  ].includes(state);
  const descriptions = {
    idle: "Click to update",
    ready: "Click to update",
    installing: "Updating",
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
          : state === "available" || state === "downloading"
            ? "Update available"
            : pinned
              ? "Software Updates"
              : "Ready to update!"
      }
      description={
        status.state === "error" ? status.message : descriptions[state]
      }
      tone={state === "error" ? "error" : "info"}
      onDismiss={updates.dismissNotice}
      closeLabel="Dismiss update notification"
    >
      <Button
        type="button"
        size="sm"
        loading={pending}
        onClick={() =>
          void (state === "ready"
            ? updates.installAndRelaunch()
            : updates.checkForUpdate())
        }
      >
        {["available", "downloading", "ready", "installing"].includes(state)
          ? "Update now"
          : "Retry"}
      </Button>
    </ToastNotice>
  );
}
