import type {
  SidebarRow,
  SidebarRowContribution,
} from "../../features/channel-navigation/sidebar-rows-service";
import type { SidebarSectionRow } from "../../features/channel-navigation/sidebar-sections-service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { UnreadSnapshot } from "../../features/relay/unread";

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

const noMutes: ReadonlySet<string> = new Set();
let lastList: readonly string[] | undefined;
let lastSet = noMutes;
/** Row callbacks run per row render; reuse one set per preference snapshot. */
export function mutedIds(relay: RelayData): ReadonlySet<string> {
  const list = relay.snapshot().session.sidebarPreferences.snapshot()
    .data?.muted;
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
    render: (row, Default) => (hidesRow(row, mutedIds(relay)) ? null : Default),
  };
}

function hiddenChannels(session: RelaySession): readonly ChannelSummary[] {
  const data = session.sidebarPreferences.snapshot().data;
  if (!data) return [];
  const muted = new Set(data.muted);
  const starred = new Set(data.starred);
  return session.channels
    .list()
    .channels.filter(
      (channel) =>
        muted.has(channel.id) &&
        !starred.has(channel.id) &&
        !channel.archived &&
        channel.channelType !== "dm" &&
        channel.channelType !== "solo" &&
        !attention(
          session.unread.snapshot({ kind: "channel", channelId: channel.id }),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The Muted section's rows, kept stable until the hidden set changes. */
export function mutedRows(relay: RelayData) {
  let rows: readonly SidebarSectionRow[] = [];
  let key = "";
  const snapshot = () => {
    const next = hiddenChannels(relay.snapshot().session).map(
      ({ id, name }) => ({ id, label: name }),
    );
    const nextKey = JSON.stringify(next);
    if (nextKey !== key) {
      key = nextKey;
      rows = next;
    }
    return rows;
  };
  const subscribe = (listener: () => void) => {
    let stopSession = () => {};
    const bind = () => {
      stopSession();
      const session = relay.snapshot().session;
      const stops = [
        session.sidebarPreferences.subscribe(listener),
        session.channels.subscribeList(listener),
      ];
      stopSession = () => {
        for (const stop of stops) stop();
      };
      listener();
    };
    bind();
    const stopRelay = relay.subscribe(bind);
    return () => {
      stopRelay();
      stopSession();
    };
  };
  return { snapshot, subscribe };
}
