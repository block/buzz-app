import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { objectBody } from "../../features/relay/body";
import type { RelaySession } from "../../features/relay/session";
import type { ReadFilter } from "../../features/relay/events";
import { foldProfiles } from "../../features/relay/profiles";
import {
  isHexPubkey,
  normalizeFromHandle,
  normalizeInChannel,
  parseSearchOperators,
} from "./parseSearchOperators";

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
  scopedChannelId?: string,
  operatorChannelId?: string | null,
) {
  const parsed = useMemo(() => parseSearchOperators(query), [query]);
  const channelId = scopedChannelId ?? operatorChannelId;
  const unresolvedChannel =
    !scopedChannelId &&
    !!(parsed.in && normalizeInChannel(parsed.in)) &&
    !channelId;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>();
  const owner = useMemo(
    () => ({ session, query, channelId, unresolvedChannel, attempt }),
    [session, query, channelId, unresolvedChannel, attempt],
  );
  // The copied result changes synchronously even if React has not committed it yet.
  const copied = useRef<Result | undefined>(undefined);
  const replace = useCallback((next: Result | undefined) => {
    copied.current = next;
    setResult(next);
  }, []);
  useEffect(
    () =>
      session.channels.subscribeList(() => {
        const previous = copied.current;
        if (!previous) return;
        const messages = previous.messages.filter(
          (message) => !!session.channels.get?.(message.channelId),
        );
        if (messages.length !== previous.messages.length)
          replace({ ...previous, messages });
      }),
    [session, replace],
  );
  useEffect(() => {
    if (!parsed.text || unresolvedChannel) return;
    const controller = new AbortController();
    // Typeahead waits for a brief typing pause; cancellation also owns the delay.
    const timer = setTimeout(() => {
      void (async () => {
        let author: string | undefined;
        if (parsed.from) {
          if (isHexPubkey(parsed.from)) {
            author = parsed.from.toLowerCase();
          } else {
            const handle = normalizeFromHandle(parsed.from).toLowerCase();
            if (!handle) return [];
            // The same signed kind-0 index used by the base user typeahead.
            // Exact names only: a hit in a profile's bio is not an identity match.
            const candidates = await session.read(
              [
                {
                  kinds: [0],
                  search: handle,
                  search_mode: "prefix",
                  limit: 40,
                },
              ],
              {
                signal: controller.signal,
                priority: "foreground",
                fresh: true,
              },
            );
            const profiles = foldProfiles(candidates);
            author = [...profiles].find(
              ([pubkey, profile]) =>
                profile.name.trim().toLowerCase() === handle ||
                pubkey === handle,
            )?.[0];
            if (!author) return [];
          }
        }
        // Revalidate public previews on every scoped read. Joined members are
        // skipped by resolve; a retained public preview is not live authority.
        if (channelId)
          await session.channels.resolve?.([channelId], {
            signal: controller.signal,
            priority: "foreground",
          });
        if (channelId && !session.channels.get?.(channelId)) return [];
        const filter: ReadFilter = {
          kinds: [9, 40002, 40008],
          search: parsed.text,
          search_mode: "prefix",
          limit: 20,
          ...(channelId ? { "#h": [channelId] } : {}),
          ...(author ? { authors: [author] } : {}),
          ...(parsed.since !== null ? { since: parsed.since } : {}),
          ...(parsed.until !== null ? { until: parsed.until } : {}),
        };
        return session.read([filter], {
          signal: controller.signal,
          priority: "foreground",
          fresh: true,
        });
      })()
        .then((events) => {
          if (controller.signal.aborted) return;
          const messages = events.flatMap((event): SearchMessage[] => {
            const destinations = event.tags.filter(([name]) => name === "h");
            const hitChannelId = destinations[0]?.[1];
            if (
              ![9, 40002, 40008].includes(event.kind) ||
              destinations.length !== 1 ||
              !hitChannelId ||
              (channelId && hitChannelId !== channelId) ||
              !session.channels.get?.(hitChannelId)
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
                channelId: hitChannelId,
                authorId: event.pubkey,
                createdAt: event.created_at,
                preview:
                  text.replace(/\s+/g, " ").trim().slice(0, 240) ||
                  "Attachment",
              },
            ];
          });
          replace({ owner, messages });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            replace({
              owner,
              messages: [],
              error: `Message search couldn’t finish${error instanceof Error && error.message ? `: ${error.message.slice(0, 240)}` : "."}${scopedChannelId ? " Try again." : " Pages and conversations are still available."}`,
            });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    session,
    parsed,
    channelId,
    unresolvedChannel,
    owner,
    replace,
    scopedChannelId,
  ]);
  const current = result?.owner === owner ? result : undefined;
  return {
    messages: (current?.messages ?? []).filter(
      (message) => !!session.channels.get?.(message.channelId),
    ),
    loading: !!parsed.text && !unresolvedChannel && !current,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
