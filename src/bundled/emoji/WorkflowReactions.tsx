import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ComposerSession } from "../../features/messages/composer-session";
import { isReactionShortcode } from "../../features/relay/emoji";
import { UUID } from "../../features/workflows/protocol";
import type { WorkflowCapability } from "../../features/workflows/types";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { useWorkflowView } from "../workflows/useWorkflowView";
import { workflowReactions } from "./workflow-reactions";
import styles from "./Emoji.module.css";

type Props = {
  capability: WorkflowCapability;
  channelId: string;
  session: Pick<ComposerSession, "emoji" | "media">;
  disabled: boolean;
  choose(emoji: string): void;
};

export default function WorkflowReactions(props: Props) {
  // Some chooser hosts have no message target (for example a video comment).
  if (!UUID.test(props.channelId)) return null;
  return <Choices {...props} />;
}
function Choices({ capability, channelId, session, disabled, choose }: Props) {
  const { snapshot, refresh } = useWorkflowView(
    // Single-channel discovery is bounded to one page, never a full inventory.
    useCallback(
      () => capability.definitions(channelId),
      [capability, channelId],
    ),
  );
  useEffect(() => {
    // Capability invalidation purges old choices; reread only while open.
    if (snapshot?.status === "idle") void refresh();
  }, [snapshot?.status, refresh]);
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const choices = useMemo(
    () =>
      workflowReactions(
        snapshot?.status === "ready" ? snapshot.data.items : [],
        channelId,
      ),
    [snapshot, channelId],
  );
  if (!snapshot || snapshot.status === "unavailable") return null;
  if (snapshot.status === "idle" || snapshot.status === "loading") {
    return (
      <LoadingRegion pending label="Loading workflow reactions…">
        {null}
      </LoadingRegion>
    );
  }
  if (snapshot.status === "error") {
    return (
      <div className={styles.emojiStatus}>
        <p>
          Workflow reactions could not be checked. The emoji picker still works.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Retry workflow reactions
        </Button>
      </div>
    );
  }
  if (!choices.items.length && !choices.incomplete && !snapshot.data.partial)
    return null;
  return (
    <section
      className={styles.workflowReactions}
      aria-label="Workflow reactions"
    >
      <InlineHeader
        title="Workflow reactions"
        actions={
          <IconButton
            aria-label="Refresh workflow reactions"
            title="Refresh workflow reactions"
            icon={<ArrowsClockwiseIcon size={16} />}
            onClick={() => void refresh()}
          />
        }
      />
      <p className="text-caption">
        Configured triggers; other conditions may apply.
      </p>
      <div className={styles.workflowReactionGrid}>
        {choices.items.map(({ emoji, labels }) => {
          const custom = isReactionShortcode(emoji)
            ? catalog.entries.find((entry) => `:${entry.shortcode}:` === emoji)
            : undefined;
          const source = custom && session.media(custom.url);
          // Do not offer a custom alias the current community cannot resolve.
          if (isReactionShortcode(emoji) && !source) return null;
          const label = `${emoji}: ${labels.join("; ")}`;
          return (
            <IconButton
              key={emoji}
              aria-label={label}
              title={label}
              size="lg"
              disabled={disabled}
              onClick={() => choose(emoji)}
              {...(source
                ? {
                    icon: (
                      <img
                        className={styles.workflowReactionImage}
                        src={source}
                        alt=""
                      />
                    ),
                  }
                : { emoji })}
            />
          );
        })}
      </div>
      {(choices.incomplete || snapshot.data.partial) && (
        <p className="text-caption">
          Some workflow triggers could not be listed.
        </p>
      )}
    </section>
  );
}
