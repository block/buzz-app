import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { GitHubComment } from "./GitHubComment";
import { InlineCommentForm } from "./InlineCommentForm";
import type { CommentChange, PrCommentActions } from "./pr-comment-actions";
import type { Comment, Snapshot } from "./pr-comments";
import styles from "./InlineComments.module.css";

export type EditDraft = {
  body: string;
  editing: boolean;
  originalBody?: string;
  restoreFocus?: boolean;
  lastFocusRequest?: number;
};
export function EditableGitHubComment({
  api,
  snapshot,
  comment,
  draft,
  onChanged,
  focusFallback,
  children,
}: {
  api: PrCommentActions;
  snapshot: Snapshot;
  comment: Comment;
  draft: EditDraft;
  onChanged(change: CommentChange): void;
  focusFallback?(): HTMLElement | null;
  children?: ReactNode;
}) {
  const [, render] = useState(0);
  const [confirming, setConfirming] = useState<string>();
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const state = useSyncExternalStore(api.subscribe, () => api.get(comment.id));
  const current =
    state?.viewer === snapshot.viewer && state.pullId === snapshot.pullId
      ? state
      : undefined;
  const blocked = state?.phase === "pending" || state?.phase === "unknown";
  const body = current?.body ?? comment.body;
  useLayoutEffect(() => {
    if (returnFocus.current) {
      if (document.activeElement === document.body)
        returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
    }
    if (!draft.editing && draft.restoreFocus) {
      draft.restoreFocus = false;
      editButton.current?.focus({ preventScroll: true });
    }
  });
  const closeEditor = (restoreFocus = true) => {
    draft.editing = false;
    delete draft.lastFocusRequest;
    render((value) => value + 1);
    draft.restoreFocus = restoreFocus;
  };
  async function update(
    change?: CommentChange,
    originalBody = draft.originalBody ?? body,
  ) {
    const focused = document.activeElement;
    if (
      await api.update(snapshot, { ...comment, body: originalBody }, change)
    ) {
      const result = api.get(comment.id);
      if (result?.phase !== "ready") return;
      closeEditor(
        confirming === undefined &&
          (document.activeElement === focused ||
            document.activeElement === document.body),
      );
      if (
        confirming === undefined &&
        "delete" in result.change &&
        (document.activeElement === focused ||
          document.activeElement === document.body)
      )
        focusFallback?.()?.focus({ preventScroll: true });
      onChanged(result.change);
    } else if (
      confirming === undefined &&
      focused instanceof HTMLElement &&
      document.activeElement === document.body
    ) {
      returnFocus.current = focused;
      render((value) => value + 1);
    }
    setConfirming(undefined);
  }
  const deleted = current?.phase === "ready" && "delete" in current.change;
  return (
    <>
      {deleted ? (
        <p role="status" className="text-body-sm">
          Comment deleted.
        </p>
      ) : (
        <GitHubComment comment={{ ...comment, body }}>
          {draft.editing && (
            <InlineCommentForm
              draft={draft}
              submitLabel="Save changes"
              busy={state?.phase === "pending"}
              blocked={!!blocked}
              onSubmit={(body) => void update({ body })}
              onCancel={() => closeEditor()}
            />
          )}
          <div className={styles.actions}>
            {comment.viewerCanUpdate && !draft.editing && (
              <Button
                size="sm"
                ref={editButton}
                disabled={blocked}
                onClick={() => {
                  draft.originalBody = body;
                  draft.body = body;
                  draft.editing = true;
                  render((value) => value + 1);
                }}
              >
                Edit
              </Button>
            )}
            {comment.viewerCanDelete && (
              <Button
                size="sm"
                ref={deleteButton}
                disabled={blocked}
                onClick={() => setConfirming(body)}
              >
                Delete
              </Button>
            )}
            {current &&
              (current.phase === "unknown" ||
                (current.phase === "pending" && current.checking)) && (
                <Button
                  size="sm"
                  ref={checkButton}
                  disabled={current.phase === "pending"}
                  onClick={() => void update()}
                >
                  Check comment
                </Button>
              )}
          </div>
          {current?.error && (
            <p role="status" className="text-body-sm">
              {current.phase === "unknown"
                ? "Comment delivery is unknown. Check comment before trying again. "
                : ""}
              {current.error}
            </p>
          )}
          {blocked && !current && (
            <p role="status" className="text-body-sm">
              A comment change from another GitHub account is pending. Switch
              back to check it.
            </p>
          )}
          {children}
        </GitHubComment>
      )}
      {confirming !== undefined && (
        <AlertDialog
          title="Delete comment?"
          description="This permanently deletes the comment from GitHub."
          pending={current?.phase === "pending"}
          finalFocus={() =>
            deleteButton.current?.disabled
              ? checkButton.current
              : (deleteButton.current ?? focusFallback?.())
          }
          onClose={() => setConfirming(undefined)}
          actions={
            <>
              <Button
                disabled={blocked}
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={blocked}
                onClick={() => void update({ delete: true }, confirming)}
              >
                Delete comment
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
