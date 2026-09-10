// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The history region must support keyboard scrolling.
import type { ConversationExtensions } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { MessageRow } from "./MessageRow";
import type { ChannelWindow } from "../relay/contracts";
import { useRowProfiles } from "../relay/react";
import { geometryFor, geometrySignature } from "./geometry";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";

const EDGE_HEIGHT = 56;
type ReadingPosition = {
  offset: number;
  bottom: boolean;
  anchor?: { id: string; y: number };
};
function positionAt(element: HTMLElement): ReadingPosition {
  const top = element.getBoundingClientRect().top;
  const mounted = Array.from(
    element.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  // Prefer a whole visible message over a partly clipped row whose wrapping may change.
  const row =
    mounted.find((row) => {
      const text = row.querySelector("p")?.getBoundingClientRect();
      return (
        text && text.top >= top && text.bottom <= top + element.clientHeight
      );
    }) ?? mounted.find((row) => row.getBoundingClientRect().bottom > top);
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
  queries: RelaySession;
  window: ChannelWindow;
  onOpenLink(url: string): boolean;
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
  queries,
  window,
  onOpenLink,
  revealMessageId,
  onOpenThread,
}: ChannelTimelineProps) {
  const [initialPosition] = useState(() =>
    readView<ReadingPosition | null>(scope, `scroll:${channelId}`, null),
  );
  const savedPosition = useRef(initialPosition);
  const rows = window.rows;
  const profiles = useRowProfiles(queries.profiles, rows);
  const geometry = useMemo(() => geometryFor(queries.channels), [queries]);
  const signature = useMemo(
    () => geometrySignature(rows, profiles),
    [rows, profiles],
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
  const settled = useRef(false),
    userScrolled = useRef(false),
    follow = useRef(true);
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
  useLayoutEffect(() => {
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
    const frame = requestAnimationFrame(() => {
      if (intent.current === scheduledIntent && handle.current) {
        if (
          !settled.current &&
          savedPosition.current &&
          !savedPosition.current.bottom
        ) {
          const anchor = savedPosition.current.anchor;
          const index = anchor
            ? rows.findIndex((row) => row.id === anchor.id)
            : -1;
          if (anchor && index >= 0)
            handle.current.scrollToIndex(index, {
              align: "start",
              offset: -anchor.y,
            });
          else handle.current.scrollTo(savedPosition.current.offset);
          follow.current = false;
        } else handle.current.scrollToIndex(rows.length - 1, { align: "end" });
      }
      settled.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, size, prepend]);
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!width || !revealMessageId || revealed.current === revealMessageId)
      return;
    const index = rows.findIndex((row) => row.id === revealMessageId);
    if (index < 0) return;
    // A local send is explicit navigation intent, even when reading older messages.
    // Wait for the optimistic row and virtualizer to mount before revealing it.
    const frame = requestAnimationFrame(() => {
      if (!handle.current) return;
      follow.current = true;
      userScrolled.current = false;
      handle.current.scrollToIndex(index, { align: "end" });
      revealed.current = revealMessageId;
    });
    return () => cancelAnimationFrame(frame);
  }, [revealMessageId, rows, width]);
  const loadNearTop = (element: HTMLElement) => {
    if (
      handle.current &&
      userScrolled.current &&
      window.hasMore &&
      !window.historyLimited &&
      !window.loadingOlder &&
      !window.error &&
      element.scrollTop < Math.max(3000, element.clientHeight * 4)
    )
      queries.channels.loadOlder(channelId);
  };
  const gesture = () => {
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
          savedPosition.current = positionAt(element);
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
            onClick={() => queries.channels.loadOlder(channelId)}
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
          {rows.map((row, index) => (
            <MessageRow
              key={row.id}
              row={row}
              extensions={extensions}
              profile={profiles.get(row.authorId)}
              participantProfiles={profiles}
              media={queries.media}
              onOpenLink={onOpenLink}
              onOpenThread={onOpenThread}
              retry={queries.outbox?.retry}
              day={
                index === 0 ||
                new Date(
                  (rows[index - 1]?.createdAt ?? 0) * 1000,
                ).toDateString() !==
                  new Date(row.createdAt * 1000).toDateString()
              }
            />
          ))}
        </Virtualizer>
      )}
      {!rows.length && !window.hasMore && (
        <p className={styles.empty}>No messages yet.</p>
      )}
    </section>
  );
}
