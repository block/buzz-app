import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RailEntry } from "./rail-pins";
import type { useIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { ChannelAvatar } from "../../features/channels/ChannelAvatar";
import { avatarMedia } from "../../shared/avatar-source";
import {
  ChatCircleIcon,
  StorefrontIcon,
} from "../../shared/design-system/icons";
import styles from "./RailNavigation.module.css";

/** Identity artwork is shared by rail rows, avatar grids and the pin picker. */
export function RailEntryArtwork({
  entry,
  avatarOnly = false,
  size = "compact",
  selected,
  session,
  channelsById,
  profiles,
  resolveName,
  identities,
  agentEntries,
}: {
  entry: RailEntry;
  avatarOnly?: boolean;
  size?: "compact" | "fill";
  selected: boolean;
  session: RelaySession;
  channelsById: ReadonlyMap<string, ChannelSummary>;
  profiles: ReturnType<RelaySession["profiles"]["snapshot"]>;
  resolveName: ReturnType<typeof useIdentityNames>;
  identities: ReturnType<
    RelaySession["agentChoices"]["snapshot"]
  >["identities"];
  agentEntries: readonly RailEntry[];
}) {
  const channelId =
    entry.target.kind === "conversation" ? entry.target.channelId : undefined;
  const channel = channelId ? channelsById.get(channelId) : undefined;
  const participants =
    channel?.channelType === "dm"
      ? [...new Set(channel.participants ?? [])].filter(
          (person) => person !== session.viewer,
        )
      : [];
  const person =
    entry.target.kind === "person"
      ? entry.target.pubkey
      : participants.length === 1
        ? participants[0]
        : undefined;
  const presence = usePresenceStatus(
    person ? session.presence : undefined,
    person,
  );
  const statusBadge = presence === "unknown" ? undefined : presence;
  const avatarArtwork = () => {
    if (avatarOnly && participants.length > 1)
      return (
        <AvatarStack
          size="cluster"
          items={participants.slice(0, 3).map((person) => ({
            id: person,
            name: resolveName(person, profiles.get(person)?.name ?? "Member"),
            src: avatarMedia(profiles.get(person)?.picture, session.media),
            shape: profiles.get(person)?.isAgent ? "squircle" : "circle",
          }))}
        />
      );
    if (entry.kind === "person" || entry.kind === "agent")
      return (
        <Avatar
          size={avatarOnly ? "fill" : size}
          shape={entry.kind === "agent" ? "squircle" : "circle"}
          src={avatarMedia(entry.picture, session.media)}
          alt=""
          fallback={entry.label}
          statusBadge={statusBadge}
          statusBadgeSize={avatarOnly ? "small" : "default"}
        />
      );
    if (entry.kind === "chat" && !avatarOnly) {
      const agent = identities.find((agent) =>
        channel?.members?.includes(agent.pubkey),
      );
      return (
        <Avatar
          size={size}
          shape="squircle"
          src={avatarMedia(
            agent?.avatar ?? (agent && profiles.get(agent.pubkey)?.picture),
            session.media,
          )}
          alt=""
          fallback={agent?.name ?? entry.label}
        />
      );
    }
    const Icon = entry.kind === "chat" ? ChatCircleIcon : StorefrontIcon;
    return entry.kind === "channel" ? (
      <ChannelAvatar size={avatarOnly ? "fill" : size} name={entry.label} />
    ) : avatarOnly || size === "fill" ? (
      <Avatar
        size="fill"
        alt=""
        fallback={entry.label}
        src={avatarMedia(
          agentEntries.find(
            (agent) =>
              entry.kind === "chat" &&
              agent.target.kind === "person" &&
              channel?.members?.includes(agent.target.pubkey),
          )?.picture,
          session.media,
        )}
        fallbackContent={entry.kind === "page" ? <Icon size={24} /> : undefined}
      />
    ) : (
      <Icon size={18} />
    );
  };
  const avatar = (
    <>
      {avatarArtwork()}
      {statusBadge && <span className="sr-only">Presence: {statusBadge}</span>}
    </>
  );
  if (!avatarOnly) return avatar;
  return (
    <span className={styles.pinArtwork}>
      {selected && (
        <span
          className={styles.pinSelection}
          data-channel={entry.kind === "channel" || undefined}
          data-agent={entry.kind === "agent" || undefined}
          aria-hidden="true"
        >
          <span className={styles.pinSelectionArtwork}>{avatar}</span>
        </span>
      )}
      {avatar}
    </span>
  );
}
