// Real settings and unread state; browser Dock output is simulated, native output is not.
import { createRoot } from "react-dom/client";
import { useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "../../src/shared/design-system/ui/Button";
import { badgeActivityFixture } from "./notification-badges-activity";
import { UnreadIndicatorSettings } from "../../src/app/UnreadIndicatorSettings";
import { createNotificationPreferences } from "../../src/features/notifications/preferences";
import { createUnreadIndicator } from "../../src/features/notifications/indicator";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { Header } from "../../src/shared/design-system/ui/Header";
import styles from "../../src/app/Settings.module.css";
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";

const preferences = createNotificationPreferences();
preferences.selectViewer("ab".repeat(32));
const indicator = isTauri()
  ? createUnreadIndicator()
  : createUnreadIndicator({
      permission: async () => "enabled",
      set: async () => {},
    });
const activity = badgeActivityFixture(indicator, preferences);
window.addEventListener(
  "pagehide",
  () => {
    activity.dispose();
    void indicator.dispose();
    preferences.dispose();
  },
  { once: true },
);

function Fixture() {
  const projected = useSyncExternalStore(activity.subscribe, activity.snapshot);
  const [result, setResult] = useState("All example messages are read.");
  const { preferences: value } = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
  );
  return (
    <ToastProvider>
      <main className={`${styles.detail} buzz-settings-page`}>
        <div>
          <Header title="Notifications" />
          <UnreadIndicatorSettings
            indicator={indicator}
            badgeActivity={value.badgeActivity}
            onBadgeActivityChange={(badgeActivity) =>
              preferences.update({ badgeActivity })
            }
          />
          <section
            aria-label="Local badge validation"
            className="space-y-3 mt-6"
          >
            <p className="text-body-sm text-subtle">
              Synthetic messages ·{" "}
              {isTauri()
                ? "Native macOS Dock"
                : "Browser only; Dock output simulated"}
            </p>
            <div className="flex flex-wrap gap-2">
              {(["ordinary", "mention", "dm"] as const).map((kind) => (
                <Button
                  key={kind}
                  onClick={() => {
                    activity.receive(kind);
                    setResult(`Received an example ${kind}.`);
                  }}
                >
                  Receive {kind === "dm" ? "DM" : kind}
                </Button>
              ))}
              <Button
                onClick={() =>
                  void activity
                    .readMention()
                    .then(() => setResult("Read one example mention."))
                }
              >
                Read one mention
              </Button>
              <Button
                onClick={() =>
                  void activity
                    .readAll()
                    .then(() => setResult("All example messages are read."))
                }
              >
                Mark all read
              </Button>
            </div>
            <p role="status" className="text-body-sm">
              {result}
            </p>
            <p className="text-body-sm">
              Badge projection: <strong>{projected}</strong>
            </p>
          </section>
        </div>
      </main>
    </ToastProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
