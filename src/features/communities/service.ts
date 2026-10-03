// FOUNDATION: Client identity and membership selection outlive community query sessions.
import type { AgentControl } from "../agents/control";
import type { IdentityNames } from "../identity-names/service";
import { createPresenceActivity } from "../presence/activity";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay, type RelayData } from "../relay/service";
import { connectBrokerTransport, type ReadTransport } from "../relay/transport";
import { communityDestination, isCommunityAlias } from "./destination";
import { purgeCommunityDeviceState, type PurgeFailure } from "./device-state";
import type { EnterpriseAuthClient } from "./enterpriseAuthApi";

export const PROFILE_ABOUT_MAX_LENGTH = 500;
export type PersonalProfile = { name: string; picture: string; about?: string };
export type Membership = { id: string; name: string; icon?: string };
type Saved = {
  profile: PersonalProfile;
  memberships: Membership[];
  selected: string | null;
};
export type ClientSnapshot = Saved & {
  status: "loading" | "ready" | "unavailable";
  // A restored identity does not imply that this build has relay transport.
  relayAvailable: boolean;
  viewer?: string;
  error?: string;
  enterprise?: EnterpriseLoginSnapshot | undefined;
};
export type EnterpriseLoginSnapshot = {
  communityId: string;
  status: "required" | "opening" | "error";
  errorKind?: "discovery" | "login";
  error?: string;
};
export class EnterpriseLoginRequired extends Error {
  constructor(readonly communityId: string) {
    super("Enterprise sign-in is required for this community");
    this.name = "EnterpriseLoginRequired";
  }
}
export class EnterpriseDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EnterpriseDiscoveryError";
  }
}
/** Read-only membership inventory; does not acquire or select relay sessions. */
export type CommunityReader = {
  snapshot(): ClientSnapshot;
  subscribe(listener: () => void): () => void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    communityReader: CommunityReader;
  }
}
const empty = (): Saved => ({
  profile: { name: "", picture: "", about: "" },
  memberships: [],
  selected: null,
});
export function createCommunities(
  ctx: Context,
  live: boolean,
  identityNames?: IdentityNames,
  openRelay = "",
  agentChoices?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh">,
  identityReady?: Promise<string>,
  nativeConnect?: (id: string, signal: AbortSignal) => Promise<ReadTransport>,
  enterpriseAuth?: EnterpriseAuthClient,
) {
  const baseConnect = live
    ? (id: string, signal: AbortSignal) =>
        connectBrokerTransport("", signal, id)
    : identityReady
      ? nativeConnect
      : undefined;
  let state: ClientSnapshot = {
    ...empty(),
    status: live || identityReady ? "loading" : "unavailable",
    relayAvailable: !!baseConnect,
  };
  // Retain temporarily unresolvable deployment aliases in storage, not active UI/sessions.
  const unresolvedMemberships: Membership[] = [];
  let unresolvedSelection: string | null = null;
  let disposed = false;
  const controller = new AbortController();
  const presenceActivity = createPresenceActivity();
  const listeners = new Set<() => void>();
  const relayListeners = new Set<() => void>();
  const sessions = new Map<string, RelayData>();
  let enterpriseAttempt:
    | { communityId: string; attemptId: string; owner: string }
    | undefined;
  const enterpriseCheckVersions = new Map<string, number>();
  const enterpriseChecksInFlight = new Set<string>();
  const enterpriseCommunities = new Set<string>();
  let enterpriseClearInFlight: Promise<string[]> | undefined;
  // Each session owns a scope so leaving can dispose exactly that one.
  const sessionScopes = new Map<string, Context>();
  const scopes: Context[] = [];
  const disconnected = provideRelay(
    newScope(),
    undefined,
    presenceActivity,
    identityNames,
  );
  function newScope() {
    const scope = new Context();
    scopes.push(scope);
    return scope;
  }
  const current = () =>
    state.selected
      ? (sessions.get(state.selected) ?? disconnected)
      : disconnected;
  const emitRelay = () => {
    for (const fn of relayListeners) fn();
  };
  const update = (
    patch: Partial<ClientSnapshot>,
    persist = true,
    required = false,
  ) => {
    const next = { ...state, ...patch };
    // Commit a deliberate selection only after required persistence succeeds.
    const selection =
      persist && Object.hasOwn(patch, "selected") ? null : unresolvedSelection;
    try {
      if (persist && next.viewer)
        localStorage.setItem(
          `buzz-client.v1:${next.viewer}`,
          JSON.stringify({
            profile: next.profile,
            memberships: [...next.memberships, ...unresolvedMemberships],
            selected: next.selected ?? selection,
          }),
        );
    } catch (error) {
      // The storage error rides along as the cause so a caller can name it: a
      // store that never saves should not read as the same retry every time.
      if (required)
        throw new Error(
          "Could not save this community on this device. Try again.",
          { cause: error },
        );
      // Preferences are best effort; storage failure must not strand a remote join.
    }
    unresolvedSelection = selection;
    state = next;
    for (const fn of listeners) fn();
    emitRelay();
  };
  const disposedError = () =>
    new DOMException("Community service was disposed", "AbortError");
  const supersededEnterpriseCheckError = () =>
    new DOMException(
      "Enterprise authentication check was superseded",
      "AbortError",
    );
  const nextEnterpriseCheck = (communityId: string) => {
    const version = (enterpriseCheckVersions.get(communityId) ?? 0) + 1;
    enterpriseCheckVersions.set(communityId, version);
    return version;
  };
  const currentEnterpriseCheck = (communityId: string, version: number) =>
    !disposed && enterpriseCheckVersions.get(communityId) === version;
  const clearEnterprisePrompt = (communityId: string, version?: number) => {
    if (disposed) return;
    if (
      version !== undefined &&
      enterpriseCheckVersions.get(communityId) !== version
    )
      return;
    if (
      state.enterprise?.communityId === communityId &&
      enterpriseAttempt?.communityId !== communityId
    )
      update({ enterprise: undefined }, false);
  };
  const publishEnterprise = (
    communityId: string,
    version: number,
    status: EnterpriseLoginSnapshot["status"],
    error?: string,
    errorKind?: EnterpriseLoginSnapshot["errorKind"],
  ) => {
    if (!currentEnterpriseCheck(communityId, version)) return;
    // A gate check can finish while the browser attempt is open. Its result
    // must not replace the attempt's owned opening/error state.
    if (enterpriseAttempt?.communityId === communityId) return;
    if (
      state.enterprise &&
      state.enterprise.communityId !== communityId &&
      state.enterprise.status === "opening"
    )
      return;
    update(
      {
        enterprise: {
          communityId,
          status,
          ...(errorKind ? { errorKind } : {}),
          ...(error ? { error } : {}),
        },
      },
      false,
    );
  };
  const retireEnterprisePrompt = (communityId: string) => {
    nextEnterpriseCheck(communityId);
    enterpriseChecksInFlight.delete(communityId);
    if (state.enterprise?.communityId === communityId)
      update({ enterprise: undefined }, false);
  };
  const waitFor = <T>(operation: Promise<T>, signal: AbortSignal) => {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).then(
        () => signal.removeEventListener("abort", abort),
        () => signal.removeEventListener("abort", abort),
      );
    });
  };
  async function requireEnterpriseLogin(
    id: string,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (disposed) throw disposedError();
    if (!enterpriseAuth || live || !baseConnect) return;
    const version = nextEnterpriseCheck(id);
    enterpriseChecksInFlight.add(id);
    let required = false;
    try {
      if (!(await waitFor(enterpriseAuth.gate(id), signal))) {
        if (!currentEnterpriseCheck(id, version))
          throw supersededEnterpriseCheckError();
        enterpriseCommunities.delete(id);
        clearEnterprisePrompt(id, version);
        return version;
      }
      if (!currentEnterpriseCheck(id, version))
        throw supersededEnterpriseCheckError();
      enterpriseCommunities.add(id);
      if (await waitFor(enterpriseAuth.get(), signal)) {
        if (!currentEnterpriseCheck(id, version))
          throw supersededEnterpriseCheckError();
        clearEnterprisePrompt(id, version);
        return version;
      }
      if (!currentEnterpriseCheck(id, version))
        throw supersededEnterpriseCheckError();
      required = true;
    } catch (reason) {
      if (signal.aborted || !currentEnterpriseCheck(id, version)) throw reason;
      const error =
        reason instanceof EnterpriseDiscoveryError
          ? reason
          : new EnterpriseDiscoveryError(
              reason instanceof Error ? reason.message : String(reason),
              { cause: reason },
            );
      publishEnterprise(id, version, "error", error.message, "discovery");
      throw error;
    } finally {
      if (enterpriseCheckVersions.get(id) === version)
        enterpriseChecksInFlight.delete(id);
    }
    if (required) publishEnterprise(id, version, "required");
    throw new EnterpriseLoginRequired(id);
  }
  const connect = baseConnect
    ? async (id: string, signal: AbortSignal) => {
        if (disposed) throw disposedError();
        const clear = enterpriseClearInFlight;
        if (clear) await clear;
        if (disposed) throw disposedError();
        const version = await requireEnterpriseLogin(id, signal);
        if (disposed) throw disposedError();
        if (version !== undefined && !currentEnterpriseCheck(id, version))
          throw supersededEnterpriseCheckError();
        if (enterpriseClearInFlight) {
          await enterpriseClearInFlight;
          throw supersededEnterpriseCheckError();
        }
        return baseConnect(id, signal);
      }
    : undefined;
  const acquire = (id: string, viewer = state.viewer) => {
    if (!connect) return disconnected;
    let session = sessions.get(id);
    if (!session) {
      const scope = newScope();
      session = provideRelay(
        scope,
        (signal) => connect(id, signal),
        presenceActivity,
        identityNames,
        agentChoices,
        viewer ? { viewer, scope: communityDestination(id).url } : undefined,
      );
      sessions.set(id, session);
      sessionScopes.set(id, scope);
      session.subscribe(() => {
        if (state.selected === id) emitRelay();
      });
    }
    return session;
  };
  // Compatibility reader for bundled plugins; captured commands remain bound to their concrete session.
  const relay: RelayData = {
    snapshot: () => current().snapshot(),
    subscribe(fn) {
      relayListeners.add(fn);
      return () => {
        relayListeners.delete(fn);
      };
    },
    retry: () => current().retry(),
    disconnect: () => current().disconnect(),
    clearCache: () => current().clearCache(),
  };
  ctx.provide("relay", relay);
  const identity =
    identityReady ??
    (live
      ? fetch("/api/relay/identity", { signal: controller.signal }).then(
          async (response) => {
            if (!response.ok) throw new Error("Local identity unavailable");
            const { viewer } = await response.json();
            return viewer as string;
          },
        )
      : undefined);
  if (identity)
    void identity
      .then((viewer) => {
        if (typeof viewer !== "string" || !/^[a-f0-9]{64}$/.test(viewer))
          throw new Error("Invalid local identity");
        if (disposed) return;
        let saved = empty();
        let seeded = false;
        try {
          const stored = localStorage.getItem(`buzz-client.v1:${viewer}`);
          const raw = JSON.parse(stored ?? "null");
          if (raw)
            saved = {
              profile: {
                name:
                  typeof raw.profile?.name === "string" ? raw.profile.name : "",
                picture:
                  typeof raw.profile?.picture === "string"
                    ? raw.profile.picture
                    : "",
                about:
                  typeof raw.profile?.about === "string"
                    ? raw.profile.about
                    : "",
              },
              memberships: Array.isArray(raw.memberships)
                ? raw.memberships
                    .flatMap((m: unknown): Membership[] => {
                      if (
                        !m ||
                        typeof m !== "object" ||
                        !("id" in m) ||
                        typeof m.id !== "string" ||
                        !("name" in m) ||
                        typeof m.name !== "string"
                      )
                        return [];
                      const membership = {
                        id: m.id,
                        name: m.name,
                        ...("icon" in m &&
                        typeof m.icon === "string" &&
                        m.icon.startsWith("https://")
                          ? { icon: m.icon }
                          : {}),
                      };
                      try {
                        return [
                          { ...membership, id: communityDestination(m.id).id },
                        ];
                      } catch {
                        if (
                          isCommunityAlias(m.id) &&
                          !unresolvedMemberships.some(
                            (entry) => entry.id === m.id,
                          )
                        )
                          unresolvedMemberships.push(membership);
                        return [];
                      }
                    })
                    .filter(
                      (m: Membership, index: number, all: Membership[]) =>
                        all.findIndex((entry) => entry.id === m.id) === index,
                    )
                : [],
              selected: null,
            };
          else if (openRelay && stored === null) {
            // Development opt-in for a viewer with no saved record on this origin.
            // Any stored record, including Personal space or one this reader
            // cannot understand, wins over the seed.
            const { id, name } = communityDestination(openRelay);
            saved = { ...saved, memberships: [{ id, name }], selected: id };
            seeded = true;
          }
          if (typeof raw?.selected === "string") {
            try {
              saved.selected = communityDestination(raw.selected).id;
            } catch {
              if (unresolvedMemberships.some((m) => m.id === raw.selected))
                unresolvedSelection = raw.selected;
            }
          }
        } catch {
          /* Invalid local preferences do not prevent opening the client. */
        }
        if (!saved.memberships.some((m) => m.id === saved.selected))
          saved.selected = null;
        presenceActivity.setViewer(viewer);
        if (saved.selected) acquire(saved.selected, viewer);
        // A seeded record is saved once so later configuration changes cannot revoke it.
        update({ ...saved, viewer, status: "ready" }, seeded);
      })
      .catch((error) => {
        if (!disposed)
          update({ status: "unavailable", error: String(error) }, false);
      });
  ctx.effect(() => () => {
    disposed = true;
    controller.abort();
    const attempt = enterpriseAttempt;
    enterpriseAttempt = undefined;
    presenceActivity.dispose();
    listeners.clear();
    relayListeners.clear();
    const cancel =
      attempt && enterpriseAuth
        ? enterpriseAuth.cancel(attempt.attemptId).catch((error) => {
            console.warn(
              "Couldn't cancel enterprise login during cleanup",
              error,
            );
          })
        : Promise.resolve();
    return Promise.all([
      cancel,
      ...scopes.map((scope) => scope.fiber.dispose()),
    ]).then(() => {});
  });
  async function startEnterpriseLogin(communityId?: string, owner = "app") {
    const pending =
      state.enterprise &&
      (!communityId || state.enterprise.communityId === communityId)
        ? state.enterprise
        : undefined;
    if (
      !enterpriseAuth ||
      disposed ||
      enterpriseClearInFlight ||
      !pending ||
      pending.status === "opening" ||
      enterpriseAttempt
    )
      return;
    if (pending.errorKind === "discovery") {
      await retryEnterpriseGate(pending.communityId);
      return;
    }
    const attempt = {
      communityId: pending.communityId,
      attemptId: crypto.randomUUID(),
      owner,
    };
    enterpriseAttempt = attempt;
    nextEnterpriseCheck(attempt.communityId);
    update(
      {
        enterprise: {
          communityId: attempt.communityId,
          status: "opening",
        },
      },
      false,
    );
    try {
      await enterpriseAuth.start(attempt.attemptId);
      if (disposed || enterpriseAttempt?.attemptId !== attempt.attemptId)
        return;
      enterpriseAttempt = undefined;
      // Retire every check that started before this login completed. A check
      // started while the browser was open must not republish required after
      // the successful attempt clears the prompt.
      retireEnterprisePrompt(attempt.communityId);
      const session = sessions.get(attempt.communityId);
      if (session) {
        session.disconnect();
        session.retry();
      }
    } catch (reason) {
      if (disposed || enterpriseAttempt?.attemptId !== attempt.attemptId)
        return;
      enterpriseAttempt = undefined;
      publishEnterprise(
        attempt.communityId,
        nextEnterpriseCheck(attempt.communityId),
        "error",
        reason instanceof Error ? reason.message : String(reason),
        "login",
      );
    }
  }
  async function retryEnterpriseGate(communityId: string) {
    if (!enterpriseAuth || disposed || enterpriseClearInFlight) return;
    try {
      await requireEnterpriseLogin(communityId, controller.signal);
    } catch (reason) {
      if (
        !(reason instanceof EnterpriseLoginRequired) &&
        !(reason instanceof EnterpriseDiscoveryError) &&
        !(reason instanceof DOMException && reason.name === "AbortError")
      )
        throw reason;
      return;
    }
    const session = sessions.get(communityId);
    if (session) {
      session.disconnect();
      session.retry();
    }
  }
  function cancelEnterpriseLogin(communityId?: string, owner = "app") {
    const attempt = enterpriseAttempt;
    const target =
      communityId ?? attempt?.communityId ?? state.enterprise?.communityId;
    if (
      !target ||
      (attempt &&
        (attempt.communityId !== target ||
          (owner !== "app" && attempt.owner !== owner)))
    )
      return Promise.resolve();
    const version = nextEnterpriseCheck(target);
    let cancellation = Promise.resolve();
    if (attempt) {
      enterpriseAttempt = undefined;
      if (enterpriseAuth)
        cancellation = enterpriseAuth
          .cancel(attempt.attemptId)
          .catch((error) => {
            console.warn("Couldn't cancel enterprise login", error);
          });
      publishEnterprise(target, version, "required");
    } else if (state.enterprise?.communityId === target) {
      update({ enterprise: undefined }, false);
    }
    return cancellation;
  }
  function dismissEnterpriseLogin(communityId?: string, owner = "app") {
    const target = communityId ?? state.enterprise?.communityId;
    if (!target) return;
    cancelEnterpriseLogin(target, owner);
    if (
      (!enterpriseAttempt || enterpriseAttempt.owner === owner) &&
      state.enterprise?.communityId === target
    )
      update({ enterprise: undefined }, false);
  }
  async function clearEnterpriseAuth() {
    if (!enterpriseAuth || disposed) return;
    if (enterpriseClearInFlight) {
      await enterpriseClearInFlight;
      return;
    }
    const operation = (async () => {
      const attempt = enterpriseAttempt;
      if (attempt)
        await cancelEnterpriseLogin(attempt.communityId, attempt.owner);
      // Fence checks already in flight before waiting on native storage. New
      // connects wait on this operation through the wrapper above.
      for (const communityId of enterpriseCheckVersions.keys())
        retireEnterprisePrompt(communityId);
      await enterpriseAuth.clear();
      const retryCommunities = [...enterpriseCommunities];
      for (const communityId of retryCommunities) {
        retireEnterprisePrompt(communityId);
        sessions.get(communityId)?.disconnect();
      }
      if (state.enterprise) update({ enterprise: undefined }, false);
      return retryCommunities;
    })();
    enterpriseClearInFlight = operation;
    let retryCommunities: string[];
    try {
      retryCommunities = await operation;
    } finally {
      if (enterpriseClearInFlight === operation)
        enterpriseClearInFlight = undefined;
    }
    if (disposed) return;
    for (const communityId of retryCommunities)
      sessions.get(communityId)?.retry();
  }
  return {
    presence: presenceActivity,
    relay,
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    connect(id: string, signal: AbortSignal) {
      if (disposed) return Promise.reject(disposedError());
      if (!connect)
        return Promise.reject(new Error("Community connection is unavailable"));
      return connect(id, signal);
    },
    startEnterpriseLogin,
    cancelEnterpriseLogin,
    dismissEnterpriseLogin,
    retryEnterpriseGate,
    clearEnterpriseAuth,
    select(id: string | null) {
      if (id) id = communityDestination(id).id;
      if (id && !state.memberships.some((m) => m.id === id))
        throw new Error("Join this community first");
      const previous = state.selected;
      const previousNeedsRestart =
        previous !== null &&
        previous !== id &&
        (enterpriseChecksInFlight.has(previous) ||
          enterpriseAttempt?.communityId === previous ||
          state.enterprise?.communityId === previous);
      if (previous && previous !== id && previousNeedsRestart)
        retireEnterprisePrompt(previous);
      if (enterpriseAttempt && enterpriseAttempt.communityId !== id) {
        const attemptCommunity = enterpriseAttempt.communityId;
        cancelEnterpriseLogin(attemptCommunity);
        retireEnterprisePrompt(attemptCommunity);
      }
      const previousSession = previous ? sessions.get(previous) : undefined;
      if (
        previous &&
        previousNeedsRestart &&
        previousSession?.snapshot().status !== "ready"
      )
        previousSession?.disconnect();
      const existing = id ? sessions.get(id) : undefined;
      if (id) acquire(id);
      update({ selected: id });
      if (
        existing &&
        (existing.snapshot().status === "disconnected" ||
          existing.snapshot().status === "error")
      )
        existing.retry();
    },
    saveProfile(profile: PersonalProfile) {
      update({ profile });
    },
    joined(membership: Membership, profile: PersonalProfile) {
      membership = {
        ...membership,
        id: communityDestination(membership.id).id,
      };
      const previous = state.selected;
      const previousNeedsRestart =
        previous !== null &&
        previous !== membership.id &&
        (enterpriseChecksInFlight.has(previous) ||
          enterpriseAttempt?.communityId === previous ||
          state.enterprise?.communityId === previous);
      if (previous && previous !== membership.id && previousNeedsRestart) {
        retireEnterprisePrompt(previous);
      }
      const previousSession = previous ? sessions.get(previous) : undefined;
      if (
        previous &&
        previousNeedsRestart &&
        previousSession?.snapshot().status !== "ready"
      )
        previousSession?.disconnect();
      if (
        enterpriseAttempt &&
        enterpriseAttempt.communityId !== membership.id
      ) {
        const attemptCommunity = enterpriseAttempt.communityId;
        cancelEnterpriseLogin(attemptCommunity);
        retireEnterprisePrompt(attemptCommunity);
      }
      update(
        {
          memberships: [
            ...state.memberships.filter((m) => m.id !== membership.id),
            membership,
          ],
          profile: state.profile.name ? state.profile : profile,
          selected: membership.id,
        },
        true,
        !!nativeConnect && !live,
      );
      const session = sessions.get(membership.id);
      if (
        session &&
        (session.snapshot().status === "disconnected" ||
          session.snapshot().status === "error")
      )
        session.retry();
      else if (!session) acquire(membership.id);
      emitRelay();
    },
    /** Forgets a saved community on this device once its relay has released
     * the membership (or never held one). Drops the membership, falls back to
     * Personal space when it was selected, disposes its retained session, then
     * purges the device state keyed by that origin and viewer. Persistence
     * follows `joined`: required where the device record is the only copy, and
     * that save is the only step that throws, before anything has changed.
     * Everything after it is best effort: a session that would not dispose or
     * a store that would not clear is logged and returned, never thrown, since
     * the membership is already gone and only a report can reach the viewer.
     *
     * `purge: false` keeps the device state. It is for a relay that refused
     * the leave because the viewer is banned: the relay still holds the
     * membership (bans can be timed or lifted), so the drafts and reading
     * positions keyed by this origin and viewer are kept for the day the
     * community is added again by its URL. */
    async leave(
      id: string,
      { purge = true }: { purge?: boolean } = {},
    ): Promise<PurgeFailure[]> {
      id = communityDestination(id).id;
      if (!state.memberships.some((m) => m.id === id)) return [];
      const { viewer } = state;
      const origin = communityDestination(id).url;
      update(
        {
          memberships: state.memberships.filter((m) => m.id !== id),
          ...(state.selected === id ? { selected: null } : {}),
        },
        true,
        !!nativeConnect && !live,
      );
      const failures: PurgeFailure[] = [];
      const scope = sessionScopes.get(id);
      sessions.delete(id);
      sessionScopes.delete(id);
      if (scope) {
        // Every session scope comes from `newScope()`, so this always finds
        // it; guarding keeps a miss from splicing another community's scope.
        const index = scopes.indexOf(scope);
        if (index !== -1) scopes.splice(index, 1);
        try {
          await scope.fiber.dispose();
        } catch (error) {
          // Reported alongside the purge failures, since only a report can
          // reach the viewer now, but named for what it is: a session that
          // would not shut down, not a store that would not clear.
          console.warn(
            `Couldn't dispose the session for ${origin} after leaving it`,
            error,
          );
          failures.push({ store: "session", error });
        }
      }
      // The session is gone (or at least detached), so nothing below can
      // refill the purged stores.
      if (purge && viewer)
        failures.push(...(await purgeCommunityDeviceState(origin, viewer)));
      return failures;
    },
  };
}
export type Communities = ReturnType<typeof createCommunities>;
