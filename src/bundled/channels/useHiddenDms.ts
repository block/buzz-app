import { useCallback, useEffect, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { readView, writeView } from "../../shared/view-state";

type HiddenDm = { id: string; latestMessageId?: string };
const key = "hidden-dms";

function restore(scope: string): HiddenDm[] {
  const saved = readView<unknown>(scope, key, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter(
    (entry): entry is HiddenDm =>
      !!entry &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      (entry.latestMessageId === undefined ||
        typeof entry.latestMessageId === "string"),
  );
}

/** Local, viewer-scoped sidebar intent; verified message evidence restores a row. */
export function useHiddenDms(scope: string, session: RelaySession) {
  const [hidden, setHidden] = useState(() => restore(scope));
  const current = useRef(hidden);
  const update = useCallback(
    (next: HiddenDm[]) => {
      current.current = next;
      setHidden(next);
      writeView(scope, key, next);
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
          ...(latest ? { latestMessageId: latest.id } : {}),
        },
      ]);
    },
    [session, update],
  );

  useEffect(() => {
    if (!hidden.length) return;
    const check = () => {
      const resurfaced = current.current.flatMap((entry) => {
        const latest = session.unread.snapshot({
          kind: "channel",
          channelId: entry.id,
        }).latestMessage;
        return latest && latest.id !== entry.latestMessageId ? [entry.id] : [];
      });
      if (resurfaced.length) show(resurfaced);
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
  }, [hidden, session, show]);

  useEffect(() => {
    if (!hidden.length) return;
    const controller = new AbortController();
    // The shared unread repair is roster-wide and capped. Check each hidden DM's
    // latest verified message so an offline arrival can restore it on return.
    void (async () => {
      for (const { id } of hidden) {
        if (controller.signal.aborted) return;
        const channel = session.channels
          .list()
          .channels.find((item) => item.id === id);
        if (channel?.channelType !== "dm") continue;
        try {
          await session.read([{ kinds: [9, 40002], "#h": [id], limit: 1 }], {
            signal: controller.signal,
            priority: "background",
          });
        } catch {
          // Live delivery and a later mount can still restore the row.
        }
      }
    })();
    return () => controller.abort();
  }, [hidden, session]);

  return { hiddenIds: new Set(hidden.map((entry) => entry.id)), hide };
}
