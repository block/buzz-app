import type { LocalAgentSource } from "../agents/local-activity";
import { readView } from "../../shared/view-state";
import type { LocalAgents } from "../agents/local";
import type { IdentityNames } from "../identity-names/service";
import type { PresenceActivity } from "../presence/activity";
import type { Context } from "@deepseek-ai/cordis";
import { createRelaySession, type RelaySession } from "./session";
import { createHeadPersistence } from "./persistence";
import {
  relayPartition,
  transportOrigin,
  transportPartition,
} from "./partition";
import { isTransientFailure, ReadError, readErrorKind } from "./errors";
import { RECOVERY_DELAYS_MS } from "./recovery";
import type { ReadTransport } from "./transport";
import { liveReconnectDelay } from "./live";
const WAKE_TICK_MS = 5_000;
const WAKE_GAP_MS = 15_000;

export type RelaySnapshot = Readonly<{
  status: "disconnected" | "connecting" | "ready" | "error";
  generation: number;
  /** The persistence partition, `origin:viewer`. */
  scope?: string;
  /** The community's normalized origin, as `scope` was built from. */
  origin?: string;
  session: RelaySession;
  viewer?: string;
  error?: string;
  /** A usable device snapshot while the real transport is connecting/unavailable. */
  cached?: true;
  /** Only local disk bootstrap is pending; never waits for the network. */
  restoring?: true;
  /** This error is transient: the service reconnects without anyone acting. */
  retrying?: true;
  /** The community refused this account; not a connection problem. */
  denied?: true;
  /** The organization session doesn't admit this community now: its saved
   * history stays on disk but out of memory until sign-in. */
  locked?: true;
}>;
/** An organization community's access to its saved history. */
export type RelayGate = {
  /** Whether this community needs the organization session at all. */
  protects(): Promise<boolean | undefined>;
  /** Whether the organization session admits its saved history now. */
  admits(viewer?: string): boolean;
  canConnect?(viewer?: string): boolean;
  subscribe(listener: () => void): () => void;
};
/** The error a locked community carries; CommunitySignIn offers Sign in. */
const LOCKED = "Federated sign-in is required";
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
  agentChoices?: LocalAgents,
  resume?: { viewer: string; scope: string },
  localAgents?: LocalAgentSource,
  gate?: RelayGate,
) {
  let disposed = false;
  /** The gate's answer to `protects`, once known. */
  let guarded: boolean | undefined = gate ? undefined : false;
  let generation = 0;
  let controller: AbortController | undefined;
  let connecting = false;
  let clearing: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let store = createRelaySession(null, { identityNames });
  let snapshot: RelaySnapshot = Object.freeze({
    status: "disconnected",
    generation,
    session: store.session,
  });
  const listeners = new Set<() => void>();
  // A connection that failed for a transient reason (network, timeout) always
  // tries again. Only disconnect() stops trying. A denial or a deterministic
  // failure keeps its error visible and waits for the user.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnects = 0;
  // A policy bounce can follow successful AUTH, so it must survive `ready`.
  let admissionReconnects = 0;
  /** Whether the latest connection failure can clear without anyone acting.
   * Later publishes of the same failure (cache handoff) keep it. */
  let transientFailure = false;
  const publish = ({ retrying: _retrying, ...next }: RelaySnapshot) => {
    if (next.status !== "error") transientFailure = false;
    snapshot = Object.freeze(
      transientFailure && !disposed
        ? { ...next, retrying: true as const }
        : next,
    );
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (next.status === "ready" && !next.cached) reconnects = 0;
    else if (next.status === "error" && transientFailure && !disposed)
      reconnectTimer = setTimeout(
        () => service.retry(),
        RECOVERY_DELAYS_MS[
          Math.min(reconnects++, RECOVERY_DELAYS_MS.length - 1)
        ] ?? 30_000,
      );
    for (const listener of listeners) listener();
  };
  const reset = () => {
    generation++;
    connecting = false;
    controller?.abort();
    clearTimeout(deadline);
    store.dispose();
    store = createRelaySession(null, { identityNames });
  };
  const shut = (viewer = resume?.viewer ?? snapshot.viewer) =>
    guarded !== false && !!gate && !gate.admits(viewer);
  /** Drops everything this community holds in memory, keeping the disk. */
  const lock = () => {
    reset();
    transientFailure = false;
    publish({
      status: "error",
      generation,
      session: store.session,
      error: LOCKED,
      locked: true,
    });
  };
  async function restoreLocal(current: number, signal: AbortSignal) {
    if (!resume) return;
    const persistence = createHeadPersistence(resume.viewer, resume.scope);
    let cached: ReturnType<typeof createRelaySession> | undefined;
    let handedOff = false;
    try {
      // Decide before anything reaches memory: a locked organization
      // community's history stays on disk.
      if (gate) {
        guarded = await gate.protects();
        if (shut()) return;
      }
      const saved = (await persistence.readStartup?.())?.discovery;
      if (
        !saved ||
        !/^[0-9a-f]{64}$/.test(saved.relayAuthor) ||
        disposed ||
        current !== generation ||
        signal.aborted
      )
        return;
      cached = createRelaySession(
        {
          viewer: resume.viewer,
          scope: resume.scope,
          relayAuthor: saved.relayAuthor,
          query: () =>
            Promise.reject(
              new ReadError(
                "unavailable",
                "Reconnect to update saved conversations.",
              ),
            ),
          media: () => undefined,
        },
        {
          identityNames,
          prepared: true,
          cachedOnly: true,
          persistence,
          initialChannelId: readView<string | undefined>(
            relayPartition(resume.scope, resume.viewer),
            "selected-channel",
            undefined,
          ),
        },
      );
      await cached.restore();
      if (
        disposed ||
        current !== generation ||
        signal.aborted ||
        !cached.session.channels.list().channels.length
      )
        return;
      store.dispose();
      store = cached;
      cached = undefined;
      handedOff = true;
      publish({
        status: connecting ? "connecting" : "error",
        cached: true,
        generation,
        viewer: resume.viewer,
        origin: resume.scope,
        scope: relayPartition(resume.scope, resume.viewer),
        session: store.session,
      });
    } catch {
      // Resume is an optimization; connection can still open an empty/corrupt cache.
    } finally {
      cached?.dispose();
      if (!handedOff) persistence.close();
      if (
        !disposed &&
        current === generation &&
        signal === controller?.signal &&
        snapshot.restoring
      ) {
        const { restoring: _restoring, ...settled } = snapshot;
        publish(settled);
      }
    }
  }
  const service: RelayData & {
    /** The federated session changed to signed in: retry what it refused. */
    reauthorize(): void;
  } = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (disposed || !connect || clearing) return;
      if (connecting) {
        if (guarded === undefined && gate) {
          const current = generation;
          void gate.protects().then((value) => {
            if (!disposed && current === generation) guarded = value;
          });
        }
        return;
      }
      const retained = snapshot.cached;
      if (!retained) reset();
      connecting = true;
      const current = generation;
      controller = new AbortController();
      const signal = controller.signal;
      if (!retained)
        publish({
          status: "connecting",
          generation,
          session: store.session,
          // Only the first attempt bootstraps from disk behind the launch
          // surface; a retry after a failure keeps the app on screen.
          ...(shut()
            ? { status: "error" as const, locked: true as const, error: LOCKED }
            : resume && snapshot.status !== "error"
              ? { restoring: true as const }
              : {}),
        });
      else {
        const { error: _error, ...retainedSnapshot } = snapshot;
        publish({ ...retainedSnapshot, status: "connecting" });
      }
      const restoring = retained
        ? Promise.resolve()
        : restoreLocal(current, signal);
      const timeout = () => {
        if (disposed || current !== generation || signal !== controller?.signal)
          return;
        controller.abort();
        connecting = false;
        transientFailure = true;
        publish({
          ...snapshot,
          status: "error",
          error: "Relay connection timed out. Try again.",
        });
      };
      let timer = setTimeout(timeout, 8_000);
      deadline = timer;
      void Promise.resolve()
        .then(async () => {
          if (gate) guarded = await gate.protects();
          signal.throwIfAborted();
          if (shut() && gate?.canConnect?.(resume?.viewer) === false)
            return undefined;
          return connect(signal);
        })
        .then(async (transport) => {
          clearTimeout(timer);
          await restoring;
          if (!transport) return;
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          )
            return;
          if (gate) guarded = await gate.protects();
          if (shut(transport.viewer)) {
            // Open only the socket: session construction itself reads the outbox
            // and sidebar cache. Fresh admission costs one temporary connection;
            // saved admission skips it. Native open allows 90s, then AUTH 10s.
            clearTimeout(timer);
            deadline = timer = setTimeout(timeout, 100_000);
            let proof:
              | ReturnType<NonNullable<ReadTransport["subscribe"]>>
              | undefined;
            try {
              await new Promise<void>((resolve, reject) => {
                let stop: (() => void) | undefined;
                const finish = (error?: unknown) => {
                  stop?.();
                  signal.removeEventListener("abort", check);
                  if (error) reject(error);
                  else resolve();
                };
                const check = () => {
                  if (signal.aborted) finish(signal.reason);
                  else if (!shut(transport.viewer)) finish();
                  else if (gate?.canConnect?.(transport.viewer) === false)
                    finish(new Error(LOCKED));
                };
                stop = gate?.subscribe(check);
                signal.addEventListener("abort", check, { once: true });
                if (!transport.subscribe) {
                  finish(
                    new ReadError(
                      "unavailable",
                      "Community access could not be confirmed.",
                    ),
                  );
                  return;
                }
                try {
                  proof = transport.subscribe({
                    receive: () => {},
                    established: () => {},
                    denied: () => {},
                    state: (state) => {
                      if (state.status === "error")
                        finish(
                          new ReadError(
                            "unavailable",
                            state.error ??
                              "Community access could not be confirmed.",
                          ),
                        );
                    },
                  });
                  check();
                } catch (error) {
                  finish(error);
                }
              });
            } finally {
              clearTimeout(timer);
              proof?.dispose();
            }
          }
          signal.throwIfAborted();
          // Admission can be revoked after the waiter resolves but before this
          // continuation runs. Constructors load saved state synchronously.
          if (shut(transport.viewer)) throw new Error(LOCKED);
          const successor = createRelaySession(transport, {
            identityNames,
            agentChoices,
            localAgents,
            ...(presenceActivity ? { presenceActivity } : {}),
            prepared: true,
            // Keep intent preparation, but do not fetch every unopened channel.
            warm: false,
            initialChannelId: readView<string | undefined>(
              transportPartition(transport),
              "selected-channel",
              undefined,
            ),
            persistence: createHeadPersistence(
              transport.viewer,
              transportOrigin(transport),
            ),
          });
          try {
            signal.throwIfAborted();
            await successor.restore();
          } catch (error) {
            successor.dispose();
            throw error;
          }
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          ) {
            successor.dispose();
            return;
          }
          // Without a resume, restoreLocal never asked the gate.
          if (gate) guarded = await gate.protects();
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          ) {
            successor.dispose();
            return;
          }
          if (shut(transport.viewer)) {
            successor.dispose();
            lock();
            return;
          }
          // Materialize retained readers before publishing so React never sees
          // an idle window between two already-hydrated owners.
          for (const id of store.retainedChannels())
            successor.session.channels.ensure(id);
          store.dispose();
          store = successor;
          publish({
            status: "ready",
            generation,
            viewer: transport.viewer,
            origin: transportOrigin(transport),
            scope: transportPartition(transport),
            session: store.session,
          });
          store.session.channels.ensureList();
        })
        .catch(async (error) => {
          await restoring;
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          )
            return;
          if (readErrorKind(error) === "denied") {
            await store.clearCache();
            if (resume) {
              const disk = createHeadPersistence(resume.viewer, resume.scope);
              try {
                await disk.clear();
              } catch {
                /* Storage can be unavailable. */
              } finally {
                disk.close();
              }
            }
            if (
              disposed ||
              signal.aborted ||
              current !== generation ||
              signal !== controller?.signal
            )
              return;
            store.dispose();
            store = createRelaySession(null, { identityNames });
            transientFailure = false;
            publish({
              status: "error",
              generation,
              session: store.session,
              error: String(error),
              denied: true,
            });
          } else {
            transientFailure = isTransientFailure(error);
            publish({
              ...snapshot,
              status: "error",
              error: String(error),
            });
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (current === generation && signal === controller?.signal)
            connecting = false;
        });
    },
    reauthorize() {
      if (disposed) return;
      if (snapshot.status === "error") service.retry();
      else store.session.recovery?.retryAll();
    },
    disconnect() {
      if (disposed) return;
      reset();
      publish({ status: "disconnected", generation, session: store.session });
    },
    clearCache() {
      if (clearing) return clearing;
      if (disposed) return Promise.resolve();
      // Clearing owns a separate fence: an aborted connection's finally cannot
      // release it and let retry restore records still being deleted from disk.
      const current = generation;
      const reconnect = connecting || snapshot.cached;
      const retainedStore = store;
      controller?.abort();
      clearTimeout(deadline);
      connecting = false;
      clearing = Promise.resolve()
        .then(async () => {
          await retainedStore.clearCache();
          if (resume) {
            const disk = createHeadPersistence(resume.viewer, resume.scope);
            try {
              await disk.clear();
            } catch {
              /* Storage can be unavailable. */
            } finally {
              disk.close();
            }
          }
        })
        .finally(() => {
          clearing = undefined;
          if (!disposed && current === generation && reconnect) service.retry();
        });
      return clearing;
    },
  };
  ctx.provide("relay", service);
  if (gate) {
    const check = () => {
      if (disposed || guarded === false) return;
      if (shut()) {
        if (!snapshot.locked) {
          const reconnect = gate.canConnect?.(
            resume?.viewer ?? snapshot.viewer,
          );
          lock();
          if (reconnect) {
            const backoff =
              RECOVERY_DELAYS_MS[
                Math.min(admissionReconnects++, RECOVERY_DELAYS_MS.length - 1)
              ] ?? 30_000;
            reconnectTimer = setTimeout(
              () => service.retry(),
              liveReconnectDelay(1008, backoff, Math.random),
            );
          }
        }
      } else if (snapshot.locked) service.retry();
    };
    void gate.protects().then((protects) => {
      guarded = protects;
      check();
    });
    ctx.effect(() => gate.subscribe(check));
  }
  ctx.effect(() => {
    // Network, focus and wake are hints that the relay may answer again.
    // Failed background reads retry now; healthy sessions do no extra work.
    const online = () => {
      if (snapshot.cached || snapshot.locked) service.retry();
      else store.session.recovery?.retryNow();
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      if (snapshot.cached || snapshot.locked) service.retry();
      else store.session.recovery?.retryNow();
    };
    // Timers stop while the machine sleeps. A large gap between ticks means
    // it woke up, which a desktop window does not always report as focus.
    let tick = Date.now();
    const wake = setInterval(() => {
      const now = Date.now();
      if (now - tick > WAKE_GAP_MS) online();
      tick = now;
    }, WAKE_TICK_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("online", online);
      window.addEventListener("focus", online);
    }
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearInterval(wake);
      clearTimeout(reconnectTimer);
      reset();
      listeners.clear();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", online);
        window.removeEventListener("focus", online);
      }
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visible);
    };
  });
  service.retry();
  return service;
}
