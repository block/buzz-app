import { LockIcon, GlobeIcon } from "../../shared/design-system/icons";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import styles from "./SidebarChatArtwork.module.css";

/** Conversation identity comes from its members; icons are the last fallback. */
export function SidebarChatArtwork({
  channel,
  profile,
  session,
  icon,
  presence,
}: {
  channel: ChannelSummary;
  profile?: Profile | undefined;
  session: RelaySession;
  icon: ReactNode;
  presence?: "online" | "away" | "offline" | undefined;
}) {
  const visibility = channel.private ? "private" : channel.visibility;
  const showVisibility =
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    visibility;
  const visibilityLabel = showVisibility
    ? `${visibility === "private" ? "Private" : "Public"} channel`
    : undefined;
  return (
    <span
      className={styles.artwork}
      data-dm-identity={channel.channelType === "dm" ? "" : undefined}
      aria-hidden="true"
      role="img"
      aria-label={visibilityLabel}
      title={visibilityLabel}
      data-fallback={channel.channelType !== "dm" || undefined}
    >
      {channel.channelType !== "dm" ? (
        <Avatar
          alt=""
          fallback={channel.name.replace(/^#/, "")}
          fallbackContent={
            <span className="text-caption text-primary">
              {showVisibility ? (
                visibility === "private" ? (
                  <LockIcon size={12} />
                ) : (
                  <GlobeIcon size={12} />
                )
              ) : (
                Array.from(
                  channel.name.replace(/^#/, "").trim(),
                )[0]?.toUpperCase() || "?"
              )}
            </span>
          }
          size="fill"
          shape="circle"
        />
      ) : channel.participants?.length === 1 ? (
        <Avatar
          src={avatarMedia(profile?.picture, session.media)}
          alt=""
          fallback={profile?.name ?? channel.name}
          size="fill"
          shape={profile?.isAgent ? "squircle" : "circle"}
          statusBadge={presence}
        />
      ) : (channel.members?.length ?? channel.participants?.length ?? 0) > 0 ? (
        <GroupArtwork channel={channel} session={session} icon={icon} />
      ) : (
        icon
      )}
    </span>
  );
}

function GroupArtwork({
  channel,
  session,
  icon,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  icon: ReactNode;
}) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const agents = new Map(
    choices.identities.map((agent) => [agent.pubkey, agent]),
  );
  const roster = [...new Set(channel.members ?? channel.participants ?? [])];
  const others = roster.filter((id) => id !== session.viewer);
  const members = others.length ? others : roster;
  // Prefer recognizable portraits already available; cap demand to four profiles.
  const shown = [...members]
    .sort(
      (a, b) =>
        Number(!!profiles.get(b)?.picture) -
          Number(!!profiles.get(a)?.picture) || a.localeCompare(b),
    )
    .slice(0, 4);
  const keys = shown.join(":");
  useEffect(() => {
    if (keys)
      void session.profiles
        .ensure(keys.split(":"), "background")
        .catch(() => {});
  }, [session, keys]);
  const avatar = (id: string, single = false) => {
    const person = profiles.get(id);
    const agent = agents.get(id);
    return (
      <Avatar
        src={avatarMedia(person?.picture, session.media)}
        alt=""
        fallback={
          person?.name ?? agent?.name ?? (single ? channel.name : "Member")
        }
        size="fill"
        shape={person?.isAgent || agent ? "squircle" : "circle"}
      />
    );
  };
  return shown.length ? (
    <span className={styles.group} data-count={shown.length}>
      {shown.map((id) => (
        <span key={id}>{avatar(id)}</span>
      ))}
    </span>
  ) : (
    icon
  );
}
