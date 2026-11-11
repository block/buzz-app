import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { useSyncExternalStore } from "react";
import type { UnreadIndicator } from "../features/notifications/indicator";
import { Button } from "../shared/design-system/ui/Button";
import { usePermissionCheck } from "./usePermissionCheck";
import { Select } from "../shared/design-system/ui/Select";
import type { BadgeActivity } from "../features/notifications/preferences";

export function UnreadIndicatorSettings({
  indicator,
  badgeActivity,
  onBadgeActivityChange,
  active = true,
}: {
  indicator: UnreadIndicator;
  badgeActivity: BadgeActivity;
  onBadgeActivityChange(activity: BadgeActivity): void;
  active?: boolean;
}) {
  const state = useSyncExternalStore(indicator.subscribe, indicator.snapshot);
  const [checking, checkPermission] = usePermissionCheck(indicator.refresh);
  if (!indicator.available) return null;
  return (
    <div className="space-y-3">
      <InlineHeader title="Dock unread badge" />
      <SettingsGroup>
        <Select
          label="Badge activity"
          variant="preference"
          value={badgeActivity}
          groups={[
            {
              label: "",
              options: [
                { value: "all", label: "All unread activity" },
                {
                  value: "mentions-and-dms",
                  label: "Mentions and direct messages",
                },
              ],
            },
          ]}
          onValueChange={(value) =>
            onBadgeActivityChange(value as BadgeActivity)
          }
        />
      </SettingsGroup>
      <SettingsGroup layout="form">
        <p className="text-body-sm text-subtle">
          {state.permission === "unavailable"
            ? "Dock badges require a bundled macOS app and aren’t available from the development server."
            : "Shows a dot for unread activity in the selected community. It doesn’t show a message count."}
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
          <div className="flex flex-wrap gap-2">
            {(state.permission === "default" ||
              state.permission === "setup") && (
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
              loading={checking}
              onClick={checkPermission}
            >
              Check Dock permission
            </Button>
          </div>
        )}
      </SettingsGroup>
      {active && state.error && (
        <ToastNotice title="Dock badge unavailable" description={state.error} />
      )}
    </div>
  );
}
