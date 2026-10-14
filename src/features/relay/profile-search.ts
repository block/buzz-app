import { ReadError } from "./errors";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import type { ReadTransport } from "./transport";

/** The relay's `POST /profiles/search` page-size ceiling. */
export const PROFILE_SEARCH_MAX = 100;
/** The relay's highest page, the same as its NIP-50 search. */
export const PROFILE_SEARCH_PAGES = 1000;

export type ProfileSearchOptions = {
  /** Results per page. */
  limit: number;
  /** 1-based page of `limit` results; NIP-50 gets it only when given. */
  page?: number;
  signal: AbortSignal;
  priority?: "foreground" | "background";
};

/** How long a relay's 404 or 405 keeps searches on NIP-50 before the endpoint
 * is tried again. A relay upgraded while the app runs is used within this time. */
export const PROFILE_SEARCH_RETRY_MS = 5 * 60_000;

/** Finds people by profile name. Uses the relay's name-only endpoint, which
 * applies the NIP-50 prefix rule and paging to just `name` and `display_name`.
 * NIP-50 search over kind:0 matches the whole profile JSON, so text in avatar
 * data URLs, `about` or `nip05` can fill its pages and hide a real name match.
 *
 * A relay without the endpoint answers 404 or 405. That search then uses
 * NIP-50, and so do later ones for {@link PROFILE_SEARCH_RETRY_MS}; after that
 * the endpoint is tried again. A relay that loses the endpoint falls back the
 * same way.
 *
 * `begin` runs before each endpoint request. It returns a check that is true
 * when the session's access or cache changed, so the result is stale. */
export function createProfileSearch(
  search: ReadTransport["searchProfiles"] | undefined,
  fallback: RelayReader,
  begin: () => () => boolean,
  now: () => number = Date.now,
) {
  let fallbackUntil = Number.NEGATIVE_INFINITY;
  return async function searchProfiles(
    query: string,
    { limit, page, signal, priority = "foreground" }: ProfileSearchOptions,
    reader: RelayReader = fallback,
  ): Promise<readonly RelayEvent[]> {
    const text = query.trim();
    if (
      !text ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PROFILE_SEARCH_MAX ||
      (page !== undefined &&
        (!Number.isSafeInteger(page) ||
          page < 1 ||
          page > PROFILE_SEARCH_PAGES))
    )
      throw new Error("Invalid profile search.");
    if (search && now() >= fallbackUntil) {
      const stale = begin();
      try {
        const events = await search(text, limit, page ?? 1, signal, priority);
        signal.throwIfAborted();
        if (stale())
          throw new DOMException("Stale profile search", "AbortError");
        return events.filter((event) => event.kind === 0);
      } catch (error) {
        if (
          !(error instanceof ReadError) ||
          (error.status !== 404 && error.status !== 405)
        )
          throw error;
        fallbackUntil = now() + PROFILE_SEARCH_RETRY_MS;
      }
    }
    return reader.read(
      [
        {
          kinds: [0],
          search: text,
          search_mode: "prefix",
          limit,
          ...(page === undefined ? {} : { page }),
        },
      ],
      { signal, priority, fresh: true },
    );
  };
}
export type ProfileSearch = ReturnType<typeof createProfileSearch>;
