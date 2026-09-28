import type {
  ActivityHistoryHost,
  HistoryPage,
} from "../agents/activity-history";
import type { EventTemplate } from "nostr-tools";
import {
  nativeSocket,
  nativeSocketHost,
  type NativeSocketHost,
} from "./native-socket";
import { subscribeRelayTraffic } from "./live";
import { invoke } from "@tauri-apps/api/core";
import { eventDto, type RelayEvent } from "./events";
import type { ReadTransport } from "./transport";
import { PublishRejected } from "./outbox";
import { ReadError } from "./errors";
import {
  admittedApiRequest,
  readApiFailure,
  ApiNotSent,
  ApiPaused,
} from "./http-admission";
import { createHostAdmission } from "./host-admission";
import { readReceiptText } from "./receipt";
import { yieldToHost } from "./yield";

export type NativeAccount = {
  viewer: string;
  origin: string;
  relayAuthor: string;
  archiveAuthority: string | null;
  lease: string;
};
type Operation =
  | { kind: "query"; value: unknown }
  | { kind: "sign"; value: EventTemplate }
  | { kind: "publish"; value: RelayEvent };
type Output =
  | { kind: "signed"; value: unknown }
  | { kind: "response"; value: { status: number; body: string } };
export type NativeRelayHost = {
  begin(lease: string): Promise<string>;
  run(lease: string, operation: string, request: Operation): Promise<Output>;
  cancel(lease: string, operation: string): Promise<void>;
  close(lease: string): Promise<void>;
  sockets?: NativeSocketHost;
  history?: {
    read(
      lease: string,
      agent: string,
      channel: string,
      before?: number,
    ): Promise<HistoryPage>;
    delete(lease: string): Promise<void>;
  };
};
export const nativeRelayHost: NativeRelayHost = {
  sockets: nativeSocketHost,
  history: {
    read: async (lease, agent, channel, before) => {
      try {
        return await invoke("account_history_read", {
          lease,
          read: { agent, channel, before: before ?? null },
        });
      } catch {
        throw new Error(
          "Saved Activity read unavailable. Check the connection and channel access, then retry.",
        );
      }
    },
    delete: async (lease) => {
      try {
        await invoke("account_history_delete", { lease });
      } catch {
        throw new Error(
          "Saved Activity deletion was not confirmed. Retry before assuming history was deleted.",
        );
      }
    },
  },
  begin: (lease) => invoke("account_relay_begin", { lease }),
  run: (lease, operation, request) =>
    invoke("account_relay_run", { lease, operation, request }),
  cancel: (lease, operation) =>
    invoke("account_relay_cancel", { lease, operation }),
  close: (lease) => invoke("account_connection_close", { lease }),
};
const admissions = createHostAdmission();
/** Current-session HTTP capability. Shared reader/outbox still owns policy/retries.
 * No direct browser networking, general signer, automatic credentials or live claims. */
