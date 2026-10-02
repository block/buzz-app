import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { HuddleDestination } from "./bridge";
import { recentHuddles } from "./discovery";
import { huddleRoom } from "./lifecycle";

export type HuddleRequest = {
  room: string;
  creator: string;
  destination: HuddleDestination;
};

/** Watches new DM starts for this activation. Dismissal is local, never a relay write. */
export function createHuddleRequests(
  relay: RelayData,
  available: () => boolean,
  changed: (request: HuddleRequest | undefined) => void,
) {
  let connection: RelaySnapshot | undefined;
  let since = 0;
  let channels = "";
  let view: ReturnType<RelaySession["observe"]> | undefined;
  let stopView: (() => void) | undefined;
  let stopList: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selected: HuddleRequest | undefined;
  const dismissed = new Set<string>();
  let disposed = false;
  function publish(next: HuddleRequest | undefined) {
    if (
      selected?.room === next?.room &&
      selected?.destination.scope === next?.destination.scope
    )
      return;
    selected = next;
    changed(next);
  }
  function refresh() {
    clearTimeout(timer);
    const snapshot = view?.snapshot();
    if (!connection?.scope || !connection.viewer || !available() || !snapshot) {
      publish(undefined);
      return;
    }
    // The observer retains verified remote events even if its finite read fails.
    // Live starts can still offer Join; audio admission rechecks the room.
    const session = connection.session;
    const now = Date.now() / 1000;
    const rooms = session.channels
      .list()
      .channels.flatMap((channel) => {
        if (
          channel.channelType !== "dm" ||
          channel.archived ||
          channel.readOnly ||
          channel.cached ||
          !channel.members?.includes(connection?.viewer ?? "")
        )
          return [];
        return recentHuddles(snapshot.events, channel.id, session.relayAuthor)
          .filter(
            (room) =>
              room.startedAt >= since &&
              room.startedAt <= now &&
              room.startedAt + 3600 > now &&
              room.creator !== connection?.viewer &&
              channel.members?.includes(room.creator) &&
              !dismissed.has(room.id),
          )
          .map((room) => ({ ...room, channel }));
      })
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
    // A signed member-added notice identifies the inviter. Metadata and the
    // current roster grant room access; the notice alone never grants access.
    const invitations = snapshot.events.flatMap((event) => {
      if (
        event.kind !== 44100 ||
        event.pubkey !== session.relayAuthor ||
        event.created_at < since ||
        event.created_at > now ||
        event.created_at + 60 <= now ||
        !event.tags.some(
          ([key, value]) => key === "p" && value === connection?.viewer,
        )
      )
        return [];
      try {
        const notice = JSON.parse(event.content);
        const room = session.channels
          .list()
          .channels.find((c) => c.id === notice.channel_id);
        if (
          notice.type !== "member_added" ||
          typeof notice.actor !== "string" ||
          !/^[0-9a-f]{64}$/.test(notice.actor) ||
          notice.actor === connection?.viewer ||
          !room?.huddle ||
          !room.parentChannelId ||
          room.archived ||
          room.readOnly ||
          room.cached ||
          !room.members?.includes(connection?.viewer ?? "") ||
          !room.members.includes(notice.actor) ||
          !event.tags.some(
            ([key, value]) => key === "h" && value === room.id,
          ) ||
          dismissed.has(room.id) ||
          snapshot.events.some(
            (end) =>
              end.kind === 48103 &&
              end.pubkey === session.relayAuthor &&
              end.created_at >= event.created_at &&
              huddleRoom(end) === room.id &&
              end.tags.some(
                ([key, value]) => key === "h" && value === room.parentChannelId,
              ),
          )
        )
          return [];
        return [
          {
            id: room.id,
            creator: notice.actor,
            startedAt: event.created_at,
            channel: { id: room.parentChannelId, name: "Huddle" },
          },
        ];
      } catch {
        return [];
      }
    });
    const next = [...rooms, ...invitations].sort(
      (a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id),
    )[0];
    publish(
      next
        ? {
            room: next.id,
            creator: next.creator,
            destination: {
              scope: connection.scope,
              viewer: connection.viewer,
              relayUrl: connection.scope.slice(0, -65),
              channelId: next.channel.id,
              channelName: next.channel.name,
            },
          }
        : undefined,
    );
    if (next) {
      // Outsiders cannot receive the private parent's end event. Bound their
      // invitation prompt instead of relying on stale discovery metadata.
      const lifetime = invitations.some((invite) => invite === next)
        ? 60
        : 3600;
      timer = setTimeout(refresh, (next.startedAt + lifetime - now) * 1000);
    }
  }

  function retireView() {
    clearTimeout(timer);
    stopView?.();
    view?.dispose();
    view = undefined;
    stopView = undefined;
  }
  function watchChannels() {
    const session = connection?.session;
    if (!session || disposed) return;
    const ids = session.channels
      .list()
      .channels.filter(
        (c) =>
          (c.channelType === "dm" || (c.huddle && !!c.parentChannelId)) &&
          !c.archived &&
          !c.readOnly &&
          !c.cached &&
          c.members?.includes(session.viewer ?? ""),
      )
      .map((c) => c.id)
      .sort();
    const key = ids.join(":");
    if (key === channels) {
      refresh();
      return;
    }
    channels = key;
    retireView();
    publish(undefined);
    if (!ids.length) return;
    view = session.observe([
      { kinds: [48100], "#h": ids, since, limit: 100 },
      { kinds: [48103], "#h": ids, since, limit: 100 },
      ...(session.relayAuthor
        ? [
            {
              kinds: [44100],
              authors: [session.relayAuthor],
              // Membership notices are stored globally; #h is metadata only.
              // A channel-scoped query cannot recover a notice delivered before
              // discovery established access to the newly granted room.
              "#p": [session.viewer ?? ""],
              since,
              limit: 100,
            },
          ]
        : []),
    ]);
    stopView = view.subscribe(refresh);
    refresh();
    void view.refresh();
  }
  function connect() {
    const next = relay.snapshot();
    if (
      connection?.session === next.session &&
      connection.scope === next.scope &&
      next.status === "ready"
    )
      return;
    stopList?.();
    retireView();
    channels = "";
    dismissed.clear();
    connection = undefined;
    publish(undefined);
    if (disposed || next.status !== "ready" || !next.scope || !next.viewer)
      return;
    connection = next;
    since = Math.floor(Date.now() / 1000);
    stopList = next.session.channels.subscribeList(watchChannels);
    watchChannels();
  }
  const stop = relay.subscribe(connect);
  connect();
  return {
    refresh,
    dismiss(room: string) {
      dismissed.add(room);
      refresh();
    },
    dispose() {
      disposed = true;
      stop();
      stopList?.();
      retireView();
      publish(undefined);
    },
  };
}
