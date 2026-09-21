import { useSyncExternalStore } from "react";
import type { DockBadge } from "../features/notifications/dock";

export function DockSettings({ dock }: { dock: DockBadge }) {
  const state = useSyncExternalStore(dock.subscribe, dock.snapshot);
  if (!dock.available) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-label">Dock unread indicator</h3>
      <p className="text-body-sm text-muted">
        A dot shows observed unread activity or a channel marked unread in the
        selected community. It is not a message count. Desktop alert choices do
        not change this indicator.
      </p>
      <p role="status" className="text-body-sm text-muted">
        {state.requesting
          ? "Waiting for system permission…"
          : {
              default: "Allow notifications to enable the Dock indicator.",
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
        {state.permission === "default" && (
          <button
            type="button"
            disabled={state.requesting}
            onClick={() => void dock.request()}
          >
            Allow notifications and badges
          </button>
        )}
        <button
          type="button"
          disabled={state.requesting}
          onClick={() => void dock.refresh()}
        >
          Check Dock permission
        </button>
      </div>
      {state.error && (
        <p role="alert" className="notice">
          {state.error}
        </p>
      )}
    </div>
  );
}