export function nativeTransport(
  account: NativeAccount,
  host: NativeRelayHost = nativeRelayHost,
  lifetime?: AbortSignal,
): ReadTransport {
  const admission = admissions(account.origin, account.viewer).api;
  const abort = () =>
    new DOMException("Native connection cancelled", "AbortError");
  async function operation(
    request: Operation,
    signal?: AbortSignal,
    reserved?: string,
  ): Promise<Output> {
    const active = () => !lifetime?.aborted && !signal?.aborted;
    if (!active()) throw abort();
    let id: string | undefined;
    const cancel = () => {
      if (id) void host.cancel(account.lease, id).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    lifetime?.addEventListener("abort", cancel, { once: true });
    try {
      id = reserved ?? (await host.begin(account.lease));
      if (!active()) {
        cancel();
        throw abort();
      }
      const value = await host.run(account.lease, id, request);
      if (!active()) throw abort();
      return value;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "sent" in error &&
        error.sent === false
      )
        throw new ApiNotSent(
          "Native operation did not dispatch. Reconnect or retry explicitly.",
        );
      if (!active()) throw abort();
      throw error instanceof Error
        ? error
        : new Error(
            "Native relay operation unavailable; delivery may be unconfirmed.",
          );
    } finally {
      signal?.removeEventListener("abort", cancel);
      lifetime?.removeEventListener("abort", cancel);
    }
  }
  async function request(
    input: Operation,
    signal?: AbortSignal,
    priority: "foreground" | "background" = "foreground",
  ) {
    return admittedApiRequest(
      admission,
      async () => {
        const result = await operation(input, signal);
        if (
          result.kind !== "response" ||
          !Number.isInteger(result.value.status) ||
          result.value.status < 200 ||
          result.value.status > 599 ||
          typeof result.value.body !== "string"
        )
          throw new Error("Invalid native relay response");
        return new Response(
          result.value.status === 204 ? null : result.value.body,
          { status: result.value.status },
        );
      },
      signal,
      priority,
    );
  }
  async function publish(
    event: RelayEvent,
    signal: AbortSignal,
    reservation?: string,
  ) {
    let response: Response;
    try {
      await admission.prepare(async () => {}); // Recheck a cooldown learned after reservation, before IPC entry.
      const result = await operation(
        { kind: "publish", value: event },
        signal,
        reservation,
      );
      if (result.kind !== "response")
        throw new Error("Invalid native delivery response");
      response = new Response(
        result.value.status === 204 ? null : result.value.body,
        { status: result.value.status },
      );
    } catch (error) {
      if (error instanceof ApiNotSent || error instanceof ApiPaused)
        throw new PublishRejected(error.message);
      throw error;
    }
    if (!response.ok) {
      if ([400, 401, 403, 404, 413, 422].includes(response.status))
        throw new PublishRejected(
          `Relay rejected the message (${response.status})`,
        );
      const failure = await readApiFailure(response);
      if (failure.quota === "api") {
        if (failure.retryAfterMs !== undefined)
          admission.pause(failure.retryAfterMs);
        throw new PublishRejected(failure.error);
      }
      throw new Error("Relay delivery could not be confirmed");
    }
    const receipt = JSON.parse(await readReceiptText(response));
    if (receipt.event_id !== event.id || typeof receipt.accepted !== "boolean")
      throw new Error("Invalid native delivery receipt");
    if (!receipt.accepted)
      throw new PublishRejected("Relay rejected the message");
    return typeof receipt.message === "string" ? receipt.message : "";
  }
  const saved = host.history;
  const history: ActivityHistoryHost | undefined = saved
    ? {
        async read(agent, channel, before, signal) {
          signal.throwIfAborted();
          const page = await saved.read(account.lease, agent, channel, before);
          signal.throwIfAborted();
          if (lifetime?.aborted) throw abort();
          return page;
        },
        async delete(signal) {
          signal.throwIfAborted();
          await saved.delete(account.lease);
          signal.throwIfAborted();
        },
      }
    : undefined;
  return {
    ...(history ? { activityHistory: history } : {}),
    ...(host.sockets
      ? {
          agentActivity: true,
          subscribe(callbacks) {
            const principal = admissions(account.origin, account.viewer);
            principal.streams++;
            const traffic = subscribeRelayTraffic(
              account.origin.replace(/^https:/, "wss:"),
              async () => {
                throw new Error("Native live publication unsupported");
              },
              account.viewer,
              callbacks,
              () => nativeSocket(account.lease, host.sockets, lifetime),
              principal.live,
            );
            let disposed = false;
            // HTTP is the sole message publisher. No unsupported presence/event signer.
            return {
              update: traffic.update,
              prioritize: (channels: readonly string[]) =>
                traffic.prioritize?.(channels),
              observe: (generation: number | null) =>
                traffic.observe?.(generation),
              retry: traffic.retry,
              dispose() {
                if (disposed) return;
                disposed = true;
                principal.streams--;
                traffic.dispose();
              },
            };
          },
        }
      : {}),
    viewer: account.viewer,
    scope: account.origin,
    relayHttpUrl: account.origin,
    relayAuthor: account.relayAuthor,
    ...(account.archiveAuthority
      ? { archiveAuthority: account.archiveAuthority }
      : {}),
    media: () => undefined, // Signed media proxy is outside this transport slice.
    async query(filters, signal, _id, priority) {
      const response = await request(
        { kind: "query", value: filters },
        signal,
        priority,
      );
      if (!response.ok) {
        const failure = await readApiFailure(response);
        throw new ReadError(
          [401, 403].includes(response.status) ? "denied" : "unavailable",
          failure.error,
          response.status,
          failure.retryAfterMs,
        );
      }
      const raw: unknown = JSON.parse(await response.text());
      if (!Array.isArray(raw))
        throw new ReadError(
          "invalid-response",
          "Invalid native event response",
        );
      const events: RelayEvent[] = [];
      for (let i = 0; i < raw.length; i += 12) {
        if (signal?.aborted || lifetime?.aborted) throw abort();
        events.push(...raw.slice(i, i + 12).map(eventDto));
        if (i + 12 < raw.length) await yieldToHost();
      }
      return events;
    },
    writer: {
      kinds: [9],
      async sign(event, signal) {
        const result = await operation({ kind: "sign", value: event }, signal);
        if (result.kind !== "signed")
          throw new Error("Invalid native signature response");
        return eventDto(result.value);
      },
      async preparePublish(event, signal) {
        signal.throwIfAborted();
        if (lifetime?.aborted) throw abort();
        const reservation = await admission.run(
          () => host.begin(account.lease),
          signal,
        );
        const cancel = () => {
          void host.cancel(account.lease, reservation).catch(() => {});
        };
        if (signal.aborted || lifetime?.aborted) {
          cancel();
          throw abort();
        }
        signal.addEventListener("abort", cancel, { once: true });
        lifetime?.addEventListener("abort", cancel, { once: true });
        return {
          publish: () => publish(event, signal, reservation),
          dispose() {
            signal.removeEventListener("abort", cancel);
            lifetime?.removeEventListener("abort", cancel);
            cancel();
          },
        };
      },
      publish,
    },
  };
}
