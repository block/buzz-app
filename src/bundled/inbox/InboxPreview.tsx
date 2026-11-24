import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import type { PagePreviewProps } from "../../features/pages/service";
import { useRelayConnection } from "../../features/relay/react";
import { communityRefusalTitle } from "../../features/federated-identity/CommunitySignIn";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ArrowRightIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Switch } from "../../shared/design-system/ui/Switch";
import { readView, writeView } from "../../shared/view-state";
import { ActivityFeed, useActivitySummary } from "./ActivityFeed";
import { inboxTarget } from "./route";
import styles from "./InboxPreview.module.css";

/** The card's own Unread only choice, separate from the Activity page filters. */
const unreadOnlyKey = "inbox:preview-unread-only";

/** Recent activity, shown while the pointer rests on the sidebar's Activity row. */
export function InboxPreview({
  relay,
  navigator,
  close,
}: PagePreviewProps & { relay: RelayData; navigator: Navigation }) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  if (connection.status === "ready" && viewer && scope?.endsWith(`:${viewer}`))
    return (
      <InboxPreviewCard
        key={`${scope}:${connection.generation}`}
        session={connection.session}
        scope={{
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        }}
        navigator={navigator}
        close={close}
      />
    );
  return (
    <Card navigator={navigator} close={close}>
      <p className={`text-body text-subtle ${styles.notice}`} role="status">
        {connection.status === "connecting"
          ? "Connecting to your activity…"
          : connection.denied
            ? // Its notice, on every page, offers what fixes it.
              communityRefusalTitle(connection.refusal)
            : (connection.error ?? "Choose a community to see your activity.")}
      </p>
      {connection.status === "error" && !connection.denied && (
        <div className={styles.notice}>
          <Button size="sm" onClick={relay.tryAgain}>
            Retry connection
          </Button>
        </div>
      )}
    </Card>
  );
}

function InboxPreviewCard({
  session,
  scope,
  navigator,
  close,
}: PagePreviewProps & {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
}) {
  const viewScope = session.scope;
  const [unreadOnly, setUnreadOnlyState] = useState(
    () => readView<unknown>(viewScope, unreadOnlyKey, false) === true,
  );
  const setUnreadOnly = (value: boolean) => {
    setUnreadOnlyState(value);
    writeView(viewScope, unreadOnlyKey, value);
  };
  const unreadOnlyControl = useRef<HTMLElement>(null);
  return (
    <Card
      navigator={navigator}
      close={close}
      summary={useActivitySummary(session)}
      unreadOnly={unreadOnly}
      onUnreadOnlyChange={setUnreadOnly}
      unreadOnlyRef={unreadOnlyControl}
    >
      <ActivityFeed
        session={session}
        scope={scope}
        navigator={navigator}
        unreadOnly={unreadOnly}
        onUnreadOnlyChange={setUnreadOnly}
        focusFallback={unreadOnlyControl}
        onOpen={close}
      />
    </Card>
  );
}

/** The card's frame: title and Unread only above, Open Activity below. */
function Card({
  navigator,
  close,
  summary,
  unreadOnly,
  onUnreadOnlyChange,
  unreadOnlyRef,
  children,
}: PagePreviewProps & {
  navigator: Navigation;
  summary?: string | undefined;
  unreadOnly?: boolean;
  onUnreadOnlyChange?: (value: boolean) => void;
  unreadOnlyRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const switchId = useId();
  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={`text-label ${styles.title}`}>Activity</h2>
          <p
            className={`text-caption text-subtle ${styles.summary}`}
            role="status"
          >
            {summary ?? " "}
          </p>
        </div>
        <div className={styles.toggle}>
          <Switch
            ref={unreadOnlyRef}
            id={switchId}
            aria-label="Unread only"
            checked={!!unreadOnly}
            onCheckedChange={onUnreadOnlyChange}
            disabled={!onUnreadOnlyChange}
          />
          <label
            htmlFor={switchId}
            className={`text-caption ${onUnreadOnlyChange ? "text-subtle" : "text-disabled"}`}
          >
            Unread only
          </label>
        </div>
      </header>
      <div className={styles.body}>{children}</div>
      <footer className={styles.footer}>
        <NavigationItem
          label="Open Activity"
          trailing={<ArrowRightIcon size="1rem" aria-hidden="true" />}
          onClick={() => {
            close();
            void navigator.open(inboxTarget);
          }}
        />
      </footer>
    </div>
  );
}
