import type {
  SidebarRow,
  SidebarRowContribution,
} from "../../features/channel-navigation/sidebar-rows-service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { UnreadSnapshot } from "../../features/relay/unread";
import { AttentionMark } from "./AttentionMark";

const attention = (unread: UnreadSnapshot) =>
  unread.manual !== "none" || (unread.attentionCount ?? 0) > 0;

/** Starred rows are pins, DMs are people, and the open channel stays put. */
export function hidesRow(row: SidebarRow, muted: ReadonlySet<string>) {
  return (
    row.kind === "team" &&
    row.sectionKey !== "starred" &&
    !row.selected &&
    muted.has(row.id) &&
    !attention(row.unread)
  );
}

/** Confirmed mutes only, as the host's own mute cues use; cached heads may be stale. */
function confirmedMutes(session: RelaySession) {
  const snapshot = session.sidebarPreferences.snapshot();
  return snapshot.cached ? undefined : snapshot.data;
}

const noMutes: ReadonlySet<string> = new Set();
let lastList: readonly string[] | undefined;
let lastSet = noMutes;
/** Row callbacks run per row render; reuse one set per preference snapshot. */
export function mutedIds(relay: RelayData): ReadonlySet<string> {
  const list = confirmedMutes(relay.snapshot().session)?.muted;
  if (list !== lastList) {
    lastList = list;
    lastSet = list ? new Set(list) : noMutes;
  }
  return lastSet;
}

export function hideMutedRows(relay: RelayData): SidebarRowContribution {
  return {
    version: 1,
    id: "hide-muted",
    hiddenLabel: "Muted",
    render: (row, Default) => {
      // An earlier contribution may already have hidden the row.
      if (Default === null || row.kind !== "team") return Default;
      const muted = mutedIds(relay);
      if (hidesRow(row, muted)) return null;
      // Every Team row keeps one wrapper so mute and attention changes toggle
      // only the dot, never the host element's tree position.
      return (
        <AttentionMark active={muted.has(row.id) && attention(row.unread)}>
          {Default}
        </AttentionMark>
      );
    },
  };
}
