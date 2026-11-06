import type {
  SidebarRow,
  SidebarRowContribution,
} from "../../features/channel-navigation/sidebar-rows-service";
import type { SidebarSectionRow } from "../../features/channel-navigation/sidebar-sections-service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { UnreadSnapshot } from "../../features/relay/unread";
import { channelIcon } from "../../features/channels/channel-icon";
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

function mutedChannels(session: RelaySession): readonly ChannelSummary[] {
  const data = confirmedMutes(session);
  if (!data) return [];
  const muted = new Set(data.muted);
  return session.channels
    .list()
    .channels.filter(
      (channel) =>
        muted.has(channel.id) &&
        !channel.archived &&
        channel.channelType !== "dm" &&
        channel.channelType !== "solo",
    );
}

function hiddenChannels(session: RelaySession): readonly ChannelSummary[] {
  const starred = new Set(confirmedMutes(session)?.starred);
  return mutedChannels(session)
    .filter(
      (channel) =>
        !starred.has(channel.id) &&
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
    const channels = hiddenChannels(relay.snapshot().session);
    const nextKey = JSON.stringify(
      channels.map((c) => [c.id, c.name, !!c.private, c.channelType]),
    );
    if (nextKey !== key) {
      key = nextKey;
      rows = channels.map((channel) => {
        const Icon = channelIcon(channel);
        return {
          id: channel.id,
          label: channel.name,
          icon: <Icon size={16} aria-hidden="true" />,
        };
      });
    }
    return rows;
  };
  const subscribe = (listener: () => void) => {
    let session: RelaySession | undefined;
    let stopSession = () => {};
    let stopUnread = () => {};
    let watched = "";
    // Attention decides membership, so follow unread for each muted channel.
    const watchUnread = () => {
      if (!session) return;
      const ids = mutedChannels(session).map(({ id }) => id);
      const nextWatched = ids.join("\n");
      if (nextWatched === watched) return;
      watched = nextWatched;
      stopUnread();
      const active = session;
      const stops = ids.map((channelId) =>
        active.unread.subscribe({ kind: "channel", channelId }, listener),
      );
      stopUnread = () => {
        for (const stop of stops) stop();
      };
    };
    const changed = () => {
      watchUnread();
      listener();
    };
    const bind = () => {
      const next = relay.snapshot().session;
      if (next === session) return changed();
      stopSession();
      stopUnread();
      watched = "";
      session = next;
      const stops = [
        next.sidebarPreferences.subscribe(changed),
        next.channels.subscribeList(changed),
      ];
      stopSession = () => {
        for (const stop of stops) stop();
      };
      changed();
    };
    bind();
    const stopRelay = relay.subscribe(bind);
    return () => {
      stopRelay();
      stopSession();
      stopUnread();
    };
  };
  return { snapshot, subscribe };
}
