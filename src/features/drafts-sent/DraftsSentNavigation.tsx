import type { RelayData } from "../relay/service";
import type { Navigation } from "../navigation/controller";
import type { NavigationScope, OpenTarget } from "../navigation/targets";
import { useChannelList, useRelayConnection } from "../relay/react";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SendIcon } from "../../shared/design-system/icons";
import styles from "./DraftsSent.module.css";
import { useDrafts } from "./drafts";
import { listed, scopeOf } from "./scope";

/** The host's Drafts & sent destination, shared by sidebar and global search. */
export function draftsSentTarget(
  scope?: NavigationScope,
): Extract<OpenTarget, { kind: "page" }> {
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    ...(scope ? { scope } : {}),
    route: { version: 1, params: "drafts-sent" },
  };
}

/** A Messages destination, independent of the optional plugin inventory. */
export function DraftsSentNavigation({
  relay,
  navigator,
  target,
}: {
  relay: RelayData;
  navigator: Navigation;
  target: OpenTarget;
}) {
  const connection = useRelayConnection(relay);
  const scope = scopeOf(connection);
  return (
    <NavigationItem
      label="Drafts & sent"
      icon={
        // Same icon box as plugin page rows, so this row shares their columns.
        <span className="shell-page-icon">
          <SendIcon size={16} strokeWidth={2.5} aria-hidden="true" />
        </span>
      }
      selected={
        target.kind === "page" &&
        target.pluginId === "buzz.channels" &&
        target.pageId === "channels" &&
        target.route?.params === "drafts-sent"
      }
      trailing={<DraftsSentBadge relay={relay} />}
      onClick={() => {
        void navigator.open(draftsSentTarget(scope));
        document.getElementById("main-content")?.focus({ preventScroll: true });
      }}
    />
  );
}

/** Sidebar count of unsent drafts in the current community. */
export function DraftsSentBadge({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const session =
    connection.status === "ready" ? connection.session : undefined;
  const drafts = useDrafts(session);
  const { channels } = useChannelList(connection.session.channels);
  const count = session
    ? drafts.entries.filter((entry) =>
        listed(channels.find((channel) => channel.id === entry.channelId)),
      ).length
    : 0;
  return count ? (
    <span className={styles.badge}>
      <CountBadge
        count={count}
        label={`${count} draft${count === 1 ? "" : "s"}`}
      />
    </span>
  ) : null;
}
