import { invoke } from "@tauri-apps/api/core";
import { relayOrigin } from "../communities/destination";
import type { RelayGate } from "../relay/service";
import type { FederatedIdentity, SessionSnapshot } from "./service";

export const LOCKED_SIGN_IN: "reauthentication" | "button" = "reauthentication";

function networkUnavailable(state: SessionSnapshot) {
  return (
    state.status === "unavailable" &&
    (state.failure === "network-unavailable" ||
      state.failure === "network-timeout")
  );
}
function admission(
  state: SessionSnapshot,
  viewer: string | undefined,
  origin: string,
) {
  return state.cacheAdmissions?.find(
    (entry) =>
      entry.viewer === viewer &&
      relayOrigin(entry.relay) === relayOrigin(origin),
  );
}
/** A session alone is not permission to read this key/community's cache. */
export function admits(
  state: SessionSnapshot,
  viewer: string | undefined,
  origin: string,
  now = Date.now(),
) {
  return (
    (state.status === "signed-in" || networkUnavailable(state)) &&
    !!state.expiresAt &&
    Date.parse(state.expiresAt) > now &&
    admission(state, viewer, origin)?.allowed === true
  );
}

export function relayGates(
  identity: FederatedIdentity,
): (origin: string) => RelayGate | undefined {
  if (!identity.apiAvailable) return () => undefined;
  return (origin) => {
    const session = identity.forCommunity?.(origin) ?? identity;
    // Keep this server's settled snapshot, including expiry, during rechecks.
    let settled = session.snapshot();
    const current = () => {
      const state = session.snapshot();
      if (state.status !== "restoring" || state.revision !== settled.revision)
        settled = state;
      return settled;
    };
    let protectedState: boolean | undefined;
    let checking: Promise<boolean | undefined> | undefined;
    const listeners = new Set<() => void>();
    const protects = () => {
      if (protectedState !== undefined) return Promise.resolve(protectedState);
      if (checking) return checking;
      checking = invoke<boolean>("federated_identity_protects", {
        relay: origin,
      })
        .then(
          (value) => {
            if (typeof value === "boolean") protectedState = value;
            for (const listener of listeners) listener();
            return protectedState;
          },
          () => undefined,
        )
        .finally(() => {
          checking = undefined;
        });
      return checking;
    };
    return {
      protects,
      admits: (viewer) =>
        protectedState === false ||
        (protectedState === true && admits(current(), viewer, origin)),
      canConnect: (viewer) => {
        if (protectedState === false) return true;
        const state = current();
        const proof = admission(state, viewer, origin);
        return (
          (proof?.allowed !== false || proof.retryable === true) &&
          (state.status === "signed-in" ||
            state.status === "restoring" ||
            networkUnavailable(state))
        );
      },
      subscribe(listener) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(timer);
          const state = current();
          if (!state.expiresAt) return;
          const left = Date.parse(state.expiresAt) - Date.now();
          if (left > 0)
            timer = setTimeout(
              () => {
                arm();
                listener();
              },
              Math.min(left, 2 ** 31 - 1),
            );
        };
        const changed = () => {
          arm();
          listener();
        };
        listeners.add(changed);
        arm();
        const unsubscribe = session.subscribe(() => {
          changed();
          if (protectedState === undefined) void protects();
        });
        return () => {
          clearTimeout(timer);
          unsubscribe();
          listeners.delete(changed);
        };
      },
    };
  };
}
