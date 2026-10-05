import { Channel, invoke } from "@tauri-apps/api/core";
import {
  ENTERPRISE_ACCESS_DENIED,
  ENTERPRISE_BADGE_REFUSED,
  enterpriseLoginMark,
  noteEnterpriseDenial,
} from "./enterprise-sign-in";
import {
  BADGE_DENIED_CLOSE,
  BADGE_REFUSED_CLOSE,
  BADGE_ROTATION_CLOSE,
} from "./live";

/** Rotate this long before the badge expires; the relay ends the connection at
 * expiry and NIP-FI badges last at most five minutes. A badge with less left
 * than this is a failed connection, not a rotation. */
const ROTATE_BEFORE_MS = 30_000;

/** What the native relay socket (`relay_socket.rs`) reports. */
export type SocketEvent =
  | { type: "text"; data: string }
  | { type: "close"; code: number }
  | { type: "error" };
export type NativeConnection = {
  expiresAt: number;
  /** Begins frame delivery; nothing is read before this. */
  start(): Promise<unknown>;
  send(data: string): Promise<unknown>;
  close(): void;
};

/** Opens the native socket, which fetches and sends the relay badge itself.
 * Resolves `null` when the relay needs no badge. */
export const nativeConnect = async (
  url: string,
  receive: (event: SocketEvent) => void,
): Promise<NativeConnection | null> => {
  const onEvent = new Channel<SocketEvent>();
  onEvent.onmessage = receive;
  const open = await invoke<{ id: number; expiresAt: number } | null>(
    "relay_socket_connect",
    { url, onEvent },
  );
  if (!open) return null;
  const { id, expiresAt } = open;
  return {
    expiresAt,
    start: () => invoke("relay_socket_start", { id }),
    send: (data) => invoke("relay_socket_send", { id, data }),
    close() {
      onEvent.onmessage = () => {};
      void invoke("relay_socket_close", { id }).catch(() => {});
    },
  };
};

/** The 4900–4999 range carries this app's own meanings (`live.ts`), so a
 * relay's close in that range is an ordinary failure. */
const peerClose = (code: number) =>
  code >= 4900 && code <= 4999 ? 1006 : code;

/**
 * A relay socket for the native app. Relays requiring federated identity
 * connect through the native socket, which sends the
 * `Nostr-Federated-Identity` badge; every other relay keeps the webview socket.
 * Emulates the subset of `WebSocket` that `subscribeRelayTraffic` uses.
 */
export function nativeRelaySocket(
  url: string,
  dependencies = {
    connect: nativeConnect,
    browser: (url: string) => new WebSocket(url),
    now: Date.now,
  },
): WebSocket {
  let wire: { send(data: string): void; close(): void } | undefined;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const mark = enterpriseLoginMark();
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
  const end = (code: number, notify: boolean, error = false, reason = "") => {
    if (ended) return;
    ended = true;
    clearTimeout(rotation);
    socket.readyState = 3;
    wire?.close();
    if (error) socket.onerror?.(new Event("error"));
    if (notify)
      socket.onclose?.((reason ? { code, reason } : { code }) as CloseEvent);
  };
  const opened = () => {
    if (ended) return;
    socket.readyState = 1;
    socket.onopen?.(new Event("open"));
  };
  // Returns the handler's promise so callers that await delivery still can.
  const message = (data: string) =>
    ended ? undefined : socket.onmessage?.({ data } as MessageEvent);
  void (async () => {
    const native = await dependencies.connect(url, (event) => {
      if (event.type === "text") void message(event.data);
      else if (event.type === "close") end(peerClose(event.code), true);
      else end(1006, true, true);
    });
    if (ended) return native?.close();
    if (!native) {
      const browser = dependencies.browser(url);
      wire = browser;
      browser.onopen = opened;
      browser.onmessage = (event) => message(event.data);
      browser.onerror = () => end(1006, true, true);
      browser.onclose = (event) => end(peerClose(event?.code ?? 1006), true);
      return;
    }
    wire = {
      send: (data) => void native.send(data).catch(() => end(1006, true, true)),
      close: () => native.close(),
    };
    const due = native.expiresAt * 1000 - dependencies.now() - ROTATE_BEFORE_MS;
    if (due <= 0) throw new Error("Relay badge expires too soon");
    opened();
    rotation = setTimeout(() => end(BADGE_ROTATION_CLOSE, true), due);
    // Frames flow only now, so the relay's AUTH finds an open socket.
    if (!ended) await native.start();
  })().catch((error: unknown) => {
    // A retired socket's result belongs to a session that may be gone.
    if (ended) return;
    noteEnterpriseDenial(error, mark);
    const message = String(error instanceof Error ? error.message : error);
    if (message === ENTERPRISE_ACCESS_DENIED) end(BADGE_DENIED_CLOSE, true);
    else if (message.startsWith(ENTERPRISE_BADGE_REFUSED))
      end(BADGE_REFUSED_CLOSE, true, false, message);
    else end(1006, true, true);
  });
  return socket as unknown as WebSocket;
}
