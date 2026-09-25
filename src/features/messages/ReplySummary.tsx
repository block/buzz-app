import { Avatar } from "../../shared/design-system/ui/Avatar";
import type { Profile } from "../relay/contracts";
import styles from "./Messages.module.css";

/** Shared summary contents for channel threads and collapsed reply branches. */
export function ReplySummary({
  count,
  participants,
  profiles,
  agentPubkeys,
  resolveName,
  media,
  unreadLabel,
  unreadCount,
}: {
  count: number;
  participants: readonly string[];
  profiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  resolveName(id: string, fallback: string): string;
  media(url: string, size?: "small"): string | undefined;
  unreadLabel?: string | undefined;
  unreadCount?: number;
}) {
  return (
    <>
      {participants.length > 0 && (
        <span className={styles.threadAvatars} aria-hidden="true">
          {participants.slice(0, 3).map((id) => {
            const profile = profiles?.get(id);
            const name = resolveName(id, profile?.name ?? id.slice(0, 10));
            const shape = agentPubkeys?.has(id) ? "squircle" : "circle";
            return (
              <span
                key={id}
                className={styles.threadAvatar}
                data-avatar-shape={shape}
                title={name}
              >
                <Avatar
                  src={
                    profile?.picture
                      ? media(profile.picture, "small")
                      : undefined
                  }
                  alt=""
                  fallback={name}
                  size="fill"
                  shape={shape}
                />
              </span>
            );
          })}
          {participants.length > 3 && (
            <span className={styles.threadAvatarCount}>
              +{participants.length - 3}
            </span>
          )}
        </span>
      )}
      <span>
        {count} {count === 1 ? "reply" : "replies"}
      </span>
      {unreadCount ? (
        <span>({unreadCount} new)</span>
      ) : unreadLabel ? (
        <span
          className={styles.threadUnread}
          aria-hidden="true"
          title={unreadLabel}
        />
      ) : null}
    </>
  );
}
