import type { Communities } from "../communities/service";
import { communityDestination } from "../communities/destination";
import type { OpenTarget } from "../navigation/targets";
import type { IncomingListener } from "../relay/incoming";
import type { RelaySession } from "../relay/session";
import type { NotificationsService } from "./service";
import { messageNotificationText } from "./content";

const labels = {
  mention: "Mentions",
  direct: "Direct messages",
  thread: "Thread replies",
};
/** No new subscriptions: this first adapter covers only the selected community. */
export function notificationAuthorized(
  communities: Communities,
  target: OpenTarget,
) {
  if (!("scope" in target) || !target.scope) return true;
  const client = communities.snapshot();
  const scope = target.scope;
  if (
    client.viewer !== scope.viewer ||
    !client.memberships.some(
      (item) => communityDestination(item.id).url === scope.communityOrigin,
    )
  )
    return false;
  if (target.kind !== "conversation") return true;
  const relay = communities.relay.snapshot();
  return (
    !!client.selected &&
    communityDestination(client.selected).url === scope.communityOrigin &&
    relay.status === "ready" &&
    relay.viewer === scope.viewer &&
    relay.session.channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === target.channelId &&
          channel.members?.includes(scope.viewer),
      )
  );
}

export function bindMessageNotifications(
  notifications: NotificationsService,
  communities: Communities,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let generation = 0;
  let stopIncoming = () => {};
  let stopAccess = () => {};
  let stopPreferences = () => {};
  const waiting = new Map<string, { reconsider(): void; dispose(): void }>();
  const clearWaiting = () => {
    for (const item of waiting.values()) item.dispose();
  };
  const update = () => {
    const client = communities.snapshot();
    void notifications.selectViewer(client.viewer);
    const relay = communities.relay.snapshot();
    const origin = client.selected
      ? communityDestination(client.selected).url
      : undefined;
    const next = `${client.viewer ?? ""}:${origin ?? ""}:${relay.status}`;
    if (session === relay.session && identity === next) return;
    generation++;
    clearWaiting();
    stopIncoming();
    stopAccess();
    stopPreferences();
    notifications.revalidate();
    session = relay.session;
    identity = next;
    if (
      closed ||
      relay.status !== "ready" ||
      !origin ||
      !client.viewer ||
      relay.viewer !== client.viewer
    )
      return;
    const viewer = client.viewer;
    const owned = relay.session;
    const current = generation;
    const valid = () =>
      !closed &&
      generation === current &&
      communities.relay.snapshot().session === owned;
    const receive: IncomingListener = (messages) => {
      for (const message of messages) {
        if (!valid()) return;
        const age = Date.now() - message.createdAt * 1000;
        if (age < -30000 || age >= 120000) continue;
        if (waiting.has(message.messageId) || waiting.size >= 128) continue;
        let stop = () => {};
        const dispose = () => {
          clearTimeout(expiry);
          stop();
          waiting.delete(message.messageId);
        };
        // Category is authoritative context data. Only fresh live arrivals own
        // this demand; history and periodic refresh never create candidates.
        const reconsider = () => {
          if (!waiting.has(message.messageId)) return;
          if (!valid()) return dispose();
          const attention = owned.unread.attention(
            message.channelId,
            message.messageId,
          );
          const preferences = owned.sidebarPreferences.snapshot();
          const policy = notifications.snapshot();
          if (
            !policy.preferences.enabled ||
            policy.developmentPaused ||
            Date.now() - message.createdAt * 1000 >= 120000 ||
            !owned.channels
              .list()
              .channels.some(
                (channel) =>
                  channel.id === message.channelId &&
                  channel.members?.includes(viewer),
              ) ||
            attention.status === "ineligible" ||
            (!notifications.snapshot().preferences.notifyWhileViewing &&
              attention.viewing) ||
            (!attention.mentioned &&
              preferences.data?.muted.includes(message.channelId))
          )
            return dispose();
          const category = attention.category;
          // A broadcast may later acquire conversation membership. Keep its
          // context while fresh, without treating broadcast as a notification.
          if (attention.status === "unknown" || !category) return;
          // Admission can synchronously publish errors. Stop reconsideration now,
          // but retain context until admit installs its own observation below.
          waiting.delete(message.messageId);
          void notifications.admit(
            category,
            labels[category],
            {
              sourceKey: message.messageId,
              target: {
                version: 1,
                kind: "conversation",
                scope: { viewer, communityOrigin: origin },
                channelId: message.channelId,
                messageId: message.messageId,
                ...(attention.rootId ? { threadRootId: attention.rootId } : {}),
              },
            },
            valid,
            () => {
              if (!valid() || Date.now() - message.createdAt * 1000 > 120000)
                return false;
              const attention = owned.unread.attention(
                message.channelId,
                message.messageId,
              );
              const sync = owned.unread.sync();
              // Explicit mentions bypass channel mute, as in the legacy policy —
              // including p-tagged messages in DM channels, whose category is
              // "direct". Unknown preferences must not briefly release ordinary
              // alerts at startup.
              if (!attention.mentioned) {
                const preferences = owned.sidebarPreferences.snapshot();
                if (preferences.data?.muted.includes(message.channelId))
                  return false;
                if (
                  preferences.status !== "ready" &&
                  preferences.status !== "unsupported"
                )
                  return "wait";
              }
              if (
                attention.status === "ineligible" ||
                (attention.status !== "unknown" &&
                  attention.category !== category) ||
                (!notifications.snapshot().preferences.notifyWhileViewing &&
                  attention.viewing)
              )
                return false;
              if (
                sync.status === "loading" ||
                sync.status === "error" ||
                (sync.capability !== "unsupported" &&
                  sync.completeness === "unknown") ||
                attention.status === "unknown"
              )
                return "wait";
              return attention.unread;
            },
            () =>
              messageNotificationText(
                message,
                category,
                owned.channels
                  .list()
                  .channels.find((item) => item.id === message.channelId),
                owned.profiles.snapshot().get(message.authorId),
                owned.names.resolve(
                  message.authorId,
                  undefined,
                  owned.channels
                    .list()
                    .channels.find((item) => item.id === message.channelId)
                    ?.members ?? [],
                ),
              ),
            () =>
              owned.unread.subscribe(
                {
                  kind: "message",
                  channelId: message.channelId,
                  messageId: message.messageId,
                },
                () => notifications.revalidate(),
              ),
            message.createdAt * 1000 + 120000,
          );
          // admit installs its own observation synchronously before returning.
          dispose();
        };
        // Do not renew freshness when a slow lookup eventually finds a category.
        const expiry = setTimeout(dispose, Math.max(0, 120000 - age));
        waiting.set(message.messageId, { reconsider, dispose });
        try {
          stop = owned.unread.subscribe(
            {
              kind: "message",
              channelId: message.channelId,
              messageId: message.messageId,
            },
            reconsider,
          );
          reconsider();
        } catch (error) {
          dispose();
          throw error;
        }
      }
    };
    stopIncoming = owned.subscribeIncoming(receive);
    const preferencesChanged = () => {
      for (const item of waiting.values()) item.reconsider();
      notifications.revalidate();
      if (owned.sidebarPreferences.snapshot().status === "idle")
        void owned.sidebarPreferences.ensure();
    };
    stopPreferences = owned.sidebarPreferences.subscribe(preferencesChanged);
    preferencesChanged();
    // App-global ownership: Channels may not be mounted. Start its shared
    // observation only after discovery, so an empty startup roster cannot
    // consume the unread owner's one-shot evidence repair.
    const accessChanged = () => {
      for (const item of waiting.values()) item.reconsider();
      notifications.revalidate();
      if (
        owned.channels.list().status === "ready" &&
        owned.unread.sync().capability !== "unsupported"
      )
        void owned.unread.ensure();
    };
    stopAccess = owned.channels.subscribeList(accessChanged);
    accessChanged();
  };
  const stopPolicy = notifications.subscribe(() => {
    for (const item of waiting.values()) item.reconsider();
  });
  const stop = communities.relay.subscribe(update);
  const stopCommunities = communities.subscribe(update);
  update();
  return () => {
    closed = true;
    generation++;
    clearWaiting();
    stopPolicy();
    stop();
    stopCommunities();
    stopIncoming();
    stopAccess();
    stopPreferences();
  };
}
