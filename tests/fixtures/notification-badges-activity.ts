import type { Communities } from "../../src/features/communities/service";
import { bindUnreadIndicator } from "../../src/features/notifications/indicator-unread";
import type { UnreadIndicator } from "../../src/features/notifications/indicator";
import type { createNotificationPreferences } from "../../src/features/notifications/preferences";
import { createRelaySession } from "../../src/features/relay/session";
import {
  readJournal,
  type ReadJournal,
} from "../../src/features/relay/read-state-storage";
import type { RelayEvent } from "../../src/features/relay/events";
import {
  keypair,
  message,
  metadata,
  roster,
} from "../../src/features/relay/testing";

// Ephemeral identities and an in-memory relay: this fixture never joins a community.
export function badgeActivityFixture(
  indicator: UnreadIndicator,
  preferences: ReturnType<typeof createNotificationPreferences>,
) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  let receive = (_events: readonly RelayEvent[]) => {};
  let journal: ReadJournal | undefined;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query: async () => {
        throw new Error("Badge projection must not query the relay");
      },
      media: () => undefined,
      readState: {
        decode: async () => [],
        sign: async () => {
          throw new Error("No read-state publication in this fixture");
        },
        publish: async () => {},
      },
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
      readPublisherLock: async () => {},
    },
  );
  receive([
    roster(relay, "room", [viewer.pubkey], 10),
    metadata(relay, "room", "Example channel", 10),
    roster(relay, "dm", [viewer.pubkey, peer.pubkey], 10),
    metadata(relay, "dm", "Example DM", 10, [["t", "dm"]]),
  ]);
  const communities = {
    snapshot: () => ({
      viewer: viewer.pubkey,
      selected: "https://badge.example.org",
      memberships: [{ id: "https://badge.example.org" }],
    }),
    subscribe: () => () => {},
    relay: {
      snapshot: () => ({
        status: "ready",
        viewer: viewer.pubkey,
        session: owner.session,
      }),
      subscribe: () => () => {},
    },
  } as unknown as Communities;
  let projected = "None";
  const listeners = new Set<() => void>();
  const stop = bindUnreadIndicator(
    communities,
    (unread, count) => {
      indicator.setUnread(unread, count);
      projected = !unread ? "None" : count ? String(count) : "Dot";
      for (const listener of listeners) listener();
    },
    {
      allows: () => true,
      badgeActivity: () => preferences.snapshot().preferences.badgeActivity,
      subscribe: preferences.subscribe,
    },
  );
  let time = 10;
  const latest = new Map<string, RelayEvent>();
  const mentions: RelayEvent[] = [];
  return {
    snapshot: () => projected,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(kind: "ordinary" | "mention" | "dm") {
      const channelId = kind === "dm" ? "dm" : "room";
      const event = message(
        peer,
        channelId,
        `Example ${kind}`,
        ++time,
        kind === "mention" ? [["p", viewer.pubkey]] : [],
      );
      latest.set(channelId, event);
      if (kind === "mention") mentions.push(event);
      receive([event]);
    },
    async readMention() {
      const event = mentions.shift();
      if (event)
        await owner.session.unread.markThrough(
          { kind: "message", channelId: "room", messageId: event.id },
          event.id,
        );
    },
    async readAll() {
      for (const [channelId, event] of latest)
        await owner.session.unread.markThrough(
          { kind: "channel", channelId },
          event.id,
        );
      mentions.length = 0;
    },
    dispose() {
      stop();
      owner.dispose();
    },
  };
}
