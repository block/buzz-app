// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The history region must support keyboard scrolling.
import { MembershipRow } from "./MembershipRow";
import { membershipRows } from "./membership-rows";
import type { ConversationExtensions } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { MessageRow } from "./MessageRow";
import type { ChannelWindow } from "../relay/contracts";
import { useRowProfiles } from "../relay/react";
import { geometryFor, geometrySignature } from "./geometry";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { useReading } from "./use-reading";
import { messageViewKey } from "./view-key";

const EDGE_HEIGHT = 56;
type ReadingPosition = {
  offset: number;
  bottom: boolean;
  anchor?: { id: string; y: number };
};
function positionAt(
  element: HTMLElement,
  restoredAnchor?: string,
): ReadingPosition {
  const top = element.getBoundingClientRect().top;
  const mounted = Array.from(
    element.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  // A resize restoration keeps its chosen message even if wrapping makes its
  // paragraph taller than the viewport. Only a new gesture chooses a new anchor.
  const restored = mounted.find((row) => {
    const rect = row.getBoundingClientRect();
    return (
      row.dataset.messageId === restoredAnchor &&
      rect.bottom > top &&
      rect.top < top + element.clientHeight
    );
  });
  // Otherwise prefer a whole visible message over a partly clipped row.
  const row =
    restored ??
    mounted.find((row) => {
      const text = row.querySelector("p")?.getBoundingClientRect();
      return (
        text && text.top >= top && text.bottom <= top + element.clientHeight
      );
    }) ??
    mounted.find((row) => row.getBoundingClientRect().bottom > top);
  return {
    offset: element.scrollTop,
    bottom:
      element.scrollHeight - element.clientHeight - element.scrollTop < 80,
    ...(row?.dataset.messageId
      ? {
          anchor: {
            id: row.dataset.messageId,
            y: row.getBoundingClientRect().top - top,
          },
        }
      : {}),
  };
}
export type ChannelTimelineProps = {
  extensions?: ConversationExtensions | undefined;
  channelId: string;
  scope: string;
  viewer?: string | undefined;
  queries: RelaySession;
  window: ChannelWindow;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  onOpenThread?(messageId: string): void;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ChannelTimeline(props: ChannelTimelineProps) {
  return (
    <Timeline
      key={messageViewKey(props.queries, props.scope, props.channelId)}
      {...props}
    />
  );
}
function Timeline({
  channelId,
  extensions,
  scope,
  viewer,
  queries,
  window,
  onOpenLink,
  canOpenLink,
  revealMessageId,
  onOpenThread,
}: ChannelTimelineProps) {
  const [initialPosition] = useState(() =>
    readView<ReadingPosition | null>(scope, `scroll:${channelId}`, null),
  );
  const savedPosition = useRef(initialPosition);
  const restoredAnchor = useRef<string | undefined>(undefined);
  const rows = useMemo(() => membershipRows(window.rows), [window.rows]);
  const profiles = useRowProfiles(queries.profiles, window.rows);
  const geometry = useMemo(() => geometryFor(queries.channels), [queries]);
  const signature = useMemo(
    () => geometrySignature(window.rows, profiles),
    [window.rows, profiles],
  );
  const scroller = useRef<HTMLElement>(null);
  const handle = useRef<VirtualizerHandle>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = size.width;
  const latest = useRef({ signature, width });
  latest.current = { signature, width };
  const initialCache = useRef<VirtualizerHandle["cache"] | undefined>(
    undefined,
  );
  const edges = useRef<{
    first?: string | undefined;
    last?: string | undefined;
  }>({});
  const intent = useRef(0);
  const olderDemand = useRef(false);
  const settled = useRef(false),
    userScrolled = useRef(false),
    follow = useRef(true);
  useReading({ session: queries, channelId, scroller, settled });
  const prepend =
    !!edges.current.first &&
    edges.current.first !== rows[0]?.id &&
    edges.current.last === rows.at(-1)?.id;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measured = element.clientWidth;
    initialCache.current = geometry.get(
      channelId,
      latest.current.signature,
      measured,
    );
    let measuredSize = { width: 0, height: 0 };
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (
        next.width === measuredSize.width &&
        next.height === measuredSize.height
      )
        return;
      measuredSize = next;
      settled.current = false;
      setSize(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      olderDemand.current = false;
      settled.current = false;
      writeView(scope, `scroll:${channelId}`, savedPosition.current);
      observer.disconnect();
      if (handle.current)
        geometry.set(
          channelId,
          latest.current.signature,
          latest.current.width,
          handle.current.cache,
        );
    };
    // Initial signature only; mutations invalidate the saved cache on remount.
  }, [channelId, geometry, scope]);
  const previousSize = useRef(size);
  useLayoutEffect(() => {
    const resized =
      previousSize.current.width > 0 &&
      previousSize.current.height > 0 &&
      previousSize.current !== size;
    previousSize.current = size;
    // Row updates include edits/reactions/replies, not only new message IDs.
    // Above-bottom reading and prepend anchoring remain Virtua's responsibility.
    edges.current = { first: rows[0]?.id, last: rows.at(-1)?.id };
    if (
      !size.width ||
      !size.height ||
      !rows.length ||
      (settled.current && (!follow.current || prepend))
    )
      return;
    // virtua attaches its scroller in an effect; wait through the StrictMode probe.
    // A new gesture wins over restoration queued before that gesture.
    const scheduledIntent = intent.current;
    let observer: ResizeObserver | undefined;
    let frame = requestAnimationFrame(() => {
      if (intent.current === scheduledIntent && handle.current) {
        if (
          !settled.current &&
          savedPosition.current &&
          !savedPosition.current.bottom
        ) {
          const anchor = savedPosition.current.anchor;
          const index = anchor
            ? rows.findIndex(
                (row) =>
                  row.id === anchor.id ||
                  row.membershipRows?.some((member) => member.id === anchor.id),
              )
            : -1;
          if (anchor && index >= 0) {
            restoredAnchor.current = anchor.id;
            handle.current.scrollToIndex(index, {
              align: "start",
              offset: -anchor.y,
            });
          } else handle.current.scrollTo(savedPosition.current.offset);
          follow.current = false;
        } else {
          handle.current.scrollToIndex(rows.length - 1, { align: "end" });
          // Width changes can produce row measurements after Virtua's scroll
          // scheduler expires. Keep this restoration's bottom intent through
          // measured list reflow, never through a new gesture or row update.
          const list = resized ? scroller.current?.querySelector("ol") : null;
          if (list) {
            observer = new ResizeObserver(() => {
              cancelAnimationFrame(frame);
              frame = requestAnimationFrame(() => {
                if (intent.current === scheduledIntent)
                  handle.current?.scrollToIndex(rows.length - 1, {
                    align: "end",
                  });
              });
            });
            observer.observe(list);
          }
        }
      }
      settled.current = true;
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [rows, size, prepend]);
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!width || !revealMessageId || revealed.current === revealMessageId)
      return;
    const index = rows.findIndex(
      (row) =>
        row.id === revealMessageId ||
        row.membershipRows?.some((member) => member.id === revealMessageId),
    );
    if (index < 0) return;
    // A local send is explicit navigation intent, even when reading older messages.
    // Wait for the optimistic row and virtualizer to mount before revealing it.
    const frame = requestAnimationFrame(() => {
      if (!handle.current) return;
      follow.current = true;
      restoredAnchor.current = undefined;
      userScrolled.current = false;
      handle.current.scrollToIndex(index, { align: "end" });
      revealed.current = revealMessageId;
    });
    return () => cancelAnimationFrame(frame);
  }, [revealMessageId, rows, width]);
  const loadNearTop = useCallback(
    (element: HTMLElement, resume = false) => {
      olderDemand.current = false;
      if (
        !handle.current ||
        !userScrolled.current ||
        window.status !== "ready" ||
        !window.hasMore ||
        window.historyLimited ||
        window.loadingOlder ||
        window.error ||
        element.scrollTop >= Math.max(3000, element.clientHeight * 4)
      )
        return;
      // Cached does not mean blocked: disconnected windows can still page over
      // HTTP. Try ordinary demand first, retaining only a blocked cached gesture.
      // A retained gesture waits for verification, not every cached row update.
      if (resume && window.freshness === "cached") {
        olderDemand.current = true;
        return;
      }
      queries.channels.loadOlder(channelId);
      const after = queries.channels.window(channelId);
      olderDemand.current =
        window.freshness === "cached" &&
        after.status === "ready" &&
        after.hasMore &&
        !after.loadingOlder &&
        !after.historyLimited &&
        !after.error;
    },
    [window, queries, channelId],
  );
  useLayoutEffect(() => {
    if (olderDemand.current && scroller.current)
      loadNearTop(scroller.current, true);
  }, [loadNearTop]);
  const gesture = () => {
    restoredAnchor.current = undefined;
    intent.current++;
    userScrolled.current = true;
    // At a restored top edge, input cannot move the DOM and emits no scroll.
    if (scroller.current && scroller.current.scrollTop <= 0)
      loadNearTop(scroller.current);
  };
  return (
    <section
      ref={scroller}
      className={styles.feed}
      data-channel-timeline={channelId}
      onWheel={gesture}
      onTouchMove={gesture}
      onKeyDown={gesture}
      onPointerDown={gesture}
      tabIndex={0}
      aria-label="Channel message history"
      onScroll={(event) => {
        // React may receive this event before Virtua updates its handle metrics.
        const element = event.currentTarget;
        const v = handle.current;
        if (
          v &&
          settled.current &&
          element.clientWidth === size.width &&
          element.clientHeight === size.height
        ) {
          savedPosition.current = positionAt(element, restoredAnchor.current);
          follow.current = savedPosition.current.bottom;
        }
        loadNearTop(element);
      }}
    >
      <div className={styles.edge}>
        {window.error && <span role="alert">{window.error}</span>}
        {window.historyLimited ? (
          <span>History window limit reached</span>
        ) : window.hasMore ? (
          <button
            type="button"
            disabled={window.loadingOlder}
            onClick={() => {
              queries.channels.loadOlder(channelId);
              const after = queries.channels.window(channelId);
              if (after.loadingOlder || after.error || after.status !== "ready")
                olderDemand.current = false;
            }}
          >
            {window.loadingOlder ? "Loading older…" : "Load older messages"}
          </button>
        ) : null}
      </div>
      {width > 0 && (
        <Virtualizer
          ref={handle}
          scrollRef={scroller}
          shift={prepend}
          bufferSize={1600}
          as="ol"
          item="li"
          startMargin={EDGE_HEIGHT}
          {...(initialCache.current ? { cache: initialCache.current } : {})}
        >
          {rows.map((row, index) => {
            const day =
              index === 0 ||
              new Date(
                (rows[index - 1]?.createdAt ?? 0) * 1000,
              ).toDateString() !==
                new Date(row.createdAt * 1000).toDateString();
            return row.membership ? (
              <MembershipRow
                key={row.id}
                row={row}
                profiles={profiles}
                viewer={viewer}
                media={queries.media}
                day={day}
              />
            ) : (
              <MessageRow
                key={row.id}
                row={row}
                unread={queries.unread}
                extensions={extensions}
                profile={profiles.get(row.authorId)}
                participantProfiles={profiles}
                media={queries.media}
                onOpenLink={onOpenLink}
                canOpenLink={canOpenLink}
                onOpenThread={onOpenThread}
                retry={queries.outbox?.retry}
                day={day}
              />
            );
          })}
        </Virtualizer>
      )}
      {!rows.length && !window.hasMore && (
        <p className={styles.empty}>No messages yet.</p>
      )}
    </section>
  );
}
