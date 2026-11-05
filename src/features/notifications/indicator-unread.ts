import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import { communityDestination } from "../communities/destination";
import type { OpenTarget } from "../navigation/targets";

/** Notification gates: only conversations they allow light the indicator. */
export type IndicatorGates = Readonly<{
  allows(target: OpenTarget): boolean;
  subscribe(listener: () => void): () => void;
}>;

export type UnreadScopes = Readonly<{ solo: boolean; team: boolean }>;

/** Projects the session's existing unread evidence into the two sidebar scopes. */
export function bindUnreadScopes(
  session: RelaySession,
  viewer: string,
  project: (scopes: UnreadScopes) => void,
  gates?: IndicatorGates,
  scope?: Readonly<{ viewer: string; communityOrigin: string }>,
) {
  let closed = false;
  let previous: UnreadScopes | undefined;
  const channels = new Map<
    string,
    { scope: keyof UnreadScopes; stop: () => void }
  >();
  const publish = (scopes: UnreadScopes) => {
    if (closed) return;
    if (scopes.solo === previous?.solo && scopes.team === previous?.team)
      return;
    previous = scopes;
    project(scopes);
  };
  const changed = () => {
    const next = { solo: false, team: false };
    const preferences = session.sidebarPreferences.snapshot();
    if (
      preferences.status !== "ready" &&
      preferences.status !== "unsupported"
    ) {
      publish(Object.freeze(next));
      return;
    }
    const muted = new Set(preferences.data?.muted ?? []);
    for (const [channelId, channel] of channels) {
      if (muted.has(channelId)) continue;
      const snapshot = session.unread.snapshot({
        kind: "channel",
        channelId,
      });
      if (snapshot.manual !== "none" || (snapshot.observedCount ?? 0) > 0)
        next[channel.scope] = true;
    }
    publish(Object.freeze(next));
  };
  const roster = () => {
    const next = new Map(
      session.channels
        .list()
        .channels.filter(
          (channel) =>
            !channel.huddle &&
            !channel.archived &&
            !channel.metadataPending &&
            channel.members?.includes(viewer) &&
            (!gates ||
              !scope ||
              gates.allows({
                version: 1,
                kind: "conversation",
                scope,
                channelId: channel.id,
              })),
        )
        .map(
          (channel) =>
            [
              channel.id,
              channel.channelType === "solo" ? "solo" : "team",
            ] as const,
        ),
    );
    for (const [id, current] of channels) {
      if (next.get(id) === current.scope) continue;
      current.stop();
      channels.delete(id);
    }
    for (const [channelId, destination] of next) {
      if (channels.has(channelId)) continue;
      channels.set(channelId, {
        scope: destination,
        stop: session.unread.subscribe({ kind: "channel", channelId }, changed),
      });
    }
    changed();
  };
  const stopRoster = session.channels.subscribeList(roster);
  const stopGates = gates?.subscribe(roster) ?? (() => {});
  const stopPreferences = session.sidebarPreferences.subscribe(changed);
  roster();
  return () => {
    if (closed) return;
    closed = true;
    stopRoster();
    stopGates();
    stopPreferences();
    for (const channel of channels.values()) channel.stop();
    channels.clear();
  };
}

/** A host projection of existing evidence, never a count or a new read owner. */
export function bindUnreadIndicator(
  communities: Communities,
  project: (unread: boolean) => void,
  gates?: IndicatorGates,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let previous: boolean | undefined;
  let stopRoster = () => {};
  const publish = (unread: boolean) => {
    if (unread === previous) return;
    previous = unread;
    project(unread);
  };
  const clear = () => {
    stopRoster();
    stopRoster = () => {};
  };
  const update = () => {
    if (closed) return;
    const client = communities.snapshot();
    const relay = communities.relay.snapshot();
    const next = `${client.viewer ?? ""}:${client.selected ?? ""}`;
    const owned =
      relay.status === "ready" &&
      client.viewer &&
      relay.viewer === client.viewer &&
      client.memberships.some((item) => item.id === client.selected)
        ? relay.session
        : undefined;
    if (session === owned && identity === next) return;
    clear();
    session = owned;
    identity = next;
    publish(false);
    if (!owned) return;
    const viewer = client.viewer as string;
    const scope = gates && {
      viewer,
      communityOrigin: communityDestination(client.selected as string).url,
    };
    stopRoster = bindUnreadScopes(
      owned,
      viewer,
      (scopes) => {
        if (!closed && session === owned && identity === next)
          publish(scopes.solo || scopes.team);
      },
      gates,
      scope,
    );
  };
  const stop = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  update();
  return () => {
    if (closed) return;
    closed = true;
    stop();
    stopRelay();
    clear();
    session = undefined;
    publish(false);
  };
}
