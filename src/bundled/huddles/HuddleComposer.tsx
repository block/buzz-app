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
  attachmentDraft,
  attachmentDraftCount,
  subscribeAttachmentDraftCounts,
  transferAttachmentDraft,
} from "../../features/messages/attachment-draft";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { huddleComposerExtensions } from "./composer-extensions";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { ComposerSession } from "../../features/messages/composer-session";

const noEdits: readonly ChannelMessage[] = [];

/**
 * Files a companion window keeps for an editor that is not mounted right now:
 * a pop-out that drilled from its conversation into a thread still holds the
 * conversation's files (drafts are keyed by the editor's session object,
 * which a companion rebuilds per connection), and returns them to the editor
 * that mounts again for the same draft key. Never evicted: each entry is
 * unsent work the person attached by hand, and the window's close guard
 * counts it; the window's lifetime bounds the set.
 */
const retainedDrafts = new Map<
  string,
  { session: ComposerSession; channelId: string }
>();
const retainedListeners = new Set<() => void>();
const retainedChanged = () => {
  for (const listener of retainedListeners) listener();
};
function retainDraft(key: string, session: ComposerSession, channelId: string) {
  retainedDrafts.set(key, { session, channelId });
  retainedChanged();
}
/** Files held for other editors of this window: still unsent work. */
function useRetainedDraftCount(except: string) {
  const subscribe = useCallback((listener: () => void) => {
    retainedListeners.add(listener);
    const stops = [...retainedDrafts.values()].map(({ session }) =>
      subscribeAttachmentDraftCounts(session, listener),
    );
    return () => {
      retainedListeners.delete(listener);
      for (const stop of stops) stop();
    };
  }, []);
  return useSyncExternalStore(subscribe, () => {
    let count = 0;
    for (const [key, { session }] of retainedDrafts)
      if (key !== except) count += attachmentDraftCount(session, key);
    return count;
  });
}

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
  /** Told while a voice note is being captured in this editor. */
  onCapturing?: ((capturing: boolean) => void) | undefined;
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
  const keys = JSON.stringify([
    data?.tools ?? [],
    data?.completions ?? [],
    data?.links ?? [],
  ]);
  const capture = presentation?.capture ?? false;
  const extensions = useMemo(() => {
    const [tools, completions, links] = JSON.parse(keys) as [
      string[],
      string[],
      string[],
    ];
    return huddleComposerExtensions({
      tools,
      completions,
      links,
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
  // Files kept for this draft by an earlier editor session of this window
  // return to this one; on unmount, this editor's files are kept the same way.
  const room = data?.room;
  useEffect(() => {
    if (!editorSession || !draftKey || !room) return;
    const kept = retainedDrafts.get(draftKey);
    if (kept && kept.session !== editorSession) {
      const source = attachmentDraft(kept.session, draftKey, kept.channelId);
      if (source.snapshot().length)
        try {
          transferAttachmentDraft(
            source,
            attachmentDraft(editorSession, draftKey, room),
          );
        } catch {
          /* The new draft already holds files; the kept ones stay kept. */
        }
    }
    if (kept) {
      retainedDrafts.delete(draftKey);
      retainedChanged();
    }
    return () => {
      if (attachmentDraftCount(editorSession, draftKey) > 0)
        retainDraft(draftKey, editorSession, room);
    };
  }, [editorSession, draftKey, room]);
  const retainedFiles = useRetainedDraftCount(draftKey);
  const onHeld = presentation?.onHeld;
  const held = editorHeld || files > 0 || retainedFiles > 0;
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
        onCapturing={presentation?.onCapturing}
        disabled={!data.writable}
        editMessages={presentation?.editMessages ?? noEdits}
      />
    </MentionModelsContext.Provider>
  ) : (
    <p role="status">Loading composer…</p>
  );
}
