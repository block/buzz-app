import { useRef, useState } from "react";
import type { SidebarSectionBodyProps } from "../../features/channel-navigation/sidebar-sections-service";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { readView, writeView } from "../../shared/view-state";
import {
  ActivityFeed,
  type FeedDestination,
  type FeedView,
} from "./ActivityFeed";
import styles from "./ActivityCard.module.css";

const views = [
  { value: "all", label: "All" },
  { value: "mentions", label: "Mentions" },
  { value: "threads", label: "Threads" },
] as const satisfies readonly { value: FeedView; label: string }[];
/** The card's own choices, separate from the Activity page's filters. */
const viewKey = "inbox:card-view";
const unreadOnlyKey = "inbox:card-unread-only";

/** Activity in a sidebar card: All, Mentions or Threads, newest first. */
export function ActivityCard({
  relay,
  navigator,
  target,
}: SidebarSectionBodyProps & { relay: RelayData; navigator: Navigation }) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  if (
    connection.status !== "ready" ||
    !viewer ||
    !scope?.endsWith(`:${viewer}`)
  )
    return null;
  return (
    <ActivityCardContents
      key={`${scope}:${connection.generation}`}
      session={connection.session}
      scope={{ viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) }}
      navigator={navigator}
      target={target}
    />
  );
}

function ActivityCardContents({
  session,
  scope,
  navigator,
  target,
}: Omit<Parameters<typeof ActivityFeed>[0], "view"> &
  Pick<SidebarSectionBodyProps, "target">) {
  const viewScope = session.scope;
  const [view, setViewState] = useState<FeedView>(() => {
    const saved = readView<unknown>(viewScope, viewKey, "all");
    return views.find((entry) => entry.value === saved)?.value ?? "all";
  });
  const [unreadOnly, setUnreadOnlyState] = useState(
    () => readView<unknown>(viewScope, unreadOnlyKey, false) === true,
  );
  const setView = (value: FeedView) => {
    setViewState(value);
    writeView(viewScope, viewKey, value);
  };
  const setUnreadOnly = (value: boolean) => {
    setUnreadOnlyState(value);
    writeView(viewScope, unreadOnlyKey, value);
  };
  const tabs = useRef<HTMLDivElement>(null);
  // The row of the conversation or thread open now shows selected, as its row
  // elsewhere in the sidebar does.
  const isOpen = (destination: FeedDestination) =>
    target.kind === "conversation" &&
    target.channelId === destination.channelId &&
    target.threadRootId === destination.rootId;
  return (
    <div className={styles.card}>
      <div ref={tabs} className={styles.tabs}>
        <Tabs
          label="Activity view"
          variant="panel"
          size="sm"
          value={view}
          items={views}
          onValueChange={setView}
          trailingAction={
            view === "all" ? (
              <Switch
                label="Unread"
                checked={unreadOnly}
                onCheckedChange={setUnreadOnly}
              />
            ) : undefined
          }
        />
      </div>
      <ActivityFeed
        session={session}
        scope={scope}
        navigator={navigator}
        view={view}
        unreadOnly={view === "all" && unreadOnly}
        onUnreadOnlyChange={setUnreadOnly}
        focusFallback={tabs}
        isOpen={isOpen}
      />
    </div>
  );
}
