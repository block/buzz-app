import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
export type { LatestMessage } from "../relay/channel-previews";

/** Session-owned read evidence and current message projection. */
export function useLatestMessages(
  session: RelaySession,
  wanted: readonly string[],
) {
  const previews = session.channelPreviews;
  const snapshot = useSyncExternalStore(
    previews.subscribe,
    previews.snapshot,
    previews.snapshot,
  );
  const key = [...new Set(wanted)].sort().join(",");
  useEffect(
    () => previews.retain(key.split(",").filter(Boolean)),
    [previews, key],
  );
  return snapshot;
}

/** Observe actual rows, including those without preview evidence yet. Filters
 * needing the latest author can explicitly demand their candidate ids. */
export function useVisibleChannelPreviews(
  session: RelaySession,
  required: readonly string[] = [],
) {
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const targets = useRef(new Set<HTMLLIElement>());
  const observer = useRef<IntersectionObserver>(undefined);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const current = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.activityRow;
            if (id) entry.isIntersecting ? next.add(id) : next.delete(id);
          }
          return next;
        });
      },
      { rootMargin: "120px" },
    );
    observer.current = current;
    for (const target of targets.current) current.observe(target);
    return () => {
      current.disconnect();
      observer.current = undefined;
    };
  }, []);
  const observe = useCallback((element: HTMLLIElement | null) => {
    if (!element) return;
    targets.current.add(element);
    observer.current?.observe(element);
    return () => {
      targets.current.delete(element);
      observer.current?.unobserve(element);
      const id = element.dataset.activityRow;
      setVisible((previous) => {
        if (!id || !previous.has(id)) return previous;
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    };
  }, []);
  const latest = useLatestMessages(session, [...visible, ...required]);
  return { latest, observe };
}
