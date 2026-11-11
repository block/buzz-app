// Real settings and account-local preferences; only the native Dock boundary is synthetic.
import { createRoot } from "react-dom/client";
import { useSyncExternalStore } from "react";
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
const indicator = createUnreadIndicator({
  permission: async () => "enabled",
  set: async () => {},
});

function Fixture() {
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
        </div>
      </main>
    </ToastProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
