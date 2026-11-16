// A task's comments: its own conversation, held open by name. The relay's
// answer alone decides what shows: a neutral wait, then the comments with a
// composer or read-only, never a composer while posting is unknown.
import { useEffect, useState } from "react";
import {
  ConversationChannel,
  ConversationComposer,
  ConversationTimeline,
} from "../../features/conversation/Conversation";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import { MessageManagementStatus } from "../../features/messages/MessageManagement";
import { BANNED } from "../../features/relay/channel-access";
import { useChannelWindow } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import type { Task } from "./model";
import { useReach } from "./react";
import styles from "./Tasks.module.css";

function useConversationId(session: RelaySession, task: Task) {
  const [id, setId] = useState<string>();
  useEffect(() => {
    let current = true;
    setId(undefined);
    void session.artifacts.conversationId(task.id).then((derived) => {
      if (current) setId(derived);
    });
    return () => {
      current = false;
    };
  }, [session, task.id]);
  return id;
}

export type TaskCommentsProps = {
  session: RelaySession;
  /** The relay connection's scope, which conversation views share. */
  scope: string;
  host: ConversationHostServices;
  task: Task;
};

export function TaskComments({
  session,
  scope,
  host,
  task,
}: TaskCommentsProps) {
  const id = useConversationId(session, task);
  const conversation = useReach(session, id);
  const home = useReach(session, task.home);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const open = session.artifacts.openConversation;
  if (!session.channels.reach || !open)
    return (
      <p className="text-body-sm text-subtle m-0">
        Comments aren’t available in this community yet.
      </p>
    );
  const state = conversation.state;
  if (state.status === "open" && id)
    return (
      <ConversationChannel
        session={session}
        scope={scope}
        channel={{ id, name: "Comments", channelType: "artifact" }}
        channelName={`Comments on ${task.title}`}
        active={false}
        host={host}
      >
        <div className={styles.comments} data-attachment-drop-zone="">
          <MessageManagementStatus />
          <CommentList session={session} id={id} />
          {state.post ? (
            <ConversationComposer label="Comment" placeholder="Add a comment" />
          ) : (
            <p className="text-body-sm text-subtle m-0">Read-only access</p>
          )}
        </div>
      </ConversationChannel>
    );
  const reason = state.status === "unavailable" ? state.reason : undefined;
  if (!reason || (reason === "unavailable" && home.state.status === "loading"))
    return (
      <p className="text-body-sm text-subtle m-0" role="status">
        Loading comments…
      </p>
    );
  // A ban is the relay's answer, not a failure: nothing to try again.
  if (
    reason === "banned" ||
    (home.state.status === "unavailable" && home.state.reason === "banned")
  )
    return <p className="text-body-sm text-subtle m-0">{BANNED}</p>;
  // Either question going unanswered is a failure to show, never "no
  // comments yet": the home's answer decides who may start them.
  const homeFailed =
    home.state.status === "unavailable" && home.state.reason === "failed";
  if (reason === "failed" || homeFailed)
    return (
      <div className={styles.actions} role="alert">
        <p className="text-body-sm text-subtle m-0">Couldn’t load comments.</p>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            conversation.retry();
            home.retry();
          }}
        >
          Try again
        </Button>
      </div>
    );
  // Nobody has commented yet. Whoever may post in the task's home starts it.
  const canStart = home.state.status === "open" && home.state.post;
  const readOnly = home.state.status === "open" && !home.state.post;
  return (
    <div className={styles.actions}>
      <p className="text-body-sm text-subtle m-0">No comments yet.</p>
      {readOnly ? (
        <p className="text-body-sm text-subtle m-0">Read-only access</p>
      ) : null}
      {canStart ? (
        <Button
          type="button"
          size="sm"
          disabled={opening}
          onClick={() => {
            setOpening(true);
            setError(undefined);
            open(task.id, AbortSignal.timeout(20_000))
              .catch((reason: unknown) =>
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Couldn’t start comments. Try again.",
                ),
              )
              .finally(() => setOpening(false));
          }}
        >
          Add a comment
        </Button>
      ) : null}
      {error ? (
        <p className="buzz-field-error m-0" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CommentList({ session, id }: { session: RelaySession; id: string }) {
  const window = useChannelWindow(session.channels, id);
  if (window.status === "error" && !window.rows.length)
    return (
      <div className={styles.actions} role="alert">
        <p className="text-body-sm text-subtle m-0">{window.error}</p>
        <Button
          type="button"
          size="sm"
          onClick={() => session.channels.ensure(id)}
        >
          Try again
        </Button>
      </div>
    );
  if (window.status !== "ready" && !window.rows.length)
    return (
      <p className="text-body-sm text-subtle m-0" role="status">
        Loading comments…
      </p>
    );
  return (
    <div className={styles.commentList}>
      <ConversationTimeline
        viewer={session.viewer}
        window={window}
        startsThreads={false}
        marksRead={false}
        historyControl="button"
      />
    </div>
  );
}
