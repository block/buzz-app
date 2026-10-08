import type { ChannelMessage } from "../../relay/contracts";
import { continuesMessageGroup } from "../message-grouping";

export type Placement = Readonly<{
  /** The row starts a local calendar day and shows its divider. */
  day: boolean;
  layout: "timeline" | "continuation";
}>;

/** One pass shared by rendering and row heights: a row's day divider and
 * author header depend on its predecessor, so a prepend changes the first. */
export function placements(rows: readonly ChannelMessage[]): Placement[] {
  let previous: string | undefined;
  return rows.map((row, index) => {
    const day = new Date(row.createdAt * 1000).toDateString();
    const placement: Placement = {
      day: index === 0 || day !== previous,
      layout: continuesMessageGroup(rows[index - 1], row)
        ? "continuation"
        : "timeline",
    };
    previous = day;
    return placement;
  });
}
