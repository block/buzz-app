import { MentionModelsContext } from "../../features/agents/react";
import {
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

/** How the hosting window presents the editor; the Huddle defaults apply. */
export type CompanionComposerPresentation = {
  channelName?: string;
  label?: string;
  placeholder?: string;
  onHeld?: ((held: boolean) => void) | undefined;
};
export function useHuddleComposer(
  token: string | undefined,
  presentation?: CompanionComposerPresentation,
) {
  const [client, setClient] =
    useState<ReturnType<typeof createHuddleComposerClient>>();
  useEffect(() => {
    if (!token) {
      setClient(undefined);
      return;
    }
    const next = createHuddleComposerClient(token);
    setClient(next);
    return () => next.dispose();
  }, [token]);
  return client ? (
    <ConnectedComposer client={client} presentation={presentation} />
  ) : null;
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
  const extensions = useMemo(() => {
    const [tools, completions] = JSON.parse(keys) as [string[], string[]];
    return huddleComposerExtensions({
      tools,
      completions,
      gifRequests: client.gifs,
    });
  }, [keys, client]);
  // Held work is the editor's unsaved state or files kept only in this window.
  const [editorHeld, setEditorHeld] = useState(false);
  const draftKey = data
    ? `${data.scope}:${data.thread ? `draft:${data.room}:thread:${data.thread}` : `draft:${data.room}`}`
    : "";
  const files = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        session ? subscribeAttachmentDraftCounts(session, listener) : () => {},
      [session],
    ),
    () => (session ? attachmentDraftCount(session, draftKey) : 0),
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
        session={session}
        extensions={extensions}
        scope={data.scope}
        channelId={data.room}
        channelName={presentation?.channelName ?? "Huddle"}
        label={presentation?.label ?? "Message this Huddle"}
        placeholder={presentation?.placeholder ?? "Message this Huddle"}
        {...(data.thread ? { threadRootId: data.thread } : {})}
        onHeld={onHeld ? setEditorHeld : undefined}
        disabled={!data.writable}
        editMessages={[]}
      />
    </MentionModelsContext.Provider>
  ) : (
    <p role="status">Loading composer…</p>
  );
}
