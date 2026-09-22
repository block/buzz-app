import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import type { SearchDestination, SearchInputProps } from "./SearchChoices";
import { SearchChoices } from "./SearchChoices";
import { useSearchMessages } from "./useSearchMessages";

function conversationName(
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
) {
  if (channel.channelType !== "dm" || !channel.participants)
    return channel.name;
  return (
    channel.participants
      .map((id) => profiles.get(id)?.name ?? id.slice(0, 10))
      .join(", ") || "Notes to self"
  );
}

export function SearchResults({
  session,
  query,
  onQueryChange,
  input,
  pages,
  openConversation,
}: {
  session: RelaySession;
  pages: readonly SearchDestination[];
  openConversation: (channelId: string, messageId?: string) => void;
} & SearchInputProps) {
  const list = useChannelList(session.channels);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          !channel.archived &&
          (!channel.hidden || channel.channelType === "dm"),
      ),
    [list.channels],
  );
  const channelKey = channels.length
    ? JSON.stringify(channels.map((channel) => channel.id).sort())
    : "";
  const search = useSearchMessages(session, query.trim(), channelKey);
  const names = new Map(
    channels.map((channel) => [
      channel.id,
      conversationName(channel, profiles),
    ]),
  );
  const profileKey = [
    ...new Set([
      ...channels.flatMap((channel) =>
        channel.channelType === "dm" ? (channel.participants ?? []) : [],
      ),
      ...search.messages.map((message) => message.authorId),
    ]),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  useEffect(() => {
    if (profileKey)
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey]);
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  const conversations: SearchDestination[] = channels
    .filter((channel) => names.get(channel.id)?.toLowerCase().includes(needle))
    .slice(0, 8)
    .map((channel) => ({
      key: `channel:${channel.id}`,
      label: names.get(channel.id) ?? channel.name,
      detail:
        channel.channelType === "dm"
          ? "Direct message"
          : channel.channelType === "session"
            ? "Session"
            : "Conversation",
      icon: ChatCircleIcon,
      run: () => openConversation(channel.id),
    }));
  const messages: SearchDestination[] = search.messages.map((message) => ({
    key: message.id,
    label: message.preview,
    detail: `${names.get(message.channelId) ?? "Conversation"} · ${profiles.get(message.authorId)?.name ?? message.authorId.slice(0, 10)} · ${new Date(message.createdAt * 1000).toLocaleDateString()}`,
    icon: ChatCircleIcon,
    run: () => openConversation(message.channelId, message.id),
  }));
  return (
    <SearchChoices
      query={query}
      onQueryChange={onQueryChange}
      input={input}
      groups={[
        { label: "Pages", destinations: pages },
        { label: "Conversations", destinations: conversations },
        { label: "Messages", destinations: messages },
      ]}
    >
      <div
        className="space-y-2 px-3 text-body-sm text-subtle"
        aria-live="polite"
      >
        {list.status === "loading" && <p>Loading joined conversations…</p>}
        {list.status === "error" && (
          <div>
            <p>Couldn’t load all joined conversations.</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                session.channels.refreshList
                  ? session.channels.refreshList()
                  : session.channels.ensureList()
              }
            >
              Retry conversations
            </Button>
          </div>
        )}
        {list.coverage === "partial" && (
          <p>Only the loaded joined conversations are searched.</p>
        )}
        {search.loading && <p>Searching messages…</p>}
        {search.error && (
          <div>
            <p>{search.error}</p>
            <Button size="sm" variant="ghost" onClick={search.retry}>
              Retry messages
            </Button>
          </div>
        )}
        {query.trim() &&
          !search.loading &&
          !search.error &&
          !messages.length &&
          list.status === "ready" && (
            <p>No matching messages in joined conversations.</p>
          )}
        {!query.trim() && <p>Type to search messages in this community.</p>}
      </div>
    </SearchChoices>
  );
}
