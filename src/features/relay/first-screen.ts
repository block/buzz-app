import { openTrace } from "../developer/open-trace";
import {
  membershipDescription,
  membershipRows,
} from "../messages/membership-rows";
import type { ChannelMessage } from "./contracts";
import { ALLOW_LATE_NAMES } from "./late-names";
import { rowProfileIds } from "./membership";

/** Displayed rows a channel's first screen can show: more than a tall window
 * fits at the smallest row height, so no name on screen waits on rows out of
 * view. */
export const SCREEN_ROWS = 40;
/** How long a screen whose rows are here waits for the names they show. Past
 * it the screen paints with the names it has, once. */
export const NAMES_DEADLINE_MS = 500;
/** How long a gather waits for names once its head is in. With late names
 * allowed (a temporary exception, see `late-names.ts`), only until the names
 * already held answer: one task. The names read keeps going and fills in the
 * rest after the paint. */
const namesWait = ALLOW_LATE_NAMES ? 0 : NAMES_DEADLINE_MS;
/** Hovered channels gathering at once. A hover past it cancels the oldest:
 * the pointer has moved on from it. Well below the session's read slots
 * (`ACTIVE_READS`), so an open's own reads never queue behind hovers. */
export const SPECULATIVE_RUNS = 2;

/** The people a first screen shows on `rows` (chronological): every identity
 * a message row renders, and for a run of membership notices only those its
 * one line names and its avatars show. Its popover's full list is read when
 * opened. */
export function screenProfileIds(
  rows: readonly ChannelMessage[],
): readonly string[] {
  const ids = new Set<string>();
  for (const row of membershipRows(rows).slice(-SCREEN_ROWS)) {
    if (!row.membership) {
      for (const id of rowProfileIds(row)) ids.add(id);
      continue;
    }
    const { targets, parts } = membershipDescription(
      row.membershipRows ?? [row],
      new Map(),
    );
    for (const id of targets.slice(0, 3)) ids.add(id);
    for (const part of parts) if (part.id) ids.add(part.id);
  }
  return [...ids];
}

/** What a channel's first screen reads, as one open asks for it. Today the
 * store fills it from two relay reads; a first-screen endpoint can fill both
 * from one request, resolving `names` with the head. */
export type FirstScreenInputs<Head> = Readonly<{
  /** The channel's newest rows. Rejects when they cannot be read. */
  head: Promise<Head>;
  /** Resolves once the directory names (or knows unnamed) everyone `head`
   * shows on screen. Never rejects. */
  names(head: Head): Promise<void>;
}>;

export type FirstScreenSource<Head> = Readonly<{
  /** A complete screen the store holds: rows, with the names they show, that
   * it keeps current or saved. A memory open or a reload, which paints on its
   * first commit. Newer rows arrive after it as new messages. */
  held(channelId: string): Head | undefined;
  /** Start reading the inputs for one open. `speculative` is a hover or
   * focus, which may never become an open. */
  read(
    channelId: string,
    signal: AbortSignal,
    speculative: boolean,
  ): FirstScreenInputs<Head>;
  /** Moves on access changes, cache clears and stream drops: runs from
   * before are stale. */
  generation(channelId: string): string;
  /** A run for `channelId` finished with `screen`. */
  gathered(screen: FirstScreen<Head>): void;
  /** An open's run went stale before it finished (its generation moved):
   * the open starts again under the new one, if it still waits. */
  retired?(channelId: string): void;
}>;

/** One open's first screen, gathered: what the timeline shows, once. */
export type FirstScreen<Head> = Readonly<{
  channelId: string;
  head: Head | undefined;
  /** Everyone on screen is named or known unnamed. False when the deadline
   * cut the names read. */
  named: boolean;
  error?: unknown;
}>;

/** Read state for one row, as `newMessagesLine` needs it. */
export type RowAttention = Readonly<{
  status: "unknown" | "ineligible" | "eligible";
  pending?: boolean | undefined;
  unread: boolean;
  forced: boolean;
  /** A channel-wide read reaches this row, and every older ordinary one. */
  prefixRead?: true | undefined;
}>;

/** Where the New messages line goes on a first screen of `rows`
 * (chronological): above the first unread row that follows a read one, or
 * above the first unread row when `complete` (the channel's whole history is
 * on screen). Undefined for no line, including when a row's read state is not
 * known: a line is placed from what is held and never waits. */
