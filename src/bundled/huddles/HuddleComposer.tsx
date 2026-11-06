import { MentionModelsContext } from "../../features/agents/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createHuddleComposerClient } from "../../features/huddle/composer-client";
import {
  attachmentDraftCount,
  subscribeAttachmentDraftCounts,
} from "../../features/messages/attachment-draft";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { huddleComposerExtensions } from "./composer-extensions";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { ComposerSession } from "../../features/messages/composer-session";

const noEdits: readonly ChannelMessage[] = [];

/** How the hosting window presents the editor; the Huddle defaults apply. */
export type CompanionComposerPresentation = {
  channelName?: string;
  label?: string;
  placeholder?: string;
  onHeld?: ((held: boolean) => void) | undefined;
  /** Reply to this message within the thread (pop-out windows). */
  replyParentId?: string | undefined;
  replyContext?: ReactNode;
  /** Messages the editor may edit (pop-out windows); Huddle edits nothing. */
  editMessages?: readonly ChannelMessage[] | undefined;
  /** A session wrapping the bridge client's with more operations (pop-out
   * windows: the operations outbox, so edits follow one id to delivery). */
  session?: ComposerSession | undefined;
  /** This window may record voice notes (pop-out windows; never the Huddle). */
  capture?: boolean | undefined;
};
export type CompanionComposerClient = ReturnType<
  typeof createHuddleComposerClient
>;
/** The connected editor plus its bridge client, for hosts that also react or
 * otherwise operate through the same main-window owner. */
export function useCompanionComposer(
  token: string | undefined,
  presentation?: CompanionComposerPresentation,
) {
  const [client, setClient] = useState<CompanionComposerClient>();
  useEffect(() => {
    if (!token) {
      setClient(undefined);
      return;
    }
    const next = createHuddleComposerClient(token);
    setClient(next);
    return () => next.dispose();
  }, [token]);
  return {
    client,
    composer: client ? (
      <ConnectedComposer client={client} presentation={presentation} />
    ) : null,
  };
}
export function useHuddleComposer(
  token: string | undefined,
  presentation?: CompanionComposerPresentation,
) {
  return useCompanionComposer(token, presentation).composer;
}
function ConnectedComposer({
  client,
  presentation,
}: {
  client: ReturnType<typeof createHuddleComposerClient>;
  presentation?: CompanionComposerPresentation | undefined;
}) {
  useSyncExternalStore(client.subscribe, client.revision);
  const { session, data, error } = client.snapshot();
  const modelRevision = data?.modelRevision;
  const models = useMemo(() => {
    void modelRevision;
    return (keys: readonly string[]) => client.models(keys);
  }, [client, modelRevision]);
  const keys = JSON.stringify([data?.tools ?? [], data?.completions ?? []]);
  const capture = presentation?.capture ?? false;
  const extensions = useMemo(() => {
    const [tools, completions] = JSON.parse(keys) as [string[], string[]];
    return huddleComposerExtensions({
      tools,
      completions,
      gifRequests: client.gifs,
      capture,
    });
  }, [keys, client, capture]);
  // Held work is the editor's unsaved state or files kept only in this window.
  const [editorHeld, setEditorHeld] = useState(false);
  const draftKey = data
    ? `${data.scope}:${data.thread ? `draft:${data.room}:thread:${data.thread}` : `draft:${data.room}`}`
    : "";
  // Drafts are keyed by the session the editor was given, which a host may
  // wrap; count against that one, or the files it keeps go unguarded.
  const editorSession = session
    ? (presentation?.session ?? session)
    : undefined;
  const files = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        editorSession
          ? subscribeAttachmentDraftCounts(editorSession, listener)
          : () => {},
      [editorSession],
    ),
    () => (editorSession ? attachmentDraftCount(editorSession, draftKey) : 0),
  );
  const onHeld = presentation?.onHeld;
  const held = editorHeld || files > 0;
  useEffect(() => {
    onHeld?.(held);
  }, [onHeld, held]);
  if (error) return <p role="alert">{error}</p>;
  return session && data ? (
    <MentionModelsContext.Provider value={models}>
      <MessageComposer
        session={editorSession ?? session}
        extensions={extensions}
        scope={data.scope}
        channelId={data.room}
        channelName={presentation?.channelName ?? "Huddle"}
        label={presentation?.label ?? "Message this Huddle"}
        placeholder={presentation?.placeholder ?? "Message this Huddle"}
        {...(data.thread ? { threadRootId: data.thread } : {})}
        replyParentId={presentation?.replyParentId}
        replyContext={presentation?.replyContext}
        onHeld={onHeld ? setEditorHeld : undefined}
        disabled={!data.writable}
        editMessages={presentation?.editMessages ?? noEdits}
      />
    </MentionModelsContext.Provider>
  ) : (
    <p role="status">Loading composer…</p>
  );
}
