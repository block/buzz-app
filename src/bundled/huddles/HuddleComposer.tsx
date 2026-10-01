import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createHuddleComposerClient } from "../../features/huddle/composer-client";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { huddleComposerExtensions } from "./composer-extensions";

export function useHuddleComposer(token: string | undefined) {
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
  return client ? <ConnectedComposer client={client} /> : null;
}
function ConnectedComposer({
  client,
}: {
  client: ReturnType<typeof createHuddleComposerClient>;
}) {
  useSyncExternalStore(client.subscribe, client.revision);
  const { session, data, error } = client.snapshot();
  const keys = JSON.stringify([data?.tools ?? [], data?.completions ?? []]);
  const extensions = useMemo(() => {
    const [tools, completions] = JSON.parse(keys) as [string[], string[]];
    return huddleComposerExtensions({ tools, completions });
  }, [keys]);
  if (error) return <p role="alert">{error}</p>;
  return session && data ? (
    <MessageComposer
      session={session}
      extensions={extensions}
      scope={`${data.scope}:${data.viewer}`}
      channelId={data.room}
      channelName="Huddle"
      label="Message this Huddle"
      placeholder="Message this Huddle"
      disabled={!data.writable}
      editMessages={[]}
    />
  ) : (
    <p role="status">Loading composer…</p>
  );
}
