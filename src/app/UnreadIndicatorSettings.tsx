import { useSyncExternalStore } from "react";
import type { UnreadIndicator } from "../features/notifications/indicator";

export function UnreadIndicatorSettings({
  indicator,
}: {
  indicator: UnreadIndicator;
}) {
  const state = useSyncExternalStore(indicator.subscribe, indicator.snapshot);
  if (!indicator.available) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-label">Desktop unread indicator</h3>
      <p className="text-body-sm text-muted">
        A dot shows observed unread activity or a channel marked unread in the
        selected community. It is not a message count. Desktop alert choices do
        not change this indicator. The indicator appears in the Dock on macOS,
        the taskbar on Windows, and the system tray on supported Linux desktops.
      </p>
      {indicator.macOS && (
        <>
          <p role="status" className="text-body-sm text-muted">
            {state.requesting
              ? "Waiting for system permission…"
              : {
                  default:
                    "Allow notifications and badges to show the unread dot in the Dock.",
                  setup: "Set up Dock badges to show the unread dot.",
                  enabled: "Dock badges are allowed by macOS.",
                  disabled:
                    "Badges are off. Change the badge setting in macOS System Settings.",
                  denied:
                    "Notifications are blocked. Allow them in macOS System Settings.",
                  unavailable:
                    "Dock permission is unavailable. Run the bundled macOS app to use badges.",
                }[state.permission]}
          </p>
          <div className="flex gap-2">
            {(state.permission === "default" ||
              state.permission === "setup") && (
              <button
                type="button"
                disabled={state.requesting}
                onClick={() => void indicator.request()}
              >
                {state.permission === "setup"
                  ? "Set up Dock badges"
                  : "Allow notifications and badges"}
              </button>
            )}
            <button
              type="button"
              disabled={state.requesting}
              onClick={() => void indicator.refresh()}
            >
              Check Dock permission
            </button>
          </div>
        </>
      )}
      {state.error && (
        <div className="space-y-3">
          <p role="alert" className="notice">
            {state.error}
          </p>
          {!indicator.macOS && (
            <button type="button" onClick={() => void indicator.refresh()}>
              Retry unread indicator
            </button>
          )}
        </div>
      )}
    </div>
  );
}