export function newMessagesLine(
  rows: readonly ChannelMessage[],
  viewer: string,
  complete: boolean,
  attention: (messageId: string) => RowAttention,
): string | undefined {
  let afterRead = complete;
  for (const row of rows) {
    // Only rows that can be unread define a boundary.
    if (
      row.membership ||
      row.huddle ||
      row.audience === "agents" ||
      row.authorId === viewer
    )
      continue;
    const state = attention(row.id);
    if (state.status === "unknown" || state.pending) return undefined;
    if (state.forced || state.unread) return afterRead ? row.id : undefined;
    if (state.prefixRead) afterRead = true;
  }
  return undefined;
}

type Run<Head> = {
  channelId: string;
  generation: string;
  controller: AbortController;
  speculative: boolean;
  /** Set once gathered. */
  screen?: FirstScreen<Head>;
};

/** Gathers each opening's first screen in one procedure: the head and the
 * names its screen shows, handed over once as the screen the timeline shows.
 * The store places its New messages line on the rows it shows. A hover or press starts it; the open joins the run still going. */
export function createFirstScreens<Head>(source: FirstScreenSource<Head>) {
  const runs = new Map<string, Run<Head>>();
  const current = (run: Run<Head>) =>
    runs.get(run.channelId) === run &&
    run.generation === source.generation(run.channelId);

  async function gather(run: Run<Head>): Promise<FirstScreen<Head>> {
    const { channelId } = run;
    const { signal } = run.controller;
    const inputs = source.read(channelId, signal, run.speculative);
    const reading = openTrace.span("local", "first-screen.head", {}, channelId);
    const head = await inputs.head;
    reading();
    signal.throwIfAborted();
    let named = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const naming = inputs.names(head).then(() => {
      named = true;
    });
    await Promise.race([
      naming,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, namesWait);
      }),
    ]);
    clearTimeout(timer);
    signal.throwIfAborted();
    if (!named)
      openTrace.mark("local", "first-screen.partial", { named }, channelId);
    return { channelId, head, named };
  }

  function begin(channelId: string, speculative: boolean): Run<Head> {
    runs.get(channelId)?.controller.abort();
    const run: Run<Head> = {
      channelId,
      generation: source.generation(channelId),
      controller: new AbortController(),
      speculative,
    };
    runs.set(channelId, run);
    const done = openTrace.span(
      "local",
      "first-screen",
      { speculative },
      channelId,
    );
    void gather(run)
      .catch(
        (error: unknown): FirstScreen<Head> => ({
          channelId,
          head: undefined,
          named: false,
          error,
        }),
      )
      .then((screen) => {
        done({
          named: screen.named,
          ...(screen.error !== undefined
            ? { error: String(screen.error) }
            : {}),
        });
        if (!current(run)) {
          if (runs.get(channelId) !== run) return;
          runs.delete(channelId);
          if (!run.speculative) source.retired?.(channelId);
          return;
        }
        runs.delete(channelId);
        run.screen = screen;
        // A hover's failed read is not an open's: the open reads again.
        if (run.speculative && screen.error !== undefined) return;
        source.gathered(screen);
      });
    return run;
  }

  /** A hover past the limit cancels the oldest hover still gathering. */
  function admitSpeculative() {
    const speculative = [...runs.values()].filter((run) => run.speculative);
    for (const run of speculative.slice(
      0,
      Math.max(0, speculative.length - SPECULATIVE_RUNS + 1),
    )) {
      run.controller.abort();
      runs.delete(run.channelId);
    }
  }

  return {
    /** Start or join `channelId`'s run. Returns the screen when it is
     * already complete (a memory open), else undefined: `gathered` hands it
     * over. `speculative` is a hover or focus; an open or press is not. */
    start(
      channelId: string,
      speculative = false,
    ): FirstScreen<Head> | undefined {
      const run = runs.get(channelId);
      if (run && current(run)) {
        if (!speculative && run.speculative) {
          run.speculative = false;
          openTrace.mark("local", "first-screen.joined", {}, channelId);
        }
        return undefined;
      }
      const head = source.held(channelId);
      if (head) {
        openTrace.mark("local", "first-screen.held", {}, channelId);
        return {
          channelId,
          head,
          named: true,
        };
      }
      if (speculative) admitSpeculative();
      begin(channelId, speculative);
      return undefined;
    },
    /** Whether a run for `channelId` is still gathering. */
    gathering(channelId: string) {
      const run = runs.get(channelId);
      return !!run && current(run);
    },
    /** Channels with a run gathering. */
    channels(): string[] {
      return [...runs.keys()];
    },
    /** Stop `channelId`'s run once its generation has moved: an open's
     * starts again under the new one (see `retired`). */
    retire(channelId: string) {
      runs.get(channelId)?.controller.abort();
    },
    forget(channelId?: string) {
      for (const [id, run] of runs)
        if (channelId === undefined || id === channelId) {
          run.controller.abort();
          runs.delete(id);
        }
    },
  };
}
