import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import type { Updates } from "./updates";

export function UpdateSettings({ updates }: { updates: Updates }) {
  const status = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  const check = () => void updates.checkForUpdate();
  const row = (message: ReactNode, action?: ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <p role="status" className="m-0 min-w-0 text-body-sm text-subtle">
        {message}
      </p>
      {action}
    </div>
  );
  const button = (label: string, onClick: () => void) => (
    <Button type="button" size="sm" onClick={onClick}>
      {label}
    </Button>
  );
  return (
    <section aria-labelledby="update-settings-title">
      <Header
        id="update-settings-title"
        title="Software Updates"
        subtitle="Keep Buzz up to date with the latest features and fixes."
      />
      {status.state === "idle" &&
        row(
          "Check if a new version is available.",
          button("Check for Updates", check),
        )}
      {status.state === "checking" && row("Checking for updates...")}
      {status.state === "up-to-date" &&
        row("You're on the latest version.", button("Check Again", check))}
      {status.state === "unavailable" &&
        row(
          "Automatic updates aren't available on this build. Download the latest release manually.",
          button("Check Again", check),
        )}
      {status.state === "available" && row("Preparing update...")}
      {status.state === "downloading" && row("Downloading update...")}
      {status.state === "installing" && row("Installing update...")}
      {status.state === "ready" &&
        row(
          "Update downloaded. Click to apply.",
          button("Update Now", () => void updates.installAndRelaunch()),
        )}
      {status.state === "error" &&
        row(
          <span className="error">Update failed: {status.message}</span>,
          button("Retry", check),
        )}
    </section>
  );
}
