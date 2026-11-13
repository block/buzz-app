import { useCallback, useRef, type ReactNode } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import type {
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";
import {
  ActivityFilters,
  ConversationList,
  includeMessagesChannel,
  useActivityView,
  withoutAgentViews,
  withoutTeamViews,
  type ActivityView,
  type ConversationListEntry,
} from "../../features/conversation/ConversationList";
import type { RailEntry } from "./rail-pins";
import { RailDestinationRow } from "./RailArrangement";
import feedStyles from "../../features/conversation/FeedList.module.css";
import { useRailUnread } from "./RailConversationItem";

/** Expanded cards keep their membership while sharing Messages' feed and controls. */
export function RailConversationList({
  section,
  entries,
  session,
  scope,
  navigator,
  target,
  renderOther,
  title = section === "solo" ? "Solo" : "Team",
  heading,
}: {
  section: string;
  title?: string;
  heading?: ReactNode;
  entries: readonly RailEntry[];
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  target: OpenTarget;
  renderOther(entry: RailEntry): ReactNode;
}) {
  const [saved, setView] = useActivityView(
    section === "messages"
      ? `${scope.communityOrigin}:${scope.viewer}`
      : `${scope.communityOrigin}:${scope.viewer}:rail-page:${section}`,
  );
  const agentViews = section === "solo";
  const view = agentViews ? withoutTeamViews(saved) : withoutAgentViews(saved);
  // Whole conversations use the shared feed. Exact message/thread destinations
  // remain individual entries, preserving their original opening targets.
  const conversations = new Map<string, RailEntry>();
  const others: RailEntry[] = [];
  for (const entry of entries) {
    const destination = entry.target;
    if (
      destination.kind === "conversation" &&
      !destination.threadRootId &&
      !destination.messageId
    )
      conversations.set(destination.channelId, entry);
    else others.push(entry);
  }
  // Rows keep one wrapper while mounted; it reads the current entries. Rows
  // render below this component in the same pass, so they must already see
  // this pass's entries: an effect would hand a new row the previous ones.
  const current = useRef(conversations);
  current.current = conversations;
  const wrapRow = useCallback(
    (item: ConversationListEntry, content: ReactNode) => {
      const original = current.current.get(item.target.channelId);
      if (!original) return content;
      const entry = {
        ...original,
        label: item.label,
        target: item.target,
        id: item.key.startsWith("e:") ? `activity:${item.key}` : original.id,
      };
      return (
        <RailDestinationRow section={section} entry={entry}>
          {content}
        </RailDestinationRow>
      );
    },
    [section],
  );
  const extras = others.filter(
    (entry) =>
      view.filter === "all" ||
      ((view.filter === "threads" || view.filter === "mentions") &&
        entry.target.kind === "conversation" &&
        (view.filter === "threads"
          ? !!entry.target.threadRootId
          : !!entry.target.messageId && !entry.target.threadRootId)),
  );
  if (view.sort === "alpha")
    extras.sort((a, b) => a.label.localeCompare(b.label));
  return (
    <section
      className={feedStyles.page}
      aria-label={heading ? title : `${title} list`}
    >
      {heading ?? (
        <ActivityFilters
          title={title}
          view={view}
          onChange={setView}
          layout="collection"
          agentViews={agentViews}
        />
      )}
      <div className={feedStyles.scroll}>
        <ConversationList
          session={session}
          navigator={navigator}
          scope={scope}
          target={target}
          view={view}
          layout="feed"
          includeChannel={(channel) =>
            conversations.has(channel.id) &&
            (section !== "messages" || includeMessagesChannel(channel, view))
          }
          wrapRow={wrapRow}
        />
        {extras.length > 0 && (
          <ul className={feedStyles.list} aria-label="Other destinations">
            {extras.map((entry) => (
              <ExactDestinationRow
                key={entry.id}
                entry={entry}
                session={session}
                unreadOnly={view.unread}
                section={section}
                render={renderOther}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ExactDestinationRow({
  entry,
  session,
  unreadOnly,
  section,
  render,
}: {
  entry: RailEntry;
  session: RelaySession;
  unreadOnly: ActivityView["unread"];
  section: string;
  render(entry: RailEntry): ReactNode;
}) {
  const unread = useRailUnread(session, entry.target);
  if (unreadOnly && !unread) return null;
  return (
    <li className={feedStyles.item}>
      <RailDestinationRow section={section} entry={entry}>
        {render(entry)}
      </RailDestinationRow>
    </li>
  );
}
