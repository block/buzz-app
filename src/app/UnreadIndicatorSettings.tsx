import { ToastNotice } from "../shared/design-system/ui/Toast";
import { useSyncExternalStore } from "react";
import type { UnreadIndicator } from "../features/notifications/indicator";
import { Button } from "../shared/design-system/ui/Button";

export function UnreadIndicatorSettings({
  indicator,
  active = true,
}: {
  indicator: UnreadIndicator;
  active?: boolean;
}) {
  const state = useSyncExternalStore(indicator.subscribe, indicator.snapshot);
  if (!indicator.available) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-label">Show unread badge in Dock</h3>
      <p className="text-body-sm text-muted">
        {state.permission === "unavailable"
          ? "Dock badges aren’t available while running Buzz from the development server. Open a bundled macOS app to use them."
          : "Show a dot in the macOS Dock for unread activity in the selected community. The dot doesn’t show a message count and works independently from desktop alerts."}
      </p>
      {state.permission !== "unavailable" && (
        <p role="status" className="text-body-sm text-muted">
          {state.requesting
            ? "Waiting for system permission…"
            : {
                default:
                  "Allow notifications and badges to show the unread dot.",
                setup: "Set up Dock badges to show the unread dot.",
                enabled: "Buzz can show Dock badges.",
                disabled:
                  "Dock badges are off. Turn them on in macOS System Settings.",
                denied:
                  "Notifications are off. Turn them on in macOS System Settings.",
              }[state.permission]}
        </p>
      )}
      {state.permission !== "unavailable" && (
        <div className="flex gap-2">
          {(state.permission === "default" || state.permission === "setup") && (
            <Button
              type="button"
              disabled={state.requesting}
              onClick={() => void indicator.request()}
            >
              {state.permission === "setup"
                ? "Set up Dock badges"
                : "Allow notifications and badges"}
            </Button>
          )}
          <Button
            type="button"
            disabled={state.requesting}
            onClick={() => void indicator.refresh()}
          >
            Check Dock permission
          </Button>
        </div>
      )}
      {active && state.error && (
        <ToastNotice title="Dock badge unavailable" description={state.error} />
      )}
    </div>
  );
}
