import { Channel, invoke } from "@tauri-apps/api/core";
import {
  ENTERPRISE_ACCESS_DENIED,
  noteEnterpriseDenial,
} from "./enterprise-sign-in";
import { BADGE_DENIED_CLOSE, BADGE_ROTATION_CLOSE } from "./live";

/** Rotate this long before the badge expires; the relay ends the connection at
 * expiry and NIP-FI badges last at most five minutes. A badge with less left
 * than this is a failed connection, not a rotation. */
const ROTATE_BEFORE_MS = 30_000;

type SocketBadge = { header: string; expiresAt: number };
type Wire = { send(data: string): void; close(): void };
/** What the Tauri WebSocket plugin delivers: a tagged frame, or a bare string
 * when the read fails (the plugin sends nothing else after that). */
export type PluginFrame = { type: string; data?: unknown } | string;
export type PluginConnect = (
  url: string,
  headers: Record<string, string>,
  receive: (frame: PluginFrame) => void,
) => Promise<{ send(data: string): Promise<unknown>; close(): void }>;

/** Connects through the WebSocket plugin's commands directly so `receive` is
 * attached before the plugin can deliver the relay's first frame (`AUTH`). */
const pluginConnect: PluginConnect = async (url, headers, receive) => {
  const channel = new Channel<PluginFrame>();
  channel.onmessage = receive;
  const detach = () => {
    channel.onmessage = () => {};
  };
  const id = await invoke<number>("plugin:websocket|connect", {
    url,
    onMessage: channel,
    config: { headers: Object.entries(headers) },
  }).catch((error: unknown) => {
    detach();
    throw error;
  });
  const message = (message: { type: string; data: unknown }) =>
    invoke("plugin:websocket|send", { id, message });
  return {
    send: (data) => message({ type: "Text", data }),
    close() {
      detach();
      void message({
        type: "Close",
        data: { code: 1000, reason: "" },
      }).catch(() => {});
    },
  };
};

/**
 * A relay socket for the native app. The webview WebSocket cannot set headers,
 * so trusted enterprise relays connect through the Tauri WebSocket plugin with
 * the `Nostr-Federated-Identity` badge; every other relay keeps the webview
 * socket. Emulates the subset of `WebSocket` that `subscribeRelayTraffic` uses.
 */
export function nativeRelaySocket(
  url: string,
  dependencies = {
    badge: (url: string) =>
      invoke<SocketBadge | null>("relay_socket_badge", { url }),
    plugin: pluginConnect,
    browser: (url: string) => new WebSocket(url),
    now: Date.now,
  },
): WebSocket {
  let wire: Wire | undefined;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const socket = {
    readyState: 0 as number,
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
    send(data: string) {
      if (socket.readyState !== 1 || !wire)
        throw new DOMException("Relay socket is not open", "InvalidStateError");
      wire.send(data);
    },
    close() {
      end(1000, false);
    },
  };
  // The one terminal path: releases the wire and notifies at most once.
  const end = (code: number, notify: boolean, error = false) => {
    if (ended) return;
    ended = true;
    clearTimeout(rotation);
    socket.readyState = 3;
    wire?.close();
    if (error) socket.onerror?.(new Event("error"));
    if (notify) socket.onclose?.({ code } as CloseEvent);
  };
  const opened = () => {
    if (ended) return;
    socket.readyState = 1;
    socket.onopen?.(new Event("open"));
  };
  // Returns the handler's promise so callers that await delivery still can.
  const message = (data: string) =>
    ended ? undefined : socket.onmessage?.({ data } as MessageEvent);
  const remaining = (badge: SocketBadge) =>
    badge.expiresAt * 1000 - dependencies.now() - ROTATE_BEFORE_MS;
  void (async () => {
    const badge = await dependencies.badge(url);
    if (ended) return;
    if (!badge) {
      const browser = dependencies.browser(url);
      wire = browser;
      browser.onopen = opened;
      browser.onmessage = (event) => message(event.data);
      browser.onerror = () => end(1006, true, true);
      browser.onclose = (event) => end(event?.code ?? 1006, true);
      return;
    }
    if (remaining(badge) <= 0) throw new Error("Relay badge expires too soon");
    const plugin = await dependencies.plugin(
      url,
      { "Nostr-Federated-Identity": badge.header },
      (frame) => {
        // A bare string is the plugin's read failure: the connection is over.
        if (typeof frame === "string") end(1006, true, true);
        else if (frame.type === "Text") void message(frame.data as string);
        else if (frame.type === "Close")
          end((frame.data as { code?: number } | null)?.code ?? 1005, true);
        // Ping, Pong and Binary frames carry nothing for the relay protocol.
      },
    );
    wire = {
      send: (data) => void plugin.send(data).catch(() => end(1006, true, true)),
      close: () => plugin.close(),
    };
    if (ended) return plugin.close();
    const due = remaining(badge);
    if (due <= 0) throw new Error("Relay badge expired while connecting");
    opened();
    rotation = setTimeout(() => end(BADGE_ROTATION_CLOSE, true), due);
  })().catch((error: unknown) => {
    noteEnterpriseDenial(error);
    const denied =
      (error instanceof Error ? error.message : error) ===
      ENTERPRISE_ACCESS_DENIED;
    end(denied ? BADGE_DENIED_CLOSE : 1006, true, !denied);
  });
  return socket as unknown as WebSocket;
}
