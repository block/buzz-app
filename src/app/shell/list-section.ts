import { useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { soloDraft } from "../../features/channel-navigation/routes";
import {
  listsConversations,
  routedSection,
  type ListColumn,
} from "./list-column";
import { useRailModel } from "./rail-model";
import type { RailEntry } from "./rail-pins";

/**
 * Which section the list column shows for the current visit: the one the
 * visit names or last listed, else the one the open conversation belongs to.
 * Unset on pages that list no conversations.
 */
export function useListSection(
  session: RelaySession,
  partition: string | undefined,
  navigator: Navigation | undefined,
  list: ListColumn,
) {
  const visit = useSyncExternalStore(
    navigator?.subscribe ?? noSubscription,
    () => navigator?.snapshot(),
  );
  const target = visit?.entry.target;
  const { channels, pins, sections: membership } = useRailModel(session);
  if (!partition || !target || !listsConversations(target)) return;
  const selected =
    target.kind === "conversation"
      ? channels.find((channel) => channel.id === target.channelId)
      : undefined;
  const belongs = (entry: RailEntry) => {
    if (target.kind !== "conversation") return false;
    const destination = entry.target;
    return destination.kind === "conversation"
      ? destination.channelId === target.channelId &&
          (!destination.threadRootId ||
            destination.threadRootId === target.threadRootId) &&
          (!destination.messageId || destination.messageId === target.messageId)
      : destination.kind === "person" &&
          selected?.channelType === "dm" &&
          selected.participants?.length === 1 &&
          selected.participants[0] === destination.pubkey;
  };
  const section =
    (list.section && membership.sections.has(list.section)
      ? list.section
      : undefined) ??
    membership.owner(belongs) ??
    (pins.some(belongs) ? "pins" : undefined) ??
    (selected?.channelType === "solo" ||
    (target.kind === "page" && soloDraft(target.route?.params))
      ? "solo"
      : "team");
  const title = membership.sections.get(section) ?? "Team";
  return {
    section,
    title,
    /** Names the list and its page together. */
    label:
      section === "team" || section === "solo" ? title : `${title} workspace`,
    /** Nothing is selected: a narrow window gives the list the whole width. */
    fill: routedSection(target) !== undefined,
  };
}

const noSubscription = () => () => {};
