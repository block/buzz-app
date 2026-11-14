import { useEffect, useState } from "react";
import type { ChannelQueries } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";

/**
 * When a thread's first message was sent (unix seconds): undefined while it
 * reads, null when it cannot. A message the session already holds answers
 * without a read.
 */
export function useThreadRootTime(
  session: Pick<RelaySession, "thread">,
  channelId: string,
  rootId: string | undefined,
): number | null | undefined {
  const [result, setResult] = useState<{ key: string; at: number | null }>();
  const key = rootId && `${channelId}:${rootId}`;
  useEffect(() => {
    if (!rootId || !key) return;
    let view: ReturnType<RelaySession["thread"]>;
    try {
      view = session.thread(channelId, rootId);
    } catch {
      setResult({ key, at: null });
      return;
    }
    let settled = false;
    const read = () => {
      if (settled) return;
      const snapshot = view.snapshot();
      const at = snapshot.root?.createdAt;
      if (at === undefined && snapshot.status !== "error") return;
      settled = true;
      setResult({ key, at: at ?? null });
    };
    const unsubscribe = view.subscribe(read);
    read();
    if (!settled) void view.refresh();
    return () => {
      settled = true;
      unsubscribe();
      view.dispose();
    };
  }, [session, channelId, rootId, key]);
  return key && result?.key === key ? result.at : undefined;
}

/**
 * Moves a channel's history to a thread's first message, sent at `at`, when
 * it is too far up to page to: true once the channel holds it, false when it
 * cannot, undefined while it reads. The channel then shows a stretch of older
 * history, apart from its newest messages, until the reader returns to them.
 */
export function useThreadJump(
  channels: ChannelQueries,
  channelId: string,
  rootId: string | undefined,
  at: number | null | undefined,
): boolean | undefined {
  const [result, setResult] = useState<{ key: string; found: boolean }>();
  const key = rootId && `${channelId}:${rootId}`;
  useEffect(() => {
    if (!rootId || !key || at === undefined) return;
    if (at === null || !channels.seek) {
      setResult({ key, found: false });
      return;
    }
    const request = new AbortController();
    const settle = (found: boolean) => {
      if (!request.signal.aborted) setResult({ key, found });
    };
    channels
      .seek(channelId, at, request.signal)
      .then(() =>
        settle(
          channels.window(channelId).rows.some((row) => row.id === rootId),
        ),
      )
      .catch(() => settle(false));
    return () => request.abort();
  }, [channels, channelId, rootId, key, at]);
  return key && result?.key === key ? result.found : undefined;
}
