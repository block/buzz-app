// What links last showed of pull requests and issues, kept on this device so
// a link opens with its title and state rather than waiting for GitHub, and
// the store reads it again in the background.
import type { PullState } from "./pull-states";

const key = "buzz.github.link-states.v1";
/** How many are kept; those read longest ago are let go first. */
export const REMEMBERED_STATES = 500;
/** One read again unchanged is saved again only this long after, so a link
 * polled each minute does not rewrite them all each minute. */
export const RESAVE_MS = 5 * 60_000;

/** What a link shows: its state, title, review, checks and conflicts. */
export type RememberedState = Pick<
  PullState,
  "state" | "reason" | "title" | "review" | "checks" | "conflicts"
>;

export type RememberedStates = Readonly<{
  /** What was last read of `url`, keyed as the store keys it. One object
   * for each until it is read again, so a reader that shows it is left be. */
  get(url: string): PullState | undefined;
  /** When that was read. */
  readAt(url: string): number | undefined;
  /** Keeps what was read of each, at `at`, and saves them. */
  remember(read: readonly (readonly [string, PullState])[], at: number): void;
  /** Lets go of those that could not be read. */
  forget(urls: readonly string[]): void;
}>;

type Saved = Readonly<{ at: number; state: RememberedState }>;

const states = new Set(["open", "draft", "merged", "closed"]);
const reasons = new Set(["completed", "not planned"]);
const checks = new Set(["success", "failure", "pending"]);
const reviews = new Set(["approved", "changes requested"]);

/** One saved entry, or undefined for anything else. */
function parse(value: unknown): Saved | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { at, state } = value as { at?: unknown; state?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (!state || typeof state !== "object") return undefined;
  const saved = state as Record<string, unknown>;
  if (typeof saved.state !== "string" || !states.has(saved.state))
    return undefined;
  if (
    (saved.reason !== undefined &&
      (typeof saved.reason !== "string" || !reasons.has(saved.reason))) ||
    (saved.title !== undefined && typeof saved.title !== "string") ||
    (saved.review !== undefined &&
      (typeof saved.review !== "string" || !reviews.has(saved.review))) ||
    (saved.checks !== undefined &&
      (typeof saved.checks !== "string" || !checks.has(saved.checks))) ||
    (saved.conflicts !== undefined && typeof saved.conflicts !== "boolean")
  )
    return undefined;
  return { at, state: pick(saved as PullState) };
}

/** Only what a link shows, and nothing undefined. */
function pick(state: PullState): RememberedState {
  return {
    state: state.state,
    ...(state.reason !== undefined && { reason: state.reason }),
    ...(state.title !== undefined && { title: state.title }),
    ...(state.review !== undefined && { review: state.review }),
    ...(state.checks !== undefined && { checks: state.checks }),
    ...(state.conflicts !== undefined && { conflicts: state.conflicts }),
  };
}

/** What links showed, read from and saved to `storage`. Without storage, or
 * when it can't be read or written, it keeps them for this session. */
export function createRememberedStates(
  given?: Storage | null,
): RememberedStates {
  const saved = new Map<string, Saved>();
  let storage: Storage | undefined;
  try {
    // Reading `localStorage` itself throws where storage is refused.
    storage =
      given === undefined ? globalThis.localStorage : (given ?? undefined);
    const raw = storage?.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [url, entry] of Object.entries(value)) {
        const found = parse(entry);
        if (found) saved.set(url, found);
      }
  } catch {
    // A damaged entry is rewritten with the next read.
  }
  /** When what is held was last saved, to tell when it is due again. */
  let savedAt = new Map<string, number>(
    [...saved].map(([url, { at }]) => [url, at]),
  );
  const save = () => {
    try {
      storage?.setItem(key, JSON.stringify(Object.fromEntries(saved)));
      savedAt = new Map([...saved].map(([url, { at }]) => [url, at]));
    } catch {
      // Full or unavailable: what was read is still shown this session.
    }
  };
  return {
    get: (url) => saved.get(url)?.state,
    readAt: (url) => saved.get(url)?.at,
    remember(read, at) {
      let due = false;
      for (const [url, state] of read) {
        const prior = saved.get(url);
        const shown = pick(state);
        const same =
          !!prior && JSON.stringify(prior.state) === JSON.stringify(shown);
        due ||= !same || at - (savedAt.get(url) ?? -Infinity) >= RESAVE_MS;
        // The same object while it shows the same, so `get` stays stable.
        saved.delete(url);
        saved.set(url, { at, state: prior && same ? prior.state : shown });
      }
      // Map order is the order of reads: the oldest come first.
      for (const url of saved.keys()) {
        if (saved.size <= REMEMBERED_STATES) break;
        saved.delete(url);
        due = true;
      }
      if (due) save();
    },
    forget(urls) {
      let due = false;
      for (const url of urls) due = saved.delete(url) || due;
      if (due) save();
    },
  };
}
