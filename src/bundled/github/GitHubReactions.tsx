import { useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { SmileyPlusIcon } from "../../shared/design-system/icons/index";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import {
  reactionNames,
  type PrReactions,
  type ReactionContent,
} from "./pr-reactions";
import type { Comment, Snapshot } from "./pr-comments";
import styles from "./InlineComments.module.css";

export function GitHubReactions({
  api,
  snapshot,
  comment,
}: {
  api: PrReactions;
  snapshot: Snapshot;
  comment: Comment;
}) {
  const [open, setOpen] = useState(false);
  const state = useSyncExternalStore(api.subscribe, () => api.get(comment.id));
  const current = state?.viewer === snapshot.viewer ? state : undefined;
  const known = current?.groups ?? comment.reactions ?? [];
  const desired = current?.phase === "pending" ? current.desired : undefined;
  const groups = desired
    ? (Object.keys(reactionNames) as ReactionContent[]).map((content) => {
        const group = known.find((group) => group.content === content) ?? {
          content,
          viewerHasReacted: false,
          users: { totalCount: 0 },
        };
        if (
          content !== desired.content ||
          group.viewerHasReacted === desired.reacted
        )
          return group;
        return {
          ...group,
          viewerHasReacted: desired.reacted,
          users: {
            totalCount: Math.max(
              0,
              group.users.totalCount + (desired.reacted ? 1 : -1),
            ),
          },
        };
      })
    : known;
  const blocked = state?.phase === "pending" || state?.phase === "unknown";
  const update = (content: ReactionContent) =>
    void api.update(snapshot, comment, {
      content,
      reacted: !(
        groups.find((group) => group.content === content)?.viewerHasReacted ??
        false
      ),
    });
  return (
    <div>
      <div className={styles.actions}>
        {groups
          .filter((group) => group.users.totalCount > 0)
          .map((group) => (
            <Button
              key={group.content}
              size="sm"
              variant="outline"
              disabled={blocked}
              aria-label={`${reactionNames[group.content]?.[1] ?? group.content}, ${group.users.totalCount}`}
              aria-busy={current?.phase === "pending"}
              aria-pressed={group.viewerHasReacted}
              onClick={() => update(group.content)}
            >
              {reactionNames[group.content]?.[0]} {group.users.totalCount}
            </Button>
          ))}
        <PopoverRoot open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                size="sm"
                shape="icon"
                variant="ghost"
                aria-label="React"
                title="React"
                disabled={blocked}
              >
                <SmileyPlusIcon size={14} />
              </Button>
            }
          />
          <PopoverPopup size="compact" aria-label="Choose reaction">
            <div className={styles.reactionPicker}>
              {(Object.keys(reactionNames) as ReactionContent[]).map(
                (content) => (
                  <Button
                    shape="icon"
                    size="sm"
                    variant="ghost"
                    aria-label={reactionNames[content][1]}
                    title={reactionNames[content][1]}
                    aria-pressed={
                      groups.find((group) => group.content === content)
                        ?.viewerHasReacted ?? false
                    }
                    key={content}
                    disabled={blocked}
                    onClick={() => {
                      setOpen(false);
                      update(content);
                    }}
                  >
                    {reactionNames[content][0]}
                  </Button>
                ),
              )}
            </div>
          </PopoverPopup>
        </PopoverRoot>
        {state?.phase === "unknown" && (
          <Button size="sm" onClick={() => void api.update(snapshot, comment)}>
            Check reactions
          </Button>
        )}
      </div>
      {state?.error && (
        <p role="status" className="text-body-sm">
          {state.phase === "unknown"
            ? "Reaction delivery is unknown. Check reactions before trying again. "
            : ""}
          {state.error}
        </p>
      )}
    </div>
  );
}
