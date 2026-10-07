import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../../plugins/api";

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
/** A declared host command with newline-framed input/output. Desktop macOS/Linux. */
export type HostProcess = Readonly<{
  send(text: string): Promise<void>;
  close(): void;
}>;
export type ProcessOptions = Readonly<{
  signal: AbortSignal;
  onLine(text: string): void;
  onClose(error: Error): void;
}>;
export interface Host {
  connectCommand(id: string, options: ProcessOptions): Promise<HostProcess>;
  runCommand(id: string): Promise<string | null>;
  request(input: HostRequest): Promise<HostResponse>;
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

  async connectCommand(
    commandId: string,
    options: ProcessOptions,
  ): Promise<HostProcess> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Plugin processes require an installed desktop plugin");
    options.signal.throwIfAborted();
    const connectionId = crypto.randomUUID();
    const address = { id: owner.id, revision: owner.revision, connectionId };
    let closed = false;
    const stop = () =>
      void invoke("plugin_host_process_close", address).catch(() => {});
    const close = () => {
      if (closed) return;
      closed = true;
      void release();
      options.signal.removeEventListener("abort", close);
      stop();
      options.onClose(new Error("Plugin process closed"));
    };
    const release = this.ctx.effect(() => close);
    options.signal.addEventListener("abort", close, { once: true });
    const events = new Channel<
      { type: "line"; text: string } | { type: "exit"; error: string }
    >();
    events.onmessage = (event) => {
      if (closed) return;
      if (event.type === "line") options.onLine(event.text);
      else {
        closed = true;
        void release();
        options.signal.removeEventListener("abort", close);
        options.onClose(new Error(event.error));
      }
    };
    try {
      await invoke("plugin_host_process_open", {
        ...address,
        commandId,
        onEvent: events,
      });
      if (closed || options.signal.aborted) {
        stop();
        throw new Error("Plugin process closed during startup");
      }
    } catch (error) {
      close();
      throw error;
    }
    return {
      send: (text) =>
        closed
          ? Promise.reject(new Error("Plugin process closed"))
          : invoke("plugin_host_process_send", { ...address, text }),
      close,
    };
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
