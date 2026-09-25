import { useCallback, useEffect, useMemo, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";

type Person = Awaited<
  ReturnType<RelaySession["directMessages"]["people"]>
>["people"][number];
type Page = { people: readonly Person[]; more: boolean };
const empty: readonly Person[] = [];
/** Typing pause before an uncached query reaches the network. */
export const MENTION_DIRECTORY_DELAY_MS = 200;
const CACHE_LIMIT = 100;

// Successful first pages, per session (community/viewer) and query. Session
// lifetime bounds staleness; errors are not cached, so Retry reads again.
const pages = new WeakMap<RelaySession, Map<string, Page>>();
function cached(session: RelaySession, query: string) {
  return pages.get(session)?.get(query);
}
function remember(session: RelaySession, query: string, page: Page) {
  let queries = pages.get(session);
  if (!queries) {
    queries = new Map();
    pages.set(session, queries);
  }
  queries.delete(query);
  queries.set(query, page);
  if (queries.size > CACHE_LIMIT)
    queries.delete(queries.keys().next().value ?? "");
}

/**
 * Directory pages belong to this menu and community, not the global profile
 * cache. While a new query waits or loads, the last settled page stays visible
 * so callers can keep its still-matching people instead of blanking the list.
 */
export function useMentionDirectory(
  session: RelaySession,
  channel: ChannelSummary | undefined,
  query: string,
  enabled: boolean,
) {
  const active =
    enabled &&
    !channel?.archived &&
    !channel?.readOnly &&
    (channel?.channelType === "stream" || channel?.channelType === "forum");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    session: RelaySession;
    query: string;
    attempt: number;
    error?: string;
  }>();
  const [last, setLast] = useState<{ session: RelaySession; page: Page }>();
  const hit = active ? cached(session, query) : undefined;
  useEffect(() => {
    if (!active || cached(session, query)) return;
    const controller = new AbortController();
    const current = { session, query, attempt };
    const timer = setTimeout(() => {
      void session.directMessages.people(query, 1, controller.signal).then(
        ({ people, hasMore }) => {
          if (controller.signal.aborted) return;
          remember(session, query, { people, more: hasMore });
          setState(current);
        },
        () => {
          if (!controller.signal.aborted)
            setState({
              ...current,
              error: "Could not search community people. Retry to refresh.",
            });
        },
      );
    }, MENTION_DIRECTORY_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, query, active, attempt]);
  if (hit && (last?.session !== session || last.page !== hit))
    setLast({ session, page: hit });
  const error =
    active &&
    !hit &&
    state?.session === session &&
    state.query === query &&
    state.attempt === attempt
      ? state.error
      : undefined;
  const shown = hit ?? (last?.session === session ? last.page : undefined);
  const retry = useCallback(() => {
    pages.get(session)?.delete(query);
    setAttempt((value) => value + 1);
  }, [session, query]);
  return useMemo(
    () => ({
      /** The current query's page, or the last settled page while it loads. */
      people: (active && shown?.people) || empty,
      loading: active && !hit && !error,
      error,
      more: !!hit?.more,
      retry,
    }),
    [active, shown, hit, error, retry],
  );
}
