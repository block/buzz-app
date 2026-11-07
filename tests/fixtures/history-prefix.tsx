import { getPublicKey } from "nostr-tools";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Actual conversation UI/session and folded events; no live identity or relay.
import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import {
  keypair,
  message,
  bounds,
  roster,
  metadata,
} from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";
declare global {
  interface Window {
    prependHistory(): void;
    loadSlidingOlder(): void;
    slidingHeldReads: number;
    lastSlidingAnchor: string | undefined;
    holdSlidingPage(before?: number): void;
    releaseSlidingPage(holdNext?: boolean, before?: number): void;
  }
}
const viewer = keypair(),
  relay = keypair();
const events = Array.from({ length: 121 }, (_, i) =>
  message(
    viewer,
    "images",
    `Message ${i}. ${"Reading stays in place. ".repeat(i % 4)}`,
    1700000000 + i,
  ),
);
const allRows = foldMessages("images", relay.pubkey, events);
function Fixture() {
  const [start, setStart] = useState(81);
  const [loading, setLoading] = useState(false);
  const rows = [...allRows.slice(0, 1), ...allRows.slice(start)];
  // As an older page does, rows land in the commit that ends a load.
  window.prependHistory = () => setLoading(true);
  useEffect(() => {
    if (!loading) return;
    setStart((n) => Math.max(1, n - 20));
    setLoading(false);
  }, [loading]);
  return (
    <div
      data-history-start={start}
      style={{
        height: 587,
        width: 1193,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ChannelTimeline
        scope="prepend-prefix"
        channelId="images"
        queries={owner.session}
        window={{
          channelId: "images",
          rows,
          status: "ready",
          hasMore: true,
          loadingOlder: loading,
          error: undefined,
          freshness: "fresh",
        }}
        onOpenLink={() => false}
      />
    </div>
  );
}
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => url,
  query: async () => [],
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
});
// A small real session budget makes both sliding edges observable without a scale fixture.
const sliding = new URLSearchParams(location.search).has("sliding");
const compact = new URLSearchParams(location.search).has("compact");
const dense = new URLSearchParams(location.search).has("dense");
const secret = new Uint8Array(32).fill(1);
const denseAuthor = { secret, pubkey: getPublicKey(secret) };
const densePayload = "x".repeat(128 * 1024);
const denseBody = "History remains readable. ".repeat(compact ? 0 : 40);
const slidingEvents = (
  dense
    ? [
        ...Array.from({ length: 79 }, (_, i) =>
          message(
            denseAuthor,
            "images",
            `dense${i}. ${denseBody}`,
            1700000000,
            [
              ["ms", "100"],
              ["metadata", densePayload],
            ],
          ),
        ),
        message(denseAuthor, "images", `anchor31. ${denseBody}`, 1700000000, [
          ["ms", "0"],
          ["metadata", densePayload],
        ]),
      ]
    : Array.from({ length: 140 }, (_, i) =>
        message(
          viewer,
          "images",
          `Message ${i}. ${"History remains readable. ".repeat(compact ? 0 : 8)}`,
          1700000000 + i,
        ),
      )
).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
let heldPage: Promise<void> | undefined;
let heldBefore: number | undefined;
let receiveSliding = (_events: typeof slidingEvents) => {};
window.holdSlidingPage = (before) => {
  heldBefore = before;
  window.slidingHeldReads = 0;
  heldPage = new Promise((resolve) => {
    window.releaseSlidingPage = (holdNext = false, before) => {
      heldPage = undefined;
      if (holdNext) window.holdSlidingPage(before);
      resolve();
    };
  });
};
const slidingOwner = sliding
  ? createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: (url) => url,
        query: async (filters) => {
          if (
            heldPage &&
            filters.some(
              (filter) =>
                filter.top_level &&
                (heldBefore === undefined ||
                  (filter.until !== undefined && filter.until <= heldBefore)),
            )
          ) {
            window.slidingHeldReads++;
            await heldPage;
          }
          return filters.flatMap((filter) => {
            if (filter.kinds?.includes(39002))
              return [roster(relay, "images", [viewer.pubkey])];
            if (filter.kinds?.includes(39000))
              return [metadata(relay, "images", "History")];
            if (!filter.top_level) return [];
            const after = slidingEvents.filter(
              (event) =>
                filter.until === undefined ||
                event.created_at < filter.until ||
                (event.created_at === filter.until &&
                  event.id > (filter.before_id ?? "")),
            );
            const rows = after.slice(0, filter.limit);
            const hasMore = after.length > rows.length;
            const last = rows.at(-1);
            return [
              ...rows,
              bounds(
                relay,
                "images",
                filter.until === undefined
                  ? "head"
                  : `${filter.until}:${filter.before_id}`,
                {
                  has_more: hasMore,
                  next_cursor:
                    hasMore && last
                      ? { created_at: last.created_at, id: last.id }
                      : null,
                },
              ),
            ];
          });
        },
        subscribe: (callbacks) => {
          receiveSliding = callbacks.receive;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      dense ? {} : { maxHistoryRows: 60 },
    )
  : undefined;
receiveSliding([
  roster(relay, "images", [viewer.pubkey]),
  metadata(relay, "images", "History"),
]);
const slidingQueries = slidingOwner
  ? {
      ...slidingOwner.session,
      channels: {
        ...slidingOwner.session.channels,
        loadOlder(channelId: string, anchorId?: string) {
          window.lastSlidingAnchor = anchorId;
          slidingOwner.session.channels.loadOlder(channelId, anchorId);
        },
      },
    }
  : undefined;
function SlidingFixture() {
  if (!slidingOwner) throw new Error("Missing sliding session");
  return <SlidingTimeline session={slidingOwner.session} />;
}
function SlidingTimeline({ session }: { session: typeof owner.session }) {
  const [ready, setReady] = useState(!dense);
  window.loadSlidingOlder = () => session.channels.loadOlder("images");
  const snapshot = useSyncExternalStore(
    (listener) => session.channels.subscribeWindow("images", listener),
    () => session.channels.window("images"),
  );
  useEffect(() => {
    session.channels.ensure("images");
  }, [session]);
  useEffect(() => {
    if (ready || snapshot.status !== "ready" || snapshot.loadingOlder) return;
    if (snapshot.rows.length >= 60) setReady(true);
    else session.channels.loadOlder("images");
  }, [session, snapshot, ready]);
  return (
    <div
      data-oldest={snapshot.rows[0]?.createdAt}
      data-newest={snapshot.rows.at(-1)?.createdAt}
      data-count={snapshot.rows.length}
      data-ids={snapshot.rows.map((row) => row.id).join(",")}
      data-has-more={snapshot.hasMore}
      data-has-newer={!!snapshot.hasNewer}
      data-anchor={
        dense
          ? "00ab65f8aff0e6bc80f47599a111f67cde3741b702d720b83a8805a8fd26db6c"
          : undefined
      }
      data-loading={!!snapshot.loadingOlder || !!snapshot.loadingNewer}
      style={{
        height: 650,
        width: 1193,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {ready && (
        <ChannelTimeline
          scope="sliding-history"
          revealMessageId={
            dense
              ? "00ab65f8aff0e6bc80f47599a111f67cde3741b702d720b83a8805a8fd26db6c"
              : undefined
          }
          {...(dense ? { historyControl: "scroll" as const } : {})}
          channelId="images"
          queries={slidingQueries ?? session}
          window={snapshot}
          onOpenLink={() => false}
        />
      )}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <ToastProvider>{sliding ? <SlidingFixture /> : <Fixture />}</ToastProvider>
  </StrictMode>,
);
