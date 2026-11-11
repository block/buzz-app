/** Whether the viewer wrote anything this relay can show them, of any kind and
 * in any channel they can read, at or before `until` (unix seconds): one event
 * answers the question. The only read without kinds or event IDs that the
 * session reader and the browser broker admit, and only about the viewer. */
export function earlierActivityFilter(viewer: string, until: number) {
  return { authors: [viewer], until, limit: 1 };
}

/** Exactly the shape `earlierActivityFilter` builds for `viewer`; nothing
 * more, and never about another author. */
export function isEarlierActivityFilter(
  filter: unknown,
  viewer: string | undefined,
): boolean {
  if (!filter || typeof filter !== "object") return false;
  const { authors, until, limit, ...rest } = filter as Record<string, unknown>;
  return (
    !Object.keys(rest).length &&
    Array.isArray(authors) &&
    authors.length === 1 &&
    typeof authors[0] === "string" &&
    /^[0-9a-f]{64}$/.test(authors[0]) &&
    authors[0] === viewer &&
    Number.isSafeInteger(until) &&
    (until as number) >= 0 &&
    limit === 1
  );
}
