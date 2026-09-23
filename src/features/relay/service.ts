import {
  browserCheckpointStorage,
  type CheckpointStorage,
} from "./checkpoint-storage";
import { createPresentation, type Presentation } from "./presentation";
import type { SidebarDecoder } from "./sidebar-preferences";
import type { IdentityNames } from "../identity-names/service";
import type { PresenceActivity } from "../presence/activity";
import type { Context } from "@deepseek-ai/cordis";
import { createRelaySession, type RelaySession } from "./session";
import { createHeadPersistence } from "./persistence";
import type { ReadTransport } from "./transport";

export type RelaySnapshot = Readonly<{
  status: "disconnected" | "connecting" | "ready" | "error";
  generation: number;
  scope?: string;
  session: RelaySession;
  viewer?: string;
  presentation?: Presentation | undefined;
  rosterReady?: boolean | undefined;
  presentationPending?: boolean | undefined;
  error?: string;
}>;
export type RelayData = {
  snapshot(): RelaySnapshot;
  subscribe(listener: () => void): () => void;
  retry(): void;
  disconnect(): void;
  clearCache(): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    relay: RelayData;
  }
}

/** App-owned session. Plugins receive read models, never a signer or transport.
 * Reconnection replaces the session and invalidates all old async work. */
export function provideRelay(
  ctx: Context,
  connect?: (signal: AbortSignal) => Promise<ReadTransport>,
  presenceActivity?: PresenceActivity,
  identityNames?: IdentityNames,
  local?: {
    viewer: string;
    community: string;
    decode: SidebarDecoder;
    storage?: CheckpointStorage;
  },
) {
  let disposed = false;
  let generation = 0;
  let clearing = 0;
  let controller: AbortController | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let store = createRelaySession(null, { identityNames });
  let snapshot: RelaySnapshot = Object.freeze({
    status: "disconnected",
    generation,
    session: store.session,
  });
  const listeners = new Set<() => void>();
  const publish = (next: RelaySnapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const presentation = local
    ? createPresentation(
        local.viewer,
        local.community,
        local.storage ??
          browserCheckpointStorage(`${local.community}:${local.viewer}`),
        local.decode,
        () => {
          if (
            disposed ||
            clearing ||
            (snapshot.presentation === presentation?.snapshot() &&
              snapshot.presentationPending === presentation?.pending())
          )
            return;
          publish({
            ...snapshot,
            presentation: presentation?.snapshot(),
            presentationPending: presentation?.pending(),
          });
        },
      )
    : undefined;
  let stops: (() => void)[] = [];
  const localFields = () =>
    local
      ? {
          viewer: local.viewer,
          scope: `${local.community}:${local.viewer}`,
          presentation: presentation?.snapshot(),
          presentationPending: presentation?.pending(),
        }
      : {};
  const reset = () => {
    for (const stop of stops.splice(0)) stop();
    generation++;
    controller?.abort();
    clearTimeout(deadline);
    store.dispose();
    store = createRelaySession(null, { identityNames });
  };
  const service: RelayData = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (disposed || !connect || snapshot.status === "connecting") return;
      reset();
      const current = generation;
      controller = new AbortController();
      const signal = controller.signal;
      publish({
        ...localFields(),
        status: "connecting",
        generation,
        session: store.session,
      });
      const timer = setTimeout(() => {
        if (disposed || current !== generation) return;
        controller?.abort();
        publish({
          ...localFields(),
          status: "error",
          generation,
          session: store.session,
          error: "Relay connection timed out. Try again.",
        });
      }, 8_000);
      deadline = timer;
      void Promise.resolve()
        .then(() => connect(signal))
        .then(
          (transport) => {
            if (disposed || signal.aborted || current !== generation) return;
            if (
              local &&
              (transport.viewer !== local.viewer ||
                transport.scope !== local.community)
            ) {
              void presentation?.clear();
              if (disposed || signal.aborted || current !== generation) return;
              publish({
                status: "error",
                generation,
                session: store.session,
                error: "Community identity changed. Reopen the community.",
              });
              return;
            }
            presentation?.connect(transport.relayAuthor);
            if (disposed || signal.aborted || current !== generation) return;
            store.dispose();
            store = createRelaySession(transport, {
              identityNames,
              ...(presenceActivity ? { presenceActivity } : {}),
              prepared: true,
              // Keep intent preparation, but do not fetch every unopened channel.
              warm: false,
              persistence: createHeadPersistence(
                transport.viewer,
                transport.scope ?? transport.relayAuthor,
              ),
            });
            const update = () => {
              if (disposed || clearing || current !== generation) return;
              const evidence = store.presentation();
              presentation?.accept(evidence);
              if (disposed || signal.aborted || current !== generation) return;
              if (
                snapshot.presentation !== presentation?.snapshot() ||
                snapshot.rosterReady !== evidence.ready
              )
                publish({
                  ...snapshot,
                  presentation: presentation?.snapshot(),
                  rosterReady: evidence.ready,
                });
            };
            stops = [
              store.session.channels.subscribeList(update),
              store.session.profiles.subscribe(update),
              store.session.sidebarPreferences.subscribe(update),
            ];
            publish({
              ...localFields(),
              status: "ready",
              generation,
              viewer: transport.viewer,
              scope: `${transport.scope ?? transport.relayAuthor}:${transport.viewer}`,
              session: store.session,
            });
            if (disposed || signal.aborted || current !== generation) return;
            update();
            store.session.channels.ensureList();
            if (local) void store.session.sidebarPreferences.ensure();
          },
          (error) => {
            if (disposed || signal.aborted || current !== generation) return;
            publish({
              ...localFields(),
              status: "error",
              generation,
              session: store.session,
              error: String(error),
            });
          },
        )
        .finally(() => clearTimeout(timer));
    },
    disconnect() {
      if (disposed) return;
      reset();
      // Clearing synchronously notifies presentation subscribers. Do not expose
      // the disposed ready session between reset and disconnected publication.
      clearing++;
      try {
        void presentation?.clear();
      } finally {
        clearing--;
      }
      publish({ status: "disconnected", generation, session: store.session });
    },
    async clearCache() {
      // Clear the existing owner, as before: disposing it first closes the
      // IndexedDB handle before its pending deletion can start.
      const owner = store;
      const current = generation;
      clearing++;
      try {
        await Promise.all([owner.clearCache(), presentation?.clear()]);
      } finally {
        clearing--;
        if (!disposed && !clearing && current === generation)
          publish({ ...snapshot, ...localFields() });
      }
    },
  };
  ctx.provide("relay", service);
  ctx.effect(() => {
    const visible = () => {
      if (document.visibilityState === "visible")
        store.session.channels.refreshList?.();
    };
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      reset();
      presentation?.dispose();
      listeners.clear();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visible);
    };
  });
  service.retry();
  return service;
}
