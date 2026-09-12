import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { PresenceQueries } from "./directory";
import styles from "./Presence.module.css";

/** A selector, not a demand owner. Surfaces batch authors once for all their avatars. */
export function PresenceIndicator({
  presence,
  author,
  label = false,
}: {
  presence: PresenceQueries;
  author: string;
  label?: boolean;
}) {
  const subscribe = useCallback(
    (listener: () => void) => presence.subscribe(author, listener),
    [presence, author],
  );
  const snapshot = useCallback(() => presence.get(author), [presence, author]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);
  const text =
    status === "unknown"
      ? "Presence unknown"
      : status === "away"
        ? "Away"
        : status === "online"
          ? "Online"
          : "Offline";
  return (
    <span
      className={label ? styles.label : styles.indicator}
      title={text}
      aria-label={text}
      role="img"
      data-presence-status={status}
    >
      <span className={styles.dot} data-status={status} aria-hidden="true" />
      {label && <span aria-hidden="true">{text}</span>}
    </span>
  );
}

/** One demand handle per rendered surface. Intersection work never runs per heartbeat. */
export function usePresenceSurface(
  presence: PresenceQueries,
  root: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const demand = presence.demand();
    const visible = new Set<Element>();
    const watched = new Set<Element>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const flush = () => {
      timer = undefined;
      if (closed) return;
      const authors =
        document.visibilityState === "hidden"
          ? []
          : [...visible].flatMap((row) => {
              const author = row.getAttribute("data-presence-author");
              return author && element.contains(row) ? [author] : [];
            });
      const accepted = demand.update(authors);
      if (accepted) element.removeAttribute("data-presence-limited");
      else element.setAttribute("data-presence-limited", "true");
    };
    const schedule = () => {
      if (!closed && !timer) timer = setTimeout(flush, 100);
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (changes) => {
              for (const change of changes) {
                if (change.isIntersecting) visible.add(change.target);
                else visible.delete(change.target);
              }
              schedule();
            },
            { root: element, rootMargin: "160px" },
          );
    const scan = () => {
      const rows = new Set(element.querySelectorAll("[data-presence-author]"));
      for (const row of watched)
        if (!rows.has(row)) {
          watched.delete(row);
          visible.delete(row);
          observer?.unobserve(row);
        }
      for (const row of rows)
        if (!watched.has(row)) {
          watched.add(row);
          if (observer) observer.observe(row);
          else visible.add(row); // Bounded rendered-window fallback, never complete history.
        }
      schedule();
    };
    const mutation = new MutationObserver((changes) => {
      if (
        changes.some((change) =>
          [...change.addedNodes, ...change.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches("[data-presence-author]") ||
                node.querySelector("[data-presence-author]")),
          ),
        )
      )
        scan();
    });
    mutation.observe(element, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", schedule);
    scan();
    return () => {
      closed = true;
      clearTimeout(timer);
      observer?.disconnect();
      mutation.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      demand.dispose();
      element.removeAttribute("data-presence-limited");
    };
  }, [presence, root]);
}

export function usePresenceDemand(presence: PresenceQueries, author: string) {
  useEffect(() => {
    const demand = presence.demand();
    const update = () =>
      demand.update(document.visibilityState === "hidden" ? [] : [author]);
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      demand.dispose();
    };
  }, [presence, author]);
}
