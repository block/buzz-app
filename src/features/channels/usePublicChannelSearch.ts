import { useEffect, useMemo, useState } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

const none: readonly ChannelSummary[] = [];

type Result = {
  owner: object;
  channels: readonly ChannelSummary[];
  partial: boolean;
  error?: string;
};

/** Public channels the viewer has not joined, found by name for Command-K and
 * the composer's `#` completion. The store resolves each match, so opening one
 * reaches the read-only preview. */
export function usePublicChannelSearch(
  session: RelaySession,
  query: string,
  ready: boolean,
  exact = false,
) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>();
  const search = session.channels.searchPublic;
  const owner = useMemo(
    () => ({ session, query, exact, attempt }),
    [session, query, exact, attempt],
  );
  useEffect(() => {
    if (!query || !ready || !search) return;
    const controller = new AbortController();
    // Typeahead waits for a brief typing pause; cancellation also owns the delay.
    const timer = setTimeout(() => {
      search(query, {
        signal: controller.signal,
        priority: "foreground",
        exact,
      }).then(
        ({ channels, partial }) => {
          if (!controller.signal.aborted)
            setResult({ owner, channels, partial });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({
              owner,
              channels: [],
              partial: false,
              error: `Public channel search couldn’t finish${error instanceof Error && error.message ? `: ${error.message.slice(0, 240)}` : "."}`,
            });
        },
      );
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, ready, search, exact, owner]);
  const current = result?.owner === owner ? result : undefined;
  return {
    loading: !!query && ready && !!search && !current,
    // A channel joined or removed since the lookup leaves this result set.
    channels: (current?.channels ?? []).filter(
      (channel) => session.channels.get?.(channel.id)?.readOnly,
    ),
    /** The lookup's channels as returned, the same array until the next
     * result. Callers that keep it must recheck each channel themselves. */
    found: current?.channels ?? none,
    partial: !!current?.partial,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
