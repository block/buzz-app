import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { CacheSnapshot, VirtualizerHandle } from "virtua";
import { useConversationPresentation } from "../../conversation/ConversationPresentation";
import type { ConversationExtensions } from "../../conversation/contracts";
import { clientMetrics } from "../../developer/client-metrics";
import type { ChannelMessage, Profile } from "../../relay/contracts";
import type { RelaySession } from "../../relay/session";
import { bylineName } from "../message-grouping";
import { useReferenceDirectory } from "../ReferenceText";
import { calibrate, capable, environment } from "./environment";
import type { Context } from "./model";
import type { Placement } from "./placement";
import { bundled, EMOJI, type Inputs } from "./prose";
import { readProbe } from "./RowHeightProbe";

/** Synchronous model work past the rows that must be predicted. Cache hits
 * stay cheap; past it, rows that need parsing or preparing stay unknown, as
 * before predictions. */
const BUDGET_MS = 8;
/** Rows a new Virtualizer always predicts around where it lands. */
const FIRST_RANGE = 100;
/** Rows a length change always predicts: an older page (20) and, under a
 * shift, the former first row. */
const PAGE = 21;
/** ChannelTimeline's `bufferSize`. */
const BUFFER = 1600;
/** Narrower text columns can wrap day labels, which the model does not. */
const MIN_WIDTH = 200;
const noSubscribe = () => () => {};
const none: readonly never[] = [];
const noRenderers = () => none;
type Work = { ms: number; count: number };
type Commit = Readonly<{
  rows: readonly ChannelMessage[];
  placed: readonly Placement[];
  context: Context | undefined;
}>;

function predictAt(
  { rows, placed, context }: Commit,
  index: number,
  compute: boolean,
  work: Work,
) {
  const { model } = environment.snapshot();
  const row = rows[index];
  const at = placed[index];
  if (!model || !context || !row || !at) return undefined;
  const start = performance.now();
  const size = model.predict(row, at, context, compute);
  work.ms += performance.now() - start;
  work.count++;
  return size;
}
const known = (size: ReturnType<typeof predictAt>) =>
  typeof size === "number" ? size : undefined;
const record = (work: Work) => {
  if (work.count) clientMetrics.cpu("rows.predict", work.ms, work.count);
};

