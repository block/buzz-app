import { invoke, isTauri } from "@tauri-apps/api/core";
import { nip19 } from "nostr-tools";
import {
  nativeTransport,
  nativeRelayHost,
  type NativeAccount,
} from "../relay/native-transport";
import type { ReadTransport } from "../relay/transport";
import { relayOrigin } from "./destination";

export type ExistingAccount = NativeAccount;
type Snapshot = {
  status: "idle" | "checking" | "connected" | "disconnecting" | "error";
  account?: ExistingAccount;
  error?: string;
};
export type AccountConnectionHost = {
  begin(request: {
    expectedPublicKey: string;
    relayUrl: string;
  }): Promise<string>;
  run(ticket: string): Promise<ExistingAccount>;
  cancel(ticket: string): Promise<void>;
  close(lease: string): Promise<void>;
};
/** Explicit current-session native custody, not a membership grant or startup preference. */
export function createAccountConnection(
  host: AccountConnectionHost,
  transport: (
    account: ExistingAccount,
    signal?: AbortSignal,
  ) => ReadTransport = (account, signal) =>
    nativeTransport(account, nativeRelayHost, signal),
) {
  let snapshot: Snapshot = { status: "idle" };
  let generation = 0,
    disposed = false;
  let ticket: string | undefined;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    // Closing a dialog cancels only its pending connect, never an active lease
    // or an in-flight explicit disconnect owned by this app service.
    if (snapshot.account) return;
    generation++;
    const current = ticket;
    ticket = undefined;
    if (current) void host.cancel(current).catch(() => {});
    if (!disposed && !snapshot.account) publish({ status: "idle" });
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async check(expectedPublicKey: string, relayUrl: string) {
      if (disposed || snapshot.status === "checking" || snapshot.account)
        return;
      const current = ++generation;
      try {
        let viewer = expectedPublicKey.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(viewer)) {
          // Reject secret-key inputs locally before crossing IPC; native checks again.
          if (!viewer.startsWith("npub1"))
            throw new Error(
              "Enter your public key (npub or hex), never a secret key.",
            );
          const decoded = nip19.decode(viewer);
          if (decoded.type !== "npub")
            throw new Error("Enter your public key.");
          viewer = decoded.data;
        }
        const origin = relayOrigin(relayUrl);
        publish({ status: "checking" });
        const begun = await host.begin({
          expectedPublicKey: viewer,
          relayUrl: origin,
        });
        if (disposed || generation !== current) {
          await host.cancel(begun);
          return;
        }
        ticket = begun;
        const result = await host.run(begun);
        if (disposed || generation !== current) {
          void host.close(result.lease).catch(() => {});
          return;
        }
        ticket = undefined;
        if (
          typeof result.lease !== "string" ||
          !/^[0-9a-f-]{36}$/.test(result.lease) ||
          result.viewer !== viewer ||
          result.origin !== origin ||
          !/^[0-9a-f]{64}$/.test(result.relayAuthor) ||
          (result.archiveAuthority !== null &&
            result.archiveAuthority !== result.relayAuthor)
        ) {
          void host.close(result.lease).catch(() => {});
          throw new Error(
            "Account check returned a different identity or relay.",
          );
        }
        publish({ status: "connected", account: result });
      } catch (error) {
        if (disposed || generation !== current) return;
        if (ticket) void host.cancel(ticket).catch(() => {});
        ticket = undefined;
        publish({
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Account check unavailable. Try again.",
        });
      }
    },
    cancel,
    transport(origin: string, signal?: AbortSignal) {
      const account = snapshot.account;
      if (
        !account ||
        snapshot.status !== "connected" ||
        origin !== account.origin ||
        disposed
      )
        throw new Error(
          "Connect this native account and community explicitly first",
        );
      return transport(account, signal);
    },
    async disconnect() {
      if (disposed || snapshot.status === "disconnecting") return;
      cancel();
      const account = snapshot.account;
      if (!account) return;
      const current = generation;
      publish({ status: "disconnecting", account });
      try {
        closing = host.close(account.lease);
        await closing;
        if (!disposed && generation === current) publish({ status: "idle" });
      } catch {
        if (!disposed && generation === current)
          publish({
            status: "error",
            account,
            error:
              "Disconnect was not confirmed. Retry disconnect before connecting another account.",
          });
      } finally {
        closing = undefined;
      }
    },
    dispose() {
      disposed = true;
      cancel();
      const account = snapshot.account;
      const released = account
        ? (closing ?? host.close(account.lease))
        : Promise.resolve();
      listeners.clear();
      snapshot = { status: "idle" };
      return released;
    },
  };
}
export type AccountConnection = ReturnType<typeof createAccountConnection>;

export function nativeAccountConnection(): AccountConnection | undefined {
  if (!isTauri()) return;
  return createAccountConnection({
    begin: (request) => invoke("account_connection_begin", { request }),
    run: (ticket) => invoke("account_connection_run", { ticket }),
    cancel: (ticket) => invoke("account_connection_cancel", { ticket }),
    close: (lease) => nativeRelayHost.close(lease),
  });
}
