import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { Updates } from "./updates";

/** Offers restart once a downloaded update is ready, except while Settings shows it inline; dismissal lasts until it resolves. */
export function UpdateNotice({ updates }: { updates: Updates }) {
  const { state } = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  const inline = useSyncExternalStore(
    updates.subscribe,
    updates.inlineVisible,
    updates.inlineVisible,
  );
  const [dismissed, setDismissed] = useState(false);
  const visible = state === "ready" || state === "installing";
  useEffect(() => {
    if (!visible) setDismissed(false);
  }, [visible]);
  if (!visible || dismissed || inline) return null;
  const pending = state === "installing";
  return (
    <ToastNotice
      title="Ready to update!"
      description={pending ? "Updating" : "Click to update"}
      tone="info"
      onDismiss={() => setDismissed(true)}
      closeLabel="Dismiss update notification"
    >
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={() => void updates.installAndRelaunch()}
      >
        Update now
      </Button>
    </ToastNotice>
  );
}
