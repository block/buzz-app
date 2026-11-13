import { useEffect, useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { ThreadView } from "../../features/relay/threads";

export type LaneMessage = { message?: ChannelMessage; error?: string };

/** Reuse the thread reader's access, edit/delete and newest-window semantics.
 * At most four short-lived views; refresh affected lanes on live messages, never poll. */
export function useLaneMessages(
  session: RelaySession,
  channel: string,
  rootsKey: string,
  reload: number,
) {
  const [messages, setMessages] = useState<Record<string, LaneMessage>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload explicitly refreshes the displayed snapshots.
  useEffect(() => {
    const roots = new Set(rootsKey.split(":").filter(Boolean));
    const queue = new Set(roots);
    const active = new Map<string, ThreadView>();
    const latestIds = new Map<string, string>();
    let disposed = false;
    setMessages({});
    async function drain() {
      while (!disposed && active.size < 4) {
        const root = [...queue].find((id) => !active.has(id));
        if (!root) return;
        queue.delete(root);
        let view: ThreadView;
        try {
          view = session.thread(channel, root, { priority: "background" });
        } catch {
          setMessages((current) => ({
            ...current,
            [root]: { error: "Message unavailable. Use Reload to retry." },
          }));
          continue;
        }
        active.set(root, view);
        void (async () => {
          try {
            await view.refresh();
            if (disposed) return;
            const snapshot = view.snapshot();
            if (snapshot.status !== "ready")
              throw new Error(
                snapshot.error ?? "Message unavailable. Use Reload to retry.",
              );
            const message = snapshot.replies.at(-1) ?? snapshot.root;
            if (message) latestIds.set(root, message.id);
            setMessages((current) => ({
              ...current,
              [root]: message ? { message } : {},
            }));
          } catch {
            if (!disposed)
              setMessages((current) => ({
                ...current,
                [root]: { error: "Message unavailable. Use Reload to retry." },
              }));
          } finally {
            view.dispose();
            active.delete(root);
            void drain();
          }
        })();
      }
    }
    const stop = session.subscribeLive?.(
      ({ events }) => {
        for (const event of events) {
          if (
            !event.tags.some(
              ([name, value]) => name === "h" && value === channel,
            )
          )
            continue;
          if (![9, 40002, 40003, 5, 9005].includes(event.kind)) continue;
          const references = new Set(
            event.tags.filter(([name]) => name === "e").map((tag) => tag[1]),
          );
          for (const root of roots) {
            if (
              event.id === root ||
              references.has(root) ||
              references.has(latestIds.get(root))
            )
              queue.add(root);
          }
        }
        void drain();
      },
      { replay: true },
    );
    void drain();
    return () => {
      disposed = true;
      stop?.();
      queue.clear();
      for (const view of active.values()) view.dispose();
    };
  }, [session, channel, rootsKey, reload]);
  return messages;
}
