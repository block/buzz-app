import { useEffect, useMemo, useState } from "react";
import { objectBody } from "../../features/relay/body";
import type { RelaySession } from "../../features/relay/session";

export type SearchMessage = Readonly<{
  id: string;
  channelId: string;
  authorId: string;
  createdAt: number;
  preview: string;
}>;
type Result = {
  owner: object;
  messages: readonly SearchMessage[];
  error?: string;
};

/** Finite, ranked results belong to this open palette, not a retained event view. */
export function useSearchMessages(
  session: RelaySession,
  query: string,
  channels: string,
) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>();
  const owner = useMemo(
    () => ({ session, query, channels, attempt }),
    [session, query, channels, attempt],
  );
  useEffect(() => {
    if (!query || !channels) return;
    const controller = new AbortController();
    // Typeahead waits for a brief typing pause; cancellation also owns the delay.
    const timer = setTimeout(() => {
      const ids: string[] = JSON.parse(channels);
      void session
        .read(
          [
            {
              kinds: [9, 40002],
              "#h": ids,
              search: query,
              search_mode: "prefix",
              limit: 20,
            },
          ],
          { signal: controller.signal, priority: "foreground", fresh: true },
        )
        .then((events) => {
          if (controller.signal.aborted) return;
          const allowed = new Set(
            session.channels.list().channels.map((channel) => channel.id),
          );
          const messages = events.flatMap((event): SearchMessage[] => {
            const destinations = event.tags.filter(([name]) => name === "h");
            const channelId = destinations[0]?.[1];
            if (
              ![9, 40002].includes(event.kind) ||
              destinations.length !== 1 ||
              !channelId ||
              !ids.includes(channelId) ||
              !allowed.has(channelId)
            )
              return [];
            // Search returns original indexed events, not an auxiliary edit fold.
            // Exact navigation owns current content/deletion checks when opened.
            const body =
              event.kind === 40002 ? objectBody(event.content) : undefined;
            const text =
              event.kind === 40002
                ? typeof body?.content === "string"
                  ? body.content
                  : "Agent message"
                : event.content;
            return [
              {
                id: event.id,
                channelId,
                authorId: event.pubkey,
                createdAt: event.created_at,
                preview:
                  text.replace(/\s+/g, " ").trim().slice(0, 240) ||
                  "Attachment",
              },
            ];
          });
          setResult({ owner, messages });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setResult({
              owner,
              messages: [],
              error:
                "Message search couldn’t finish. Pages and conversations are still available.",
            });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, query, channels, owner]);
  const current = result?.owner === owner ? result : undefined;
  return {
    messages: current?.messages ?? [],
    loading: !!query && !!channels && !current,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
