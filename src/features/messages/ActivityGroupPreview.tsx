import { AgentResponsePreview } from "./AgentResponsePreview";
import { useActivityIndicator } from "./use-activity-indicator";
import type { RelaySession } from "../relay/session";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import type { ActivityPresentation } from "./activity-presentation";
import { toggleActivityHistory } from "./activity-avatar-motion";
import type { Profile } from "../relay/contracts";
import { avatarMedia } from "../../shared/avatar-source";
import { messagePreviewText } from "../conversation/message-preview-text";
import styles from "./Messages.module.css";

/** One stable disclosure for a run of activity, showing its latest speaker. */
export function ActivityGroupPreview({
  group,
  session,
  profiles,
  media,
  expanded,
  onToggle,
  layout = "timeline",
}: {
  group: ActivityPresentation;
  session?: RelaySession | undefined;
  profiles: ReadonlyMap<string, Profile>;
  media: (url: string, size?: "small") => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  layout?: "timeline" | "thread";
}) {
  const { latest: row, history, participants, done, working } = group;
  const live = useActivityIndicator(
    session,
    row,
    !done && !group.followingMessage,
    participants,
  );
  const primary = history[0]?.authorId ?? row.authorId;
  const profile = profiles.get(primary);
  const motionKey = (author: string) => `${history[0]?.id ?? row.id}:${author}`;
  const name = profile?.name ?? primary.slice(0, 10);
  const text = Array.from(messagePreviewText(row.content).replace(/\s+/g, " "));
  const preview = done
    ? `${history.length} completed ${history.length === 1 ? "step" : "steps"}`
    : text.length > 280
      ? `${text.slice(0, 279).join("")}…`
      : text.join("");
  const content = (
    <div
      className={styles.audienceRow}
      data-layout={layout}
      data-completed={done || undefined}
      data-collapse={expanded || undefined}
    >
      <div className={styles.audienceEntry}>
        <button
          type="button"
          data-buzz-ui=""
          className={styles.audienceLine}
          data-collapse={expanded || undefined}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Show"} activity history: ${name}: ${preview}`}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            toggleActivityHistory(
              event.currentTarget,
              onToggle,
              event.detail === 0,
              history[0]?.id ?? row.id,
            );
          }}
        >
          <span className={styles.audiencePreviewText}>
            {expanded && !done ? (
              "Collapse"
            ) : (
              <ShimmerText active={working || live}>{preview}</ShimmerText>
            )}
          </span>
        </button>
      </div>
    </div>
  );
  return !done || group.standalone ? (
    <AgentResponsePreview
      name={name}
      participants={
        done
          ? []
          : participants.map((id) => ({
              id,
              name: profiles.get(id)?.name ?? id.slice(0, 10),
              picture: avatarMedia(profiles.get(id)?.picture, media),
              motionKey: expanded ? undefined : motionKey(id),
            }))
      }
      stackPrevious={!group.standalone}
      picture={avatarMedia(profile?.picture, media)}
      layout={layout}
    >
      <div className={styles.standaloneActivity}>{content}</div>
    </AgentResponsePreview>
  ) : (
    content
  );
}
