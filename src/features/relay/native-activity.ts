import { invoke } from "@tauri-apps/api/core";
import type {
  ActivityHistoryHost,
  HistoryPage,
} from "../agents/activity-history";
import { nativeSocket } from "./native-socket";

// Retain failed native retirement, never silently replace a still-owned lease.
// Reconnection retries cleanup for this origin before acquiring another lease.
const retiring = new Map<string, () => Promise<void>>();
/** App-community lifetime only. Identity remains owned by the main native host. */
export async function nativeActivityLease(
  origin: string,
  viewer: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const pendingClose = retiring.get(origin);
  if (pendingClose) await pendingClose();
  signal.throwIfAborted();
  const account = await invoke<{
    lease: string;
    viewer: string;
    origin: string;
    relayAuthor: string;
  }>("account_activity_open", { community: origin, viewer });
  let retired = false;
  let confirmed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    retired = true;
    signal.removeEventListener("abort", onAbort);
    if (confirmed) return Promise.resolve();
    if (closing) return closing;
    retiring.set(origin, close);
    closing = invoke<void>("account_connection_close", { lease: account.lease })
      .then(() => {
        confirmed = true;
        if (retiring.get(origin) === close) retiring.delete(origin);
      })
      .catch(() => {
        throw new Error(
          "Previous Activity connection could not close. Retry this community before reconnecting.",
        );
      })
      .finally(() => {
        closing = undefined;
      });
    return closing;
  };
  const onAbort = () => {
    void close().catch(() => {
      /* Retained for the owner's next explicit connection attempt. */
    });
  };
  if (
    signal.aborted ||
    account.viewer !== viewer ||
    account.origin !== origin ||
    !/^[0-9a-f-]{36}$/.test(account.lease) ||
    !/^[0-9a-f]{64}$/.test(account.relayAuthor)
  ) {
    await close();
    throw new Error("Activity connection changed account or community");
  }
  signal.addEventListener("abort", onAbort, { once: true });
  const current = () => {
    signal.throwIfAborted();
    if (retired) throw new Error("Activity connection closed");
  };
  const history: ActivityHistoryHost = {
    async read(agent, channel, before, abort) {
      current();
      abort.throwIfAborted();
      const page = await invoke<HistoryPage>("account_history_read", {
        lease: account.lease,
        read: { agent, channel, before: before ?? null },
      });
      current();
      abort.throwIfAborted();
      return page;
    },
    async delete(abort) {
      current();
      abort.throwIfAborted();
      await invoke("account_history_delete", { lease: account.lease });
      current();
      abort.throwIfAborted();
    },
  };
  return {
    authority: account.relayAuthor,
    history,
    close,
    socket: () => {
      current();
      return nativeSocket(account.lease, undefined, signal);
    },
  };
}
