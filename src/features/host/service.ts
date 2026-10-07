import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../../plugins/api";
import { nativeIdentityEnabled } from "../identity/service";

export type HostRequest = Readonly<{
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;
export type HostResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
/** Reusable NIP-OA proof for one agent key; preparing it does not submit it. */
export type NipOaAuthorization = readonly [
  "auth",
  ownerPubkey: string,
  conditions: string,
  signature: string,
];
export interface Host {
  runCommand(id: string): Promise<string | null>;
  request(input: HostRequest): Promise<HostResponse>;
  prepareRemoteAgentAuthorization?: (
    agentPubkey: string,
    signal?: AbortSignal,
  ) => Promise<NipOaAuthorization>;
  /** `request` shaped like the platform `fetch`, with the response body streamed as
   * it arrives, so a library that accepts a custom fetch can use a declared origin.
   * Same origin, header and size rules as `request`. Bodies are text in both
   * directions. `init.signal` cancels the native request. The calling plugin is
   * read from `ctx`, so hand it to a library as
   * `(input, init) => ctx.host.fetch(input, init)`, not detached. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
type FetchEvent =
  | { type: "chunk"; text: string }
  | { type: "end" }
  | { type: "error"; message: string };

declare module "@deepseek-ai/cordis" {
  interface Context {
    host: Host;
  }
}

export class HostService extends Service implements Host {
  constructor(context: Context) {
    super(context, "host");
  }

  async prepareRemoteAgentAuthorization(
    agentPubkey: string,
    signal?: AbortSignal,
  ): Promise<NipOaAuthorization> {
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{64}$/.test(agentPubkey))
      throw new Error("Agent pubkey must be 64 lowercase hex characters");
    const native = nativeIdentityEnabled();
    const owner = native
      ? await invoke<string | null>("identity_restore")
      : (
          await (
            await fetch("/api/relay/identity", { signal: signal ?? null })
          ).json()
        ).viewer;
    signal?.throwIfAborted();
    if (typeof owner !== "string" || !/^[0-9a-f]{64}$/.test(owner))
      throw new Error("Set up your identity first");
    if (owner === agentPubkey)
      throw new Error("Owner and agent pubkeys must differ");
    let tag: NipOaAuthorization;
    if (native) {
      try {
        tag = await invoke<NipOaAuthorization>(
          "identity_prepare_remote_agent_authorization",
          { owner, agentPubkey },
        );
      } catch (error) {
        throw typeof error === "string" ? new Error(error) : error;
      }
    } else {
      const response = await fetch(
        "/api/relay/prepare-remote-agent-authorization",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, agentPubkey }),
          signal: signal ?? null,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Owner authorization failed");
      tag = result;
    }
    signal?.throwIfAborted();
    if (
      !Array.isArray(tag) ||
      tag.length !== 4 ||
      tag[0] !== "auth" ||
      tag[1] !== owner ||
      tag[2] !== "" ||
      typeof tag[3] !== "string" ||
      !/^[0-9a-f]{128}$/.test(tag[3])
    )
      throw new Error("Invalid remote agent authorization");
    return tag;
  }

  async runCommand(id: string): Promise<string | null> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri()) return null;
    try {
      return await invoke<string | null>("plugin_host_run_command", {
        id: owner.id,
        revision: owner.revision,
        commandId: id,
      });
    } catch {
      return null;
    }
  }

  async request(input: HostRequest): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Host requests require an installed desktop plugin");
    return invoke<HostResponse>("plugin_host_request", {
      id: owner.id,
      revision: owner.revision,
      request: input,
    });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new TypeError("Host requests require an installed desktop plugin");
    const source = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? source?.signal;
    signal?.throwIfAborted();
    const method = (init?.method ?? source?.method ?? "GET").toUpperCase();
    const body =
      init?.body ??
      (source && method !== "GET" && method !== "HEAD"
        ? await source.text()
        : undefined);
    if (body != null && typeof body !== "string")
      throw new TypeError("Host requests send text bodies only");
    const streamId = crypto.randomUUID();
    const stop = () =>
      void invoke("plugin_host_fetch_cancel", { streamId }).catch(() => {});
    const encoder = new TextEncoder();
    // Assigned synchronously by the stream constructor.
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      output.error(signal?.reason);
      stop();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      cancel() {
        settled = true;
        signal?.removeEventListener("abort", abort);
        stop();
      },
    });
    const events = new Channel<FetchEvent>();
    events.onmessage = (event) => {
      if (settled) return;
      if (event.type === "chunk")
        return output.enqueue(encoder.encode(event.text));
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (event.type === "end") output.close();
      else output.error(new TypeError(event.message));
    };
    signal?.addEventListener("abort", abort, { once: true });
    let head: Pick<HostResponse, "status" | "headers">;
    try {
      head = await invoke("plugin_host_fetch", {
        id: owner.id,
        revision: owner.revision,
        streamId,
        request: {
          url: source?.url ?? String(input),
          method,
          headers: Object.fromEntries(
            new Headers(init?.headers ?? source?.headers),
          ),
          ...(body == null ? {} : { body }),
        },
        onEvent: events,
      });
    } catch (problem) {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) throw signal.reason;
      settled = true;
      throw new TypeError(
        typeof problem === "string" ? problem : "Host request failed",
      );
    }
    // These statuses cannot carry a body, and Response refuses one.
    if ([101, 204, 205, 304].includes(head.status)) {
      void stream.cancel();
      return new Response(null, head);
    }
    return new Response(stream, head);
  }
}
