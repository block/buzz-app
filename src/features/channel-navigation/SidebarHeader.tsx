import { useCallback, useState, useSyncExternalStore } from "react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import styles from "../../bundled/channels/Channels.module.css";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import type {
  RegisteredSidebarHeader,
  SidebarHeader as SidebarHeaderRegistry,
} from "./sidebar-header-service";
import { SidebarContributionRows } from "./SidebarContributionSection";

const noRows = [] as const;
const noSubscription = () => () => {};

/** The first active plugin header, in plugin-id/contribution-id order. A header
 * that fails renders nothing and leaves the sidebar usable. */
export function SidebarHeader({
  registry,
  navigator,
  target,
}: {
  registry: SidebarHeaderRegistry;
  navigator: Navigation;
  target: OpenTarget;
}) {
  const entry = useSyncExternalStore(
    registry.subscribe,
    () => [...registry.snapshot()].sort((a, b) => (a.key < b.key ? -1 : 1))[0],
  );
  if (!entry) return null;
  return (
    <OwnedContribution entry={entry} registry={registry} fallback={null}>
      {(header, active) => (
        <HeaderContents
          entry={header}
          active={active}
          navigator={navigator}
          target={target}
        />
      )}
    </OwnedContribution>
  );
}

function HeaderContents({
  entry,
  active,
  navigator,
  target,
}: {
  entry: RegisteredSidebarHeader;
  active: () => boolean;
  navigator: Navigation;
  target: OpenTarget;
}) {
  const rows = entry.rows;
  const snapshot = useCallback(() => rows?.snapshot() ?? noRows, [rows]);
  const subscribe = useCallback(
    (listener: () => void) => rows?.subscribe(listener) ?? noSubscription(),
    [rows],
  );
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [actionError, setActionError] = useState(false);
  const run = (action: () => unknown) => {
    if (!active()) return;
    setActionError(false);
    try {
      void Promise.resolve(action()).catch(() => setActionError(true));
    } catch {
      setActionError(true);
    }
  };
  return (
    <div className={styles.contributionHeader}>
      <div className={styles.contributionNavigationItem}>
        <NavigationItem
          label={entry.title}
          onClick={() => run(entry.onTitle)}
        />
      </div>
      {entry.select && (
        <SidebarContributionRows
          rows={current}
          select={entry.select}
          target={target}
          onSelect={(destination) => run(() => navigator.open(destination))}
        />
      )}
      {actionError && (
        <p className={styles.contributionFeedback} role="alert">
          This sidebar action couldn’t finish.
        </p>
      )}
    </div>
  );
}
