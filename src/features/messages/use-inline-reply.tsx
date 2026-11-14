import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot } from "../relay/threads";
import type { MessageComposerProps } from "./MessageComposer";
import { ReplyContext } from "./ReplyContext";
import type { ReplyHold } from "./use-message-reply-hold";
import { usePendingRequest } from "./use-pending-request";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

/** The rows a reader has loaded, with edits and deletions already folded. */
export type LoadedRows = {
  subscribe(listener: () => void): () => void;
  row(id: string): ChannelMessage | undefined;
};
type Target = {
  session: RelaySession;
  channelId: string;
  id: string;
  rootId: string;
  /** The row as selected, shown until the reader or an exact read has it. */
  selected: ChannelMessage;
};
const noSubscribe = () => () => {};

/**
 * The message a composer replies to. A row in the reader's loaded window is
 * its own evidence: it shows, follows edits and sends at once. Only a target
 * that has left that window is read exactly, and Send waits for that read.
 * Choosing the current target again clears it.
 */
export function useReplyTarget(
  session: RelaySession,
  channelId: string | undefined,
  loaded: LoadedRows,
  requestFocus: () => void,
) {
  const [chosen, setChosen] = useState<Target>();
  const current = useRef(chosen);
  current.current = chosen;
  const target =
    chosen?.session === session && chosen.channelId === channelId
      ? chosen
      : undefined;
  if (chosen && !target) setChosen(undefined);
  const select = useCallback(
    (row: ChannelMessage, deferFocus = false): ReplyHold => {
      const previous = current.current;
      const next =
        previous?.id === row.id
          ? undefined
          : {
              session,
              channelId: row.channelId,
              id: row.id,
              rootId: row.threadRootId ?? row.id,
              selected: row,
            };
      current.current = next;
      setChosen(next);
      if (!deferFocus) requestFocus();
      return {
        commit() {
          if (current.current === next) requestFocus();
        },
        cancel() {
          setChosen((chosen) => (chosen === next ? previous : chosen));
        },
      };
    },
    [session, requestFocus],
  );
  const cancel = useCallback(() => {
    setChosen(undefined);
    requestFocus();
  }, [requestFocus]);
  /** A send clears the target it was sent to, not one chosen since. */
  const sent = useCallback((to: Target | undefined) => {
    if (to) setChosen((chosen) => (chosen === to ? undefined : chosen));
  }, []);
  const readLoaded = () => (target ? loaded.row(target.id) : undefined);
  const row = useSyncExternalStore(
    target ? loaded.subscribe : noSubscribe,
    readLoaded,
    readLoaded,
  );
  const last = useRef<ChannelMessage>(undefined);
  if (row) last.current = row;
  const absent = !!target && !row;
  const [evidence, setEvidence] = useState<{
    target: Target;
    snapshot?: ThreadSnapshot;
    failed?: true;
  }>();
  useEffect(() => {
    if (!target || !absent) return;
    try {
      // Folds live edits and deletions with the same authority as the reader.
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
  }, [session, target, absent]);
  const read = absent && evidence?.target === target ? evidence : undefined;
  const status = read?.snapshot?.targetStatus;
  const verified = row ?? read?.snapshot?.target;
  const pending = absent && !read?.failed && (!status || status === "loading");
  const known =
    last.current?.id === target?.id ? last.current : target?.selected;
  const shown = verified ?? (pending ? known : undefined);
  const context: ReactNode = !target ? undefined : shown ? (
    <ReplyContext row={shown} session={session} onCancel={cancel} />
  ) : (
    <div className={styles.replyContext}>
      <span>
        {status === "unavailable"
          ? "Reply target is no longer available."
          : "Reply target could not be loaded. Cancel and select it again."}
      </span>
      <Button size="sm" onClick={cancel}>
        Cancel reply target
      </Button>
    </div>
  );
  return {
    target,
    /** The target's current row, once it is evidence enough to send. */
    row: verified,
    sendDisabled: !!target && !verified,
    context,
    select,
    cancel,
    sent,
  };
}

type ReplyComposer = Pick<
  MessageComposerProps,
  | "retainChannelDraft"
  | "focusRequest"
  | "threadRootId"
  | "replyParentId"
  | "onCancelReply"
  | "replyScope"
  | "replyContext"
  | "sendDisabled"
  | "onSend"
>;

/**
 * A channel composer's reply target, chosen from its channel's timeline.
 * The reader attaches `surface` to the element holding that timeline and the
 * composer; Escape from there cancels the target.
 */
export function useInlineReply(
  session: RelaySession,
  channelId: string | undefined,
  onSend: MessageComposerProps["onSend"],
  focusRequest = 0,
) {
  const [localFocus, setLocalFocus] = useState({
    external: focusRequest,
    sequence: 0,
    request: focusRequest,
  });
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
  const channels = session.channels;
  const loaded = useMemo<LoadedRows>(
    () => ({
      subscribe: (listener) =>
        channelId ? channels.subscribeWindow(channelId, listener) : () => {},
      row: (id) =>
        channelId
          ? channels.window(channelId).rows.find((row) => row.id === id)
          : undefined,
    }),
    [channels, channelId],
  );
  const reply = useReplyTarget(session, channelId, loaded, requestFocus);
  const { target } = reply;
  const scope = useRef<Element | null>(null);
  const surface = useCallback((element: HTMLElement | null) => {
    scope.current = element;
  }, []);
  const composer: ReplyComposer = {
    retainChannelDraft: true,
    ...(focus ? { focusRequest: focus } : {}),
    ...(target
      ? {
          threadRootId: target.rootId,
          replyParentId: target.id,
          sendDisabled: reply.sendDisabled,
          onCancelReply: reply.cancel,
          replyScope: scope,
          replyContext: reply.context,
        }
      : {}),
    onSend: (id) => {
      if (target) reply.sent(target);
      else onSend?.(id);
    },
  };
  return { select: reply.select, composer, surface };
}