/** Predicted heights for ChannelTimeline's Virtualizer (docs/channels.md). */
export function useRowHeights({
  rows,
  placed,
  rowWidth,
  viewport,
  landing,
  handle,
  scroller,
  session,
  resolveName,
  profiles,
  canOpenLink,
  extensions,
}: {
  rows: readonly ChannelMessage[];
  placed: readonly Placement[];
  /** The list's width (the probe wrapper's), zero before layout. */
  rowWidth: number;
  viewport: number;
  /** The index the first range will show, for creation seeding order. */
  landing(): number;
  handle: RefObject<VirtualizerHandle | null>;
  scroller: RefObject<HTMLElement | null>;
  session?: RelaySession | undefined;
  resolveName(pubkey: string, fallback: string): string;
  profiles: ReadonlyMap<string, Profile>;
  canOpenLink?: ((target: string) => boolean) | undefined;
  extensions: ConversationExtensions | undefined;
}) {
  const env = useSyncExternalStore(
    environment.subscribe,
    environment.snapshot,
    environment.snapshot,
  );
  const active = useConversationPresentation();
  const messages = useSyncExternalStore(
    extensions?.messages?.subscribe ?? noSubscribe,
    extensions?.messages?.snapshot ?? noRenderers,
    noRenderers,
  );
  const inline = useSyncExternalStore(
    extensions?.inline.subscribe ?? noSubscribe,
    extensions?.inline.snapshot ?? noRenderers,
    noRenderers,
  );
  const links = useSyncExternalStore(
    extensions?.links?.subscribe ?? noSubscribe,
    extensions?.links?.snapshot ?? noRenderers,
    noRenderers,
  );
  // MessageRow's reference directory, with the timeline's profiles.
  const { channels, agents } = useReferenceDirectory(session, profiles);
  const inputs = useMemo<Inputs>(
    () => ({
      messages,
      inline,
      links,
      profiles,
      channels,
      agents,
      canOpenLink,
      resolveName,
    }),
    [
      messages,
      inline,
      links,
      profiles,
      channels,
      agents,
      canOpenLink,
      resolveName,
    ],
  );
  const { model, metrics, hover, fonts } = env;
  const width = metrics ? rowWidth - metrics.inset : 0;
  // Every height input outside `rows`; text stays cached by row identity.
  const context = useMemo<Context | undefined>(
    () =>
      model && metrics && active && hover && width >= MIN_WIDTH
        ? {
            metrics,
            width,
            inputs,
            fonts,
            name: (row) =>
              bylineName(row, profiles.get(row.authorId), resolveName),
          }
        : undefined,
    [
      model,
      metrics,
      active,
      hover,
      width,
      inputs,
      fonts,
      resolveName,
      profiles,
    ],
  );
  const unknown = !model
    ? "loading"
    : !metrics
      ? "uncalibrated"
      : !active
        ? "inactive"
        : !hover
          ? "no-hover"
          : "narrow";
  const probe = useRef<HTMLDivElement>(null);
  const committed = useRef<Commit | undefined>(undefined);
  const seeding = useRef(false);
  const seeds = useRef(new Map<string, number | undefined>());
  const counted = useRef(new Set<string>());
  const filled = useRef(new Set<ChannelMessage>());
  const reason = useRef(unknown);
  reason.current = unknown;

  const work: Work = { ms: 0, count: 0 };
  const render: Commit = { rows, placed, context };
  const creating = !handle.current;
  // Per Virtualizer: DEV sampling counts a row once per prediction, and the
  // fill predicts a row once.
  if (creating) {
    seeds.current.clear();
    counted.current.clear();
    filled.current.clear();
  }
  // A new Virtualizer asks for every index. Prepare text only around where it
  // lands: always a viewport on each side of the landing row, which covers
  // its first range, then the buffer it mounts within the budget; the rest
  // get only hits.
  let itemSize: number | undefined;
  if (creating && context && model && rowWidth > 0) {
    const rough = rows.map((row, index) => {
      const at = placed[index];
      return at ? model.estimate(row, at, context) : 0;
    });
    // Rows without a size take `itemSize` until Virtua's own estimate, the
    // median measured size of such rows, replaces it once they exceed the
    // viewport (patches/README.md). Those are the rows the model leaves to
    // measurement and every row of a page inserted without seeds. Until then
    // it is the median rough estimate of every row, whatever this render had
    // time to predict; one line in an empty window.
    itemSize =
      [...rough].sort((a, b) => a - b)[rough.length >> 1] ??
      context.metrics.single.timeline;
    const extent = viewport + BUFFER;
    const seed = (index: number) =>
      known(predictAt(render, index, true, work)) ?? rough[index] ?? 0;
    let above = 0;
    let below = 0;
    for (let up = landing(), down = up + 1; work.count < FIRST_RANGE; ) {
      const upward = up >= 0 && above < extent;
      const downward = down < rows.length && below < extent;
      if (!upward && !downward) break;
      const covered =
        (up < 0 || above >= viewport) &&
        (down >= rows.length || below >= viewport);
      if (covered && work.ms >= BUDGET_MS) break;
      if (upward) above += seed(up--);
      if (downward) below += seed(down++);
    }
  }
  // Only a Virtualizer created with `itemSize` gets the estimator, for its
  // lifetime. One created without a context (Pretext or a font loading at
  // launch, no hover) keeps Virtua's own estimate, which turns the buffer on
  // only once measurements that change cached sizes exceed the viewport. A
  // seeded row's measurement changes nothing, so seeding later rows of a
  // short window would keep its buffer off for good.
  const seeded = creating ? itemSize !== undefined : seeding.current;
  // Virtua calls this inside this render, with this render's indexes: at
  // creation for every row (hits only), then for the rows a length change
  // inserts and, under a shift, the former first row.
  const estimateSize = (index: number) => {
    const compute = !creating && (work.count < PAGE || work.ms < BUDGET_MS);
    const size = known(predictAt(render, index, compute, work));
    if (clientMetrics.enabled) seeds.current.set(rows[index]?.id ?? "", size);
    return size;
  };
  // Defined predictions replace a saved snapshot's entries, which can be
  // stale. Virtua reads `cache` only when it creates the Virtualizer.
  const cache = (snapshot: CacheSnapshot): CacheSnapshot => {
    if (!creating || !seeded) return snapshot;
    const [sizes, ...rest] = snapshot;
    return [sizes.map((size, index) => estimateSize(index) ?? size), ...rest];
  };

  // Calibrate in the layout phase of the commit that mounted the probe rows.
  useLayoutEffect(() => {
    const element = probe.current;
    if (element && !env.metrics) calibrate(() => readProbe(element));
  }, [env]);
  useLayoutEffect(() => {
    if (creating) seeding.current = seeded;
  }, [creating, seeded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `work` and `render` are this render's
  useLayoutEffect(() => {
    record(work);
    committed.current = render;
  }, [rows, placed, context]);

  // Once Virtua has measured (two frames after settle or scroll end). Rows it
  // mounted without a seed were measured instead: prepare those still mounted
  // within the budget, so a later Virtualizer (a switch back, at another
  // width) can seed them; rows passed mid-gesture are not. Then, in DEV,
  // compare each mounted row's height with its current prediction, observing
  // only: once per row and prediction in each Virtualizer, as aggregates.
  const idle = useCallback(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const current = committed.current;
        if (!current) return;
        const indexes = new Map(
          current.rows.map((row, index) => [row.id, index]),
        );
        const items = Array.from(
          scroller.current?.querySelectorAll<HTMLElement>(
            "[data-message-id]",
          ) ?? [],
          (item) =>
            [indexes.get(item.dataset.messageId ?? "") ?? -1, item] as const,
        );
        const spent: Work = { ms: 0, count: 0 };
        for (const [index] of items) {
          if (spent.ms >= BUDGET_MS) break;
          predictAt(current, index, true, spent);
        }
        record(spent);
        if (!clientMetrics.enabled) return;
        for (const [index, item] of items) {
          const row = current.rows[index];
          const at = current.placed[index];
          const li = item.parentElement;
          if (!row || !at || !li) continue;
          const outcome =
            predictAt(current, index, false, { ms: 0, count: 0 }) ??
            reason.current;
          const key = `${row.id}\u0000${outcome}`;
          if (counted.current.has(key)) continue;
          counted.current.add(key);
          clientMetrics.rowHeight(
            row.membership
              ? "membership"
              : `${at.layout}${at.day ? "+day" : ""}`,
            typeof outcome === "number"
              ? {
                  predicted: outcome,
                  measured: li.getBoundingClientRect().height,
                  seeded: seeds.current.get(row.id) === outcome,
                }
              : { reason: outcome },
          );
        }
      }),
    );
  }, [scroller]);
  // After a new Virtualizer is positioned and before reader input, one
  // budgeted idle slice: predict rows Virtua still has unmeasured and that are
  // not mounted, nearest the viewport first. With `write` (before the
  // timeline mounts its buffer) and once every row has been tried, set the
  // rows predicted so far in one `resize`, at their current index and
  // placement. Rows above the viewport are compensated out of sight, so they
  // mount at their size instead of hidden, and the reader's first scroll does
  // not correct them. At most two writes: on Mac WebKit each compensation
  // stops wheel input for about a frame (patches/README.md). True when done.
  const fill = useCallback(
    (write: boolean) => {
      const current = committed.current;
      const virtualizer = handle.current;
      if (!seeding.current || !current?.context || !virtualizer) return true;
      const [sizes] = virtualizer.cache;
      const mounted = new Set(
        Array.from(
          scroller.current?.querySelectorAll<HTMLElement>(
            "[data-message-id]",
          ) ?? [],
          (item) => item.dataset.messageId,
        ),
      );
      const open = (index: number) => {
        const row = current.rows[index];
        return row && sizes[index] === -1 && !mounted.has(row.id)
          ? row
          : undefined;
      };
      const spent: Work = { ms: 0, count: 0 };
      const visit = (index: number) => {
        const row = open(index);
        if (!row || filled.current.has(row)) return;
        filled.current.add(row);
        predictAt(current, index, true, spent);
      };
      let up = virtualizer.findItemIndex(virtualizer.scrollOffset);
      let down = up + 1;
      while ((up >= 0 || down < sizes.length) && spent.ms < BUDGET_MS) {
        visit(up--);
        visit(down++);
      }
      record(spent);
      const done = up < 0 && down >= sizes.length;
      const pairs: [number, number][] = [];
      const hits: Work = { ms: 0, count: 0 };
      for (let index = 0; (done || write) && index < sizes.length; index++) {
        const row = open(index);
        const size = row && known(predictAt(current, index, false, hits));
        if (!row || size === undefined) continue;
        pairs.push([index, size]);
        if (clientMetrics.enabled) seeds.current.set(row.id, size);
      }
      if (pairs.length) virtualizer.resize(pairs);
      return done;
    },
    [handle, scroller],
  );
  // The list's width, for the timeline's `measure` (its ResizeObserver).
  // While uncalibrated it also retries calibration: a probe hidden at the
  // epoch change (a retained pane) has no size until then.
  const rowWidthOf = useCallback(() => {
    const element = probe.current;
    if (!element) return 0;
    calibrate(() => readProbe(element), true);
    return element.getBoundingClientRect().width;
  }, []);

  return {
    /** Canvas text measurement exists; otherwise Virtua sizes rows itself. */
    enabled: capable,
    probe,
    /** Calibration rows render while the font epoch is uncalibrated. */
    calibrating: capable && !metrics,
    /** The bundled custom emoji renderer, for the calibration probe. */
    emoji: inline.find((entry) => bundled(entry, EMOJI)),
    /** The list's width from the probe wrapper, for the timeline's `measure`. */
    rowWidth: rowWidthOf,
    /** Virtualizer props. Virtua reads `itemSize` and `cache` only at
     * creation. */
    props(snapshot: CacheSnapshot | undefined) {
      if (!capable) return snapshot ? { cache: snapshot } : {};
      return {
        ...(snapshot ? { cache: cache(snapshot) } : {}),
        ...(itemSize === undefined ? {} : { itemSize }),
        ...(seeded ? { estimateSize } : {}),
        onScrollEnd: idle,
      };
    },
    /** The timeline positioned itself. */
    settled: idle,
    /** One idle slice of predictions before reader input; with `write` and
     * in the last slice it resizes, synchronously: call it outside React
     * render and effects. True when done. */
    fill,
  };
}
