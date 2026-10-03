import { invoke } from "@tauri-apps/api/core";
import TauriWebSocket from "@tauri-apps/plugin-websocket";
import { noteEnterpriseDenial } from "./enterprise-sign-in";
import { BADGE_ROTATION_CLOSE } from "./live";

/** Rotate this long before the badge expires; the relay ends the connection at
 * expiry and NIP-FI badges last at most five minutes. */
const ROTATE_BEFORE_MS = 30_000;

type SocketBadge = { header: string; expiresAt: number };
type Wire = { send(data: string): void; close(): void };

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
    plugin: TauriWebSocket.connect,
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
  const end = (code: number, notify: boolean, error = false) => {
    if (ended) return;
    ended = true;
    clearTimeout(rotation);
    socket.readyState = 3;
    wire?.close();
    if (error) socket.onerror?.(new Event("error"));
    if (notify) socket.onclose?.({ code } as CloseEvent);
  };
  const opened = (next: Wire) => {
    if (ended) return next.close();
    wire = next;
    socket.readyState = 1;
    socket.onopen?.(new Event("open"));
  };
  // Returns the handler's promise so callers that await delivery still can.
  const message = (data: string) =>
    ended ? undefined : socket.onmessage?.({ data } as MessageEvent);
  void (async () => {
    const badge = await dependencies.badge(url);
    if (ended) return;
    if (!badge) {
      const browser = dependencies.browser(url);
      browser.onopen = () => opened(browser);
      browser.onmessage = (event) => message(event.data);
      browser.onerror = () => end(1006, true, true);
      browser.onclose = (event) => end(event?.code ?? 1006, true);
      return;
    }
    const plugin = await dependencies.plugin(url, {
      headers: { "Nostr-Federated-Identity": badge.header },
    });
    plugin.addListener((event) => {
      if (event.type === "Text") message(event.data);
      else if (event.type === "Close") end(event.data?.code ?? 1005, true);
    });
    opened({
      send: (data) => void plugin.send(data).catch(() => end(1006, true, true)),
      close: () => void plugin.disconnect().catch(() => {}),
    });
    if (ended) return;
    rotation = setTimeout(
      () => end(BADGE_ROTATION_CLOSE, true),
      Math.max(
        0,
        badge.expiresAt * 1000 - dependencies.now() - ROTATE_BEFORE_MS,
      ),
    );
  })().catch((error: unknown) => {
    noteEnterpriseDenial(error);
    end(1006, true, true);
  });
  return socket as unknown as WebSocket;
}
