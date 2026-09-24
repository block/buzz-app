import { useCallback, useEffect, useMemo, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";

type Person = Awaited<
  ReturnType<RelaySession["directMessages"]["people"]>
>["people"][number];
const empty: readonly Person[] = [];

/** Directory pages belong to this menu and community, not the global profile cache. */
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
    channelId: string;
    query: string;
    people: readonly Person[];
    error?: string;
    loading: boolean;
    more?: boolean;
  }>();
  const channelId = channel?.id ?? "";
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const current = { session, channelId, query, attempt };
    setState({ ...current, people: empty, loading: true });
    void session.directMessages.people(query, 1, controller.signal).then(
      ({ people, hasMore }) => {
        if (!controller.signal.aborted)
          setState({ ...current, people, loading: false, more: hasMore });
      },
      () => {
        if (!controller.signal.aborted)
          setState({
            ...current,
            people: empty,
            loading: false,
            error: "Could not search community people. Retry to refresh.",
          });
      },
    );
    return () => controller.abort();
  }, [session, channelId, query, active, attempt]);
  const current =
    active &&
    state?.session === session &&
    state.channelId === channelId &&
    state.query === query
      ? state
      : undefined;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return useMemo(
    () => ({
      people: current?.people ?? empty,
      loading: !!active && (!current || current.loading),
      error: current?.error,
      more: !!current?.more,
      retry,
    }),
    [current, active, retry],
  );
}
