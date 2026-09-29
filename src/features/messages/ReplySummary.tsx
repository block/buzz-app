import { Shimmer } from "../../shared/design-system/ui/Shimmer";
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
  workingAgents = [],
  workingLabel,
}: {
  workingAgents?: readonly string[];
  workingLabel?: string | undefined;
  count: number;
  /** Distinct responders, most recent first (matching relay summaries). */
  participants: readonly string[];
  profiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  resolveName(id: string, fallback: string): string;
  media(url: string, size?: "small"): string | undefined;
  unreadLabel?: string | undefined;
  unreadCount?: number;
}) {
  const active = new Set(workingAgents);
  const others = [...new Set(participants)].filter((id) => !active.has(id));
  const shown = workingAgents.length
    ? [
        ...others.slice(0, Math.max(0, 3 - workingAgents.length)).reverse(),
        ...workingAgents.slice(-3),
      ]
    : others.slice(0, 3).reverse();
  const overflow = others.length + active.size - shown.length;
  return (
    <>
      {shown.length > 0 && (
        <span className={styles.threadAvatars} aria-hidden="true">
          {workingAgents.length > 0 && overflow > 0 && (
            <span className={styles.threadAvatarCount}>+{overflow}</span>
          )}
          {shown.map((id) => {
            const profile = profiles?.get(id);
            const name = resolveName(id, profile?.name ?? id.slice(0, 10));
            const shape =
              active.has(id) || agentPubkeys?.has(id) || profile?.isAgent
                ? "squircle"
                : "circle";
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
          {!workingAgents.length && overflow > 0 && (
            <span className={styles.threadAvatarCount}>+{overflow}</span>
          )}
        </span>
      )}
      {workingLabel ? (
        <Shimmer active className="text-body-sm text-subtle">
          {workingLabel}
        </Shimmer>
      ) : (
        <span>
          {count} {count === 1 ? "reply" : "replies"}
        </span>
      )}
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
