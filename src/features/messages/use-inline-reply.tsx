import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot } from "../relay/threads";
import type { MessageComposerProps } from "./MessageComposer";
import { ReplyContext } from "./ReplyContext";
import { usePendingRequest } from "./use-pending-request";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

type ReplyComposer = Pick<
  MessageComposerProps,
  | "retainChannelDraft"
  | "focusRequest"
  | "threadRootId"
  | "replyParentId"
  | "onCancelReply"
  | "replyContext"
  | "sendDisabled"
  | "onSend"
>;
type Selection = {
  session: RelaySession;
  channelId: string;
  id: string;
  rootId: string;
  /** Immediate presentation only; the exact reader decides send eligibility. */
  preview: ChannelMessage;
};

/** One transient target and owned live reader per channel composer. */
export function useInlineReply(
  session: RelaySession,
  channelId: string | undefined,
  onSend: MessageComposerProps["onSend"],
  focusRequest = 0,
) {
  const [selected, setSelected] = useState<Selection>();
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  const [localFocus, setLocalFocus] = useState({
    external: focusRequest,
    sequence: 0,
    request: focusRequest,
  });
  const target =
    selected?.session === session && selected.channelId === channelId
      ? selected
      : undefined;
  if (selected && !target) setSelected(undefined);
  // Local requests have their own identity. Expiring an external request must
  // never turn an already-consumed local request into a new focus request.
  if (localFocus.external !== focusRequest) {
    setLocalFocus({
      ...localFocus,
      external: focusRequest,
      request: focusRequest,
    });
  }
  const focus = usePendingRequest(localFocus.request);
  const requestFocus = useCallback(() => {
    setLocalFocus((previous) => ({
      external: focusRequest,
      sequence: previous.sequence + 1,
      request: -(previous.sequence + 1),
    }));
  }, [focusRequest]);
  const select = useCallback(
    (row: ChannelMessage, deferFocus = false) => {
      const previous = currentSelection.current;
      const selection: Selection = {
        session,
        channelId: row.channelId,
        id: row.id,
        rootId: row.threadRootId ?? row.id,
        preview: row,
      };
      currentSelection.current = selection;
      setSelected(selection);
      if (!deferFocus) requestFocus();
      return {
        commit() {
          if (currentSelection.current === selection) requestFocus();
        },
        cancel() {
          setSelected((current) =>
            current === selection ? previous : current,
          );
        },
      };
    },
    [session, requestFocus],
  );
  const cancel = useCallback(() => {
    setSelected(undefined);
    requestFocus();
  }, [requestFocus]);
  const [evidence, setEvidence] = useState<{
    target: Selection;
    snapshot?: ThreadSnapshot;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!target) return;
    try {
      // The exact reader retains verified target evidence independently of the
      // bounded timeline and folds live edits/deletions with the same authority.
      const view = session.thread(target.channelId, target.id, { exact: true });
      const update = () => setEvidence({ target, snapshot: view.snapshot() });
      const unsubscribe = view.subscribe(update);
      update();
      void view.refresh();
      return () => {
        unsubscribe();
        view.dispose();
      };
    } catch {
      setEvidence({ target, failed: true });
    }
  }, [session, target]);
  const current = evidence?.target === target ? evidence : undefined;
  const verified = current?.snapshot?.target;
  const status = current?.snapshot?.targetStatus;
  const pending = !current?.failed && (!status || status === "loading");
  const reply = verified ?? (pending ? target?.preview : undefined);
  const unavailable = current?.snapshot?.targetStatus === "unavailable";
  const composer: ReplyComposer = {
    retainChannelDraft: true,
    ...(focus ? { focusRequest: focus } : {}),
    ...(target
      ? {
          threadRootId: target.rootId,
          replyParentId: target.id,
          sendDisabled: !verified,
          onCancelReply: cancel,
          replyContext: reply ? (
            <ReplyContext row={reply} session={session} onCancel={cancel} />
          ) : (
            <div className={styles.replyContext}>
              <span>
                {unavailable
                  ? "Reply target is no longer available."
                  : "Reply target could not be loaded. Cancel and select it again."}
              </span>
              <Button size="sm" onClick={cancel}>
                Cancel reply target
              </Button>
            </div>
          ),
        }
      : {}),
    onSend: (id) => {
      if (target)
        setSelected((current) => (current === target ? undefined : current));
      else onSend?.(id);
    },
  };
  return { select, composer };
}
