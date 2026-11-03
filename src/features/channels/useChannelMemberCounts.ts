import { useEffect, useState } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type { ComposerSession } from "../messages/composer-session";
import { searchDebounce } from "../../shared/search-debounce";

type Counts = Readonly<{
  session: ComposerSession;
  /** Every channel already asked about, found or not, so none is read twice. */
  asked: ReadonlySet<string>;
  counts: ReadonlyMap<string, number>;
}>;

/** Member counts for channel search rows, for display only. A joined channel
 * counts the roster it already carries. The others, such as public channels
 * the viewer has not joined, are read once typing pauses, and each answer is
 * kept while the rows stay mounted. */
export function useChannelMemberCounts(
  session: ComposerSession,
  channels: readonly ChannelSummary[],
) {
  const [state, setState] = useState<Counts>();
  const current = state?.session === session ? state : undefined;
  const read = session.channels.memberCounts;
  // Sorted, so a reordering of the same rows reads nothing new.
  const missing = [
    ...new Set(
      channels.flatMap(({ id, members }) =>
        members?.length || current?.asked.has(id) ? [] : [id],
      ),
    ),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    if (!missing || !read) return;
    const ids = missing.split(",");
    const controller = new AbortController();
    // Rows change with each keystroke and directory page; wait for them to settle.
    const cancel = searchDebounce(() => {
      read(ids, { signal: controller.signal, priority: "background" }).then(
        (found) => {
          if (controller.signal.aborted) return;
          setState((prior) => {
            const kept = prior?.session === session ? prior : undefined;
            return {
              session,
              asked: new Set([...(kept?.asked ?? []), ...ids]),
              counts: new Map([...(kept?.counts ?? []), ...found]),
            };
          });
        },
        // A count is optional detail: a failed read leaves the row without one.
        () => {},
      );
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [missing, read, session]);
  return (channel: ChannelSummary): number | undefined =>
    channel.members?.length || current?.counts.get(channel.id) || undefined;
}
