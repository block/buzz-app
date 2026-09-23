import { useCallback, useEffect, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelList } from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";

type MessageHead = Readonly<{ id: string; createdAt: number }>;
type HiddenDm = {
  id: string;
  baseline?: MessageHead | null;
  knownIds?: readonly string[];
};
const key = "hidden-dms";

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function restore(scope: string): HiddenDm[] {
  const saved = readView<unknown>(scope, key, []);
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string")
      return [];
    const baseline = entry.baseline;
    const knownIds = entry.knownIds;
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
        ...(Array.isArray(knownIds) &&
        knownIds.every((id): id is string => typeof id === "string")
          ? { knownIds }
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
  const hiddenKey = hidden.map((entry) => entry.id).join("\u0000");
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
        // The direct history read can distinguish an older arrival from a
        // deletion that exposed old history. A head rollback alone cannot.
        return [entry];
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
    if (!hiddenKey || list.status !== "ready") return;
    const controller = new AbortController();
    // The shared unread repair is roster-wide and capped. Compare a bounded
    // per-DM history window so a late-arriving message need not be the head.
    void (async () => {
      for (const id of hiddenKey.split("\u0000")) {
        if (controller.signal.aborted) return;
        const entry = current.current.find((item) => item.id === id);
        if (!entry) continue;
        const channel = list.channels.find((item) => item.id === id);
        if (channel?.channelType !== "dm") continue;
        for (
          let attempt = 0;
          attempt < 3 && !controller.signal.aborted;
          attempt++
        ) {
          try {
            const events = await session.read(
              [{ kinds: [9, 40002], "#h": [id], limit: 50 }],
              {
                signal: controller.signal,
                priority: "background",
              },
            );
            if (current.current.includes(entry)) {
              const latest = session.unread.snapshot({
                kind: "channel",
                channelId: id,
              }).latestMessage;
              const ids = events.map((event) => event.id);
              const changed =
                entry.knownIds &&
                ids.some((eventId) => !entry.knownIds?.includes(eventId));
              const deletedHead =
                entry.baseline &&
                !ids.includes(entry.baseline.id) &&
                latest &&
                (latest.createdAt < entry.baseline.createdAt ||
                  (latest.createdAt === entry.baseline.createdAt &&
                    latest.id > entry.baseline.id));
              if (changed && !deletedHead) {
                show([id]);
                break;
              }
              if (
                entry.baseline === undefined ||
                !entry.knownIds ||
                deletedHead
              )
                update(
                  current.current.map((item) =>
                    item === entry
                      ? {
                          ...item,
                          baseline: latest ?? null,
                          knownIds: ids,
                        }
                      : item,
                  ),
                );
            }
            break;
          } catch {
            if (attempt < 2) await pause(500 * 2 ** attempt, controller.signal);
          }
        }
      }
    })();
    return () => controller.abort();
  }, [hiddenKey, session, list, show, update]);

  return { hiddenIds: new Set(hidden.map((entry) => entry.id)), hide };
}
