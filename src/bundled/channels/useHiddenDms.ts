import { useCallback, useEffect, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelList } from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";

type MessageHead = Readonly<{ id: string; createdAt: number }>;
type HiddenDm = { id: string; baseline?: MessageHead | null };
const key = "hidden-dms";

function restore(scope: string): HiddenDm[] {
  const saved = readView<unknown>(scope, key, []);
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string")
      return [];
    const baseline = entry.baseline;
    return [
      {
        id: entry.id,
        ...(baseline === null ||
        (baseline &&
          typeof baseline === "object" &&
          typeof baseline.id === "string" &&
          typeof baseline.createdAt === "number" &&
          Number.isFinite(baseline.createdAt))
          ? { baseline }
          : {}),
      },
    ];
  });
}

/** Local, viewer-scoped sidebar intent; verified message evidence restores a row. */
export function useHiddenDms(
  scope: string,
  session: RelaySession,
  list: ChannelList,
) {
  const [hidden, setHidden] = useState(() => restore(scope));
  const current = useRef(hidden);
  const update = useCallback(
    (next: HiddenDm[]) => {
      current.current = next;
      setHidden(next);
      // An unresolved baseline is only an optimistic hide; it cannot be
      // recovered safely after closing before its first verified head read.
      writeView(
        scope,
        key,
        next.filter((entry) => entry.baseline !== undefined),
      );
    },
    [scope],
  );
  const show = useCallback(
    (ids: readonly string[]) => {
      const targets = new Set(ids);
      const next = current.current.filter((entry) => !targets.has(entry.id));
      if (next.length !== current.current.length) update(next);
    },
    [update],
  );
  const hide = useCallback(
    (id: string) => {
      const latest = session.unread.snapshot({
        kind: "channel",
        channelId: id,
      }).latestMessage;
      update([
        ...current.current.filter((entry) => entry.id !== id),
        {
          id,
          ...(latest ? { baseline: latest } : {}),
        },
      ]);
    },
    [session, update],
  );

  useEffect(() => {
    if (!hidden.length) return;
    const check = () => {
      const next = current.current.flatMap((entry) => {
        const latest = session.unread.snapshot({
          kind: "channel",
          channelId: entry.id,
        }).latestMessage;
        if (!latest || entry.baseline === undefined) return [entry];
        if (entry.baseline === null) return [];
        if (latest.id === entry.baseline.id) return [entry];
        if (
          latest.createdAt > entry.baseline.createdAt ||
          (latest.createdAt === entry.baseline.createdAt &&
            latest.id < entry.baseline.id)
        )
          return [];
        // A deletion can reveal an older head. Keep hiding from that head.
        return [{ ...entry, baseline: latest }];
      });
      if (
        next.length !== current.current.length ||
        next.some((entry, index) => entry !== current.current[index])
      )
        update(next);
    };
    const stops = hidden.map((entry) =>
      session.unread.subscribe({ kind: "channel", channelId: entry.id }, check),
    );
    const stopIncoming = session.subscribeIncoming((messages) =>
      show(messages.map((message) => message.channelId)),
    );
    const stopOutgoing = session.outbox?.observeSend((event) => {
      if (event.kind !== 9 && event.kind !== 40002) return;
      const destinations = event.tags.filter(([name]) => name === "h");
      const id = destinations.length === 1 ? destinations[0]?.[1] : undefined;
      const hiddenAtSend = current.current.find((entry) => entry.id === id);
      if (!id || !hiddenAtSend) return;
      return () => {
        if (current.current.includes(hiddenAtSend)) show([id]);
      };
    });
    check();
    return () => {
      for (const stop of stops) stop();
      stopIncoming();
      stopOutgoing?.();
    };
  }, [hidden, session, show, update]);

  useEffect(() => {
    if (!hidden.length || list.status !== "ready") return;
    const controller = new AbortController();
    // The shared unread repair is roster-wide and capped. Check each hidden DM's
    // latest verified message so an offline arrival can restore it on return.
    void (async () => {
      for (const entry of hidden) {
        if (controller.signal.aborted) return;
        const { id } = entry;
        const channel = list.channels.find((item) => item.id === id);
        if (channel?.channelType !== "dm") continue;
        try {
          await session.read([{ kinds: [9, 40002], "#h": [id], limit: 1 }], {
            signal: controller.signal,
            priority: "background",
          });
          if (entry.baseline === undefined && current.current.includes(entry)) {
            const latest = session.unread.snapshot({
              kind: "channel",
              channelId: id,
            }).latestMessage;
            update(
              current.current.map((item) =>
                item === entry ? { ...item, baseline: latest ?? null } : item,
              ),
            );
          }
        } catch {
          // Live delivery and a later mount can still restore the row.
        }
      }
    })();
    return () => controller.abort();
  }, [hidden, session, list, update]);

  return { hiddenIds: new Set(hidden.map((entry) => entry.id)), hide };
}
