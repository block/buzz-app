import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { expect, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type {
  SidebarDecoder,
  SidebarMuteMutator,
} from "../relay/sidebar-preferences";
import type { LiveCallbacks } from "../relay/live";
import type { ReadFilter } from "../relay/events";
import type { Communities } from "../communities/service";
import { keypair, message, metadata, roster, flush } from "../relay/testing";
import {
  sidebarFixture,
  sidebarRow,
  sidebarAccount,
} from "../relay/sidebar-testing";
import type { RelayEvent } from "../relay/events";
import { NotificationsService } from "./service";
import { createNotificationPreferences } from "./preferences";
import { provideNavigation } from "../navigation/service";
import { bindMessageNotifications, notificationAuthorized } from "./messages";

export const cleanups: (() => unknown)[] = [];
export async function setup(
  readBarrier: Promise<void> | (() => Promise<void>) = Promise.resolve(),
  readFrontier?: number,
  remote?: {
    barrier: Promise<void>;
    decodeBarrier?: Promise<void>;
    frontier: number;
    channelsMounted?: boolean;
    deferRoster?: boolean;
  },
  sidebar?: { decode: SidebarDecoder; write?: SidebarMuteMutator },
) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  const origin = "https://relay.example.com";
  let callbacks!: LiveCallbacks;
  const bff = sidebarFixture();
  const observed = new Map<string, RelayEvent>();
  const frontier = readFrontier ?? remote?.frontier;
  const readIds = new Set<string>();
  const sidebarQuery = vi.fn(async () => {
    await remote?.barrier;
    return {
      account: sidebarAccount,
      channels: [...bff.rows.values()],
      next_cursor: null,
    };
  });
  bff.api.sidebar.mockImplementation(sidebarQuery);
  const contextQuery = bff.api.contexts;
  contextQuery.mockImplementation(async (queries) => {
    await remote?.barrier;
    await remote?.decodeBarrier;
    return {
      account: sidebarAccount,
      contexts: queries.map((q) => ({
        status: "available",
        messages: q.message_ids.map((message_id) => {
          const event = observed.get(message_id);
          if (!event) return { message_id, status: "unavailable" };
          if (
            event.pubkey === viewer.pubkey ||
            readIds.has(event.id) ||
            (frontier !== undefined && event.created_at <= frontier)
          )
            return { message_id, status: "read" };
          const channel = owner.session.channels
            .list()
            .channels.find((channel) => channel.id === q.target.channel_id);
          const mentioned = event.tags.some(
            ([key, value]) => key === "p" && value === viewer.pubkey,
          );
          return {
            message_id,
            status: "unread",
            reason:
              channel?.channelType === "dm"
                ? "direct"
                : mentioned
                  ? "mention"
                  : q.target.root_id
                    ? "conversation"
                    : null,
          };
        }),
      })),
    };
  });
  bff.api.write.mockImplementation(async (intents) => {
    for (const intent of intents) {
      const channelId =
        intent.type === "mark_channel_read"
          ? intent.channel_id
          : intent.target.channel_id;
      for (const event of observed.values()) {
        if (event.tags.some(([name, id]) => name === "h" && id === channelId))
          readIds.add(event.id);
        if (event.id === intent.message_id) break;
      }
    }
    return intents.map(() => ({ status: "applied" }));
  });
  const query = vi.fn(
    async (_filters: readonly ReadFilter[]) => [] as RelayEvent[],
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      sidebarApi: bff.api,
      ...(sidebar
        ? {
            decodeSidebarPreferences: sidebar.decode,
            ...(sidebar.write ? { writeSidebarMute: sidebar.write } : {}),
          }
        : {}),
      media: () => undefined,
      subscribe(value) {
        callbacks = value;
        callbacks.state({ status: "connected", routes: [] });
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      identityNames: {
        register() {},
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [createAgentDirectory()],
            subscribe: () => () => {},
          }),
      },
      sidebarStorage: {
        async update(change) {
          await (typeof readBarrier === "function"
            ? readBarrier()
            : readBarrier);
          return bff.storage.update(change);
        },
        close() {},
      },
    },
  );
  cleanups.push(owner.dispose);
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  cleanups.push(() => ctx.fiber.dispose());
  const navigation = provideNavigation(ctx);
  const data = new Map<string, string>();
  const preferences = createNotificationPreferences({
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window);
  let click = () => {};
  const show = vi.fn(async (_item, activate: () => void) => {
    click = activate;
  });
  const permission = vi.fn(async (): Promise<"granted"> => "granted");
  const listeners = new Set<() => void>();
  let selected: string | null = origin;
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const communities = {
    snapshot: () => ({
      status: "ready",
      viewer: viewer.pubkey,
      selected,
      memberships: [{ id: origin, name: "Example" }],
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    relay: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as Communities;
  const notifications = new NotificationsService(
    ctx,
    navigation.navigation,
    {
      label: "Test platform",
      permission,
      requestPermission: async () => "granted",
      show,
      dispose() {},
    },
    preferences,
    (target) => notificationAuthorized(communities, target),
  );
  const discover = () => {
    bff.rows.set(
      "01234567-89ab-cdef-0123-456789abcdef",
      sidebarRow("01234567-89ab-cdef-0123-456789abcdef"),
    );
    callbacks.receive([
      roster(relay, "01234567-89ab-cdef-0123-456789abcdef", [viewer.pubkey]),
      metadata(relay, "01234567-89ab-cdef-0123-456789abcdef", "Room"),
    ]);
  };
  // Channels starts the same shared observation once the roster is ready.
  if (remote?.channelsMounted) {
    discover();
    void owner.session.unread.ensure();
  }
  const stop = bindMessageNotifications(notifications, communities);
  cleanups.push(stop);
  await flush();
  // Names retain owner inventory independently of notification/roster startup.
  await vi.waitFor(() =>
    expect(owner.session.agentLibrary.snapshot().status).toBe("ready"),
  );
  notifications.updatePreferences({ sound: false });
  const emit = (
    events: ReturnType<typeof message>[],
    phase?: "replay" | "live",
    channelId = "01234567-89ab-cdef-0123-456789abcdef",
  ) => {
    for (const event of events) {
      if (event.kind === 5 || event.kind === 9005) {
        for (const [name, id] of event.tags)
          if (name === "e" && id) observed.delete(id);
      } else observed.set(event.id, event);
    }
    callbacks.receive(events, phase ? { phase, channelId } : undefined);
  };
  if (!remote?.channelsMounted && !remote?.deferRoster) discover();
  const make = (text: string, age = 0, author = peer) =>
    message(
      author,
      "01234567-89ab-cdef-0123-456789abcdef",
      text,
      Math.floor(Date.now() / 1000) - age,
      [["p", viewer.pubkey]],
    );
  return {
    owner,
    notifications,
    navigation,
    emit,
    make,
    async retain(row: RelayEvent) {
      const stop = owner.session.unread.subscribe(
        {
          kind: "message",
          channelId: "01234567-89ab-cdef-0123-456789abcdef",
          messageId: row.id,
        },
        () => {},
      );
      cleanups.push(stop);
      await vi.waitFor(() =>
        expect(
          owner.session.unread.attention(
            "01234567-89ab-cdef-0123-456789abcdef",
            row.id,
          ).status,
        ).not.toBe("unknown"),
      );
    },
    show,
    permission,
    query,
    sidebarQuery,
    bff,
    contextQuery,
    stop,
    discover,
    peer,
    relay,
    viewer,
    click: () => click(),
    deselect() {
      selected = null;
      for (const listener of listeners) listener();
    },
  };
}
