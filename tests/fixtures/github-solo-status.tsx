import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";
import {
  SessionPullRow,
  SoloPullIcon,
} from "../../src/bundled/github/SoloPull";
import type { SoloPull, SoloPulls } from "../../src/bundled/github/solo-pull";
import { approvedPull } from "../../src/bundled/github/solo-pull.fixtures";
import { ChatActionsMenu } from "../../src/bundled/channels/SoloWorkspaces";
import styles from "../../src/bundled/channels/SoloWorkspaces.module.css";
import { NavigationItem } from "../../src/shared/design-system/ui/NavigationItem";
import { MenuItem } from "../../src/shared/design-system/ui/Menu";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";

// Real native row/menu owners with synthetic GitHub state. The app journey
// separately covers contribution registration and persisted link loading.
let pull: SoloPull = approvedPull();
const listeners = new Set<() => void>();
const pulls: SoloPulls = {
  watch: (_channel, listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: () => pull,
  linked: () => {},
};
function Fixture() {
  useKeyboardFocusVisibility();
  const [selected, select] = useState(false);
  return (
    <main style={{ padding: 16 }}>
      <div
        className={styles.sidebarContents}
        style={{ width: "min(100%, 360px)" }}
      >
        <SessionPullRow pulls={pulls} channelId="sample">
          <ChatActionsMenu
            id="sample"
            title="Release notes"
            className={styles.organizedRow}
            content={<MenuItem>Rename</MenuItem>}
          >
            <NavigationItem
              data-solo-channel-id="sample"
              label="Keep the release notes easy to scan"
              selected={selected}
              onClick={() => select(true)}
              icon={
                <SoloPullIcon
                  pulls={pulls}
                  channelId="sample"
                  fallback={null}
                />
              }
            />
          </ChatActionsMenu>
        </SessionPullRow>
      </div>
      <Button
        onClick={() => {
          pull = { ...approvedPull(), failed: true };
          for (const listener of listeners) listener();
        }}
      >
        Simulate failed read
      </Button>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(<Fixture />);
