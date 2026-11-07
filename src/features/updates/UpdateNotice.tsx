import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { Updates } from "./updates";

/** Offers restart once a downloaded update is ready, now or once agents are idle, except while Settings shows it inline; dismissal lasts until it resolves. */
export function UpdateNotice({ updates }: { updates: Updates }) {
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
  const recovery = useSyncExternalStore(
    updates.subscribe,
    updates.noticeRecovery,
    updates.noticeRecovery,
  );
  const working = useSyncExternalStore(
    updates.subscribe,
    updates.workingCount,
    updates.workingCount,
  );
  const { state } = status;
  const visible =
    state === "ready" ||
    state === "scheduled" ||
    state === "installing" ||
    recovery;
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
    scheduled: "Buzz restarts once agents finish their work.",
    installing: "Updating",
    checking: "Checking for updates...",
    available: "Preparing update...",
    downloading: "Downloading update...",
    "up-to-date": "You're on the latest version.",
    unavailable:
      "Automatic updates aren't available on this build. Download the latest release manually.",
    error: "",
  };
  const offerIdle = state === "ready" && updates.idleOptionAvailable();
  const description =
    status.state === "error"
      ? status.message
      : state === "ready" && working > 0
        ? workingDescription(working)
        : state === "scheduled" && working > 0
          ? `${descriptions.scheduled} ${working} working now.`
          : descriptions[state];
  return (
    <ToastNotice
      title={
        state === "error"
          ? "Update failed"
          : recovery
            ? "Software Updates"
            : state === "scheduled"
              ? "Update scheduled"
              : "Ready to update!"
      }
      description={description}
      tone={state === "error" ? "error" : "info"}
      onDismiss={updates.dismissNotice}
      closeLabel="Dismiss update notification"
    >
      <Button
        type="button"
        size="sm"
        variant={offerIdle && working === 0 ? "prominent" : "subtle"}
        loading={pending}
        onClick={() =>
          void (state === "ready" || state === "scheduled"
            ? updates.installAndRelaunch()
            : updates.checkForUpdate())
        }
      >
        {state === "ready" || state === "scheduled" || state === "installing"
          ? "Update now"
          : "Retry"}
      </Button>
      {/* One button for both, so focus stays on it as the schedule changes. */}
      {(offerIdle || state === "scheduled") && (
        <Button
          type="button"
          size="sm"
          variant={offerIdle && working > 0 ? "prominent" : "subtle"}
          onClick={
            state === "scheduled"
              ? updates.cancelScheduled
              : updates.installWhenIdle
          }
        >
          {state === "scheduled" ? "Cancel" : "Update when agents are idle"}
        </Button>
      )}
    </ToastNotice>
  );
}

const workingDescription = (count: number) =>
  count === 1
    ? "1 agent is working. Updating now interrupts it."
    : `${count} agents are working. Updating now interrupts them.`;
