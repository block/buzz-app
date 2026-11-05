import { PROFILE_CACHE_BASE } from "./budget";
import { ReadError } from "./errors";
import type { Profile } from "./contracts";
import { newer, type EventData, type RelayEvent } from "./events";
import { foldProfiles } from "./profiles";
import type { RelayReader } from "./reader";
import {
  VERIFIED_PROFILE_KIND,
  verifiedProfileSubject,
  type VerifiedProfileAuthority,
} from "./verified-profile";

/** The relay's `POST /profiles/search` page-size ceiling. */
export const PROFILE_SEARCH_MAX = 100;
/** The relay's highest page, the same as its NIP-50 search. */
export const PROFILE_SEARCH_PAGES = 1000;
/** The relay's longest accepted trimmed query, in Unicode code points (Rust
 * `chars()`). A longer query goes to NIP-50 search, which has no such limit. */
export const PROFILE_SEARCH_QUERY_MAX = 100;

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
/** How long a search's verified answer stands in for a read: a page names
 * its rows right after it settles. */
export const PROFILE_SEARCH_HEADS_MS = 30_000;

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
 * Both searches go through the given reader, which owns their deadline,
 * cancellation and stale-result checks.
 *
 * Where the authority is `searchable`, the endpoint also returns each found
 * person's current verified head, and none when they have none. Those
 * answers are kept, a page at a time, for {@link verifiedHeads}. A person it
 * found who has no kind:0 is returned as their head, so the result has one
 * event per person; {@link searchedProfiles} reads it. */
export function createProfileSearch(
  fallback: RelayReader,
  now: () => number = Date.now,
  authority: () => VerifiedProfileAuthority | undefined = () => undefined,
) {
  let fallbackUntil = Number.NEGATIVE_INFINITY;
  const answers = new Map<
    string,
    { authority: VerifiedProfileAuthority; at: number; head?: RelayEvent }
  >();
  /** Keeps the page's answers, and returns each found person's head. */
  function keep(events: readonly RelayEvent[]) {
    const page = new Map<string, RelayEvent | undefined>();
    const current = authority();
    if (!current?.searchable) return page;
    const at = now();
    for (const event of events) {
      if (event.kind === 0 && !page.has(event.pubkey))
        page.set(event.pubkey, undefined);
      const subject = verifiedProfileSubject(event, current);
      if (subject) page.set(subject, newer(page.get(subject), event));
    }
    for (const [pubkey, head] of page) {
      answers.delete(pubkey);
      answers.set(pubkey, {
        authority: current,
        at,
        ...(head ? { head } : {}),
      });
    }
    for (const pubkey of answers.keys()) {
      if (answers.size <= PROFILE_CACHE_BASE) break;
      answers.delete(pubkey);
    }
    return page;
  }
  /** Takes the recent answers this authority gave for `pubkeys`: each one's
   * head, or undefined for none. A taken answer is not given again. */
  function verifiedHeads(
    pubkeys: readonly string[],
    current: VerifiedProfileAuthority,
  ): ReadonlyMap<string, RelayEvent | undefined> {
    const taken = new Map<string, RelayEvent | undefined>();
    for (const pubkey of pubkeys) {
      const answer = answers.get(pubkey);
      if (!answer) continue;
      answers.delete(pubkey);
      if (
        answer.authority === current &&
        now() - answer.at < PROFILE_SEARCH_HEADS_MS
      )
        taken.set(pubkey, answer.head);
    }
    return taken;
  }
  async function searchProfiles(
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
    if (
      reader.searchProfiles &&
      [...text].length <= PROFILE_SEARCH_QUERY_MAX &&
      now() >= fallbackUntil
    ) {
      try {
        const events = await reader.searchProfiles(text, limit, page ?? 1, {
          signal,
          priority,
          fresh: true,
        });
        // A person with no kind:0 is found by their verified head alone.
        const named = new Set(
          events.flatMap((event) => (event.kind === 0 ? [event.pubkey] : [])),
        );
        const unnamed = new Set(
          [...keep(events)].flatMap(([pubkey, head]) =>
            head && !named.has(pubkey) ? [head] : [],
          ),
        );
        return events.filter((event) => event.kind === 0 || unnamed.has(event));
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
  }
  return Object.assign(searchProfiles, { verifiedHeads });
}
export type ProfileSearch = ReturnType<typeof createProfileSearch>;

/** The people a {@link createProfileSearch} page found, by pubkey: each
 * kind:0 profile, and for a person found only by their verified head, the
 * nameless profile an empty kind:0 gives. Their verified name comes from that
 * head, which the search keeps for `useVerifiedNames`. Takes only that
 * search's result: it already checked each head's authority. */
export function searchedProfiles(
  events: readonly EventData[],
): Map<string, Profile> {
  const profiles = foldProfiles(events);
  for (const event of events) {
    if (event.kind !== VERIFIED_PROFILE_KIND) continue;
    const subject = event.tags.find(([name]) => name === "d")?.[1];
    if (subject && !profiles.has(subject))
      profiles.set(
        subject,
        Object.freeze({ name: subject.slice(0, 10), nameIsFallback: true }),
      );
  }
  return profiles;
}
