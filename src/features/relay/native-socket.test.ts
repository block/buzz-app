import { afterEach, expect, it, vi } from "vitest";
import { BADGE_DENIED_CLOSE, BADGE_ROTATION_CLOSE } from "./live";
import { nativeRelaySocket, type PluginFrame } from "./native-socket";
import {
  ENTERPRISE_ACCESS_DENIED,
  ENTERPRISE_SIGN_IN_REQUIRED,
  onEnterpriseSignInRequired,
} from "./enterprise-sign-in";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));

afterEach(() => vi.useRealTimers());

/** A plugin whose connect resolves only when `resolve()` runs, so frames can
 * arrive while the connection promise is still pending, as in the plugin. */
function plugin({ pending = false } = {}) {
  let receive: ((frame: PluginFrame) => void) | undefined;
  let resolve = () => {};
  const socket = { send: vi.fn(async () => {}), close: vi.fn() };
  const connect = vi.fn(
    (
      _url: string,
      _headers: Record<string, string>,
      next: (frame: PluginFrame) => void,
    ) => {
      receive = next;
      return pending
        ? new Promise<typeof socket>((done) => {
            resolve = () => done(socket);
          })
        : Promise.resolve(socket);
    },
  );
  return {
    socket,
    connect,
    resolve: () => resolve(),
    emit: (frame: PluginFrame) => receive?.(frame),
  };
}

function open(
  badge: () => Promise<{ header: string; expiresAt: number } | null>,
  wire = plugin(),
  browser = vi.fn(),
  now = () => 1_000_000,
) {
  const socket = nativeRelaySocket("wss://relay.example", {
    badge,
    plugin: wire.connect,
    browser,
    now,
  });
  const events = {
    open: vi.fn(),
    message: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
  };
  socket.onopen = events.open;
  socket.onmessage = events.message;
  socket.onclose = events.close;
  socket.onerror = events.error;
  return { socket, wire, browser, events };
}

const badge = async () => ({ header: "Bearer badge", expiresAt: 1_300 });

it("sends the relay badge on the plugin socket handshake and relays traffic", async () => {
  const h = open(badge);
  await vi.waitFor(() => expect(h.events.open).toHaveBeenCalled());
  expect(h.wire.connect).toHaveBeenCalledWith(
    "wss://relay.example",
    { "Nostr-Federated-Identity": "Bearer badge" },
    expect.any(Function),
  );
  expect(h.socket.readyState).toBe(1);
  h.socket.send('["REQ"]');
  expect(h.wire.socket.send).toHaveBeenCalledWith('["REQ"]');
  h.wire.emit({ type: "Text", data: '["EOSE","x"]' });
  expect(h.events.message).toHaveBeenCalledWith({ data: '["EOSE","x"]' });
  h.wire.emit({ type: "Ping", data: [] });
  expect(h.events.close).not.toHaveBeenCalled();
  h.wire.emit({ type: "Close", data: { code: 1000, reason: "" } });
  expect(h.events.close).toHaveBeenCalledWith({ code: 1000 });
  expect(h.socket.readyState).toBe(3);
  expect(h.wire.socket.close).toHaveBeenCalledOnce();
});

it("delivers the relay's AUTH challenge sent before the plugin connect resolves", async () => {
  const h = open(badge, plugin({ pending: true }));
  await vi.waitFor(() => expect(h.wire.connect).toHaveBeenCalled());
  h.wire.emit({ type: "Text", data: '["AUTH","challenge"]' });
  expect(h.events.message).toHaveBeenCalledWith({
    data: '["AUTH","challenge"]',
  });
  h.wire.resolve();
  await vi.waitFor(() => expect(h.events.open).toHaveBeenCalled());
});

it("ends an abruptly broken plugin connection exactly once and releases it", async () => {
  const h = open(badge);
  await vi.waitFor(() => expect(h.events.open).toHaveBeenCalled());
  h.wire.emit(
    "WebSocket protocol error: Connection reset without closing handshake",
  );
  h.wire.emit("connection not found");
  expect(h.events.error).toHaveBeenCalledOnce();
  expect(h.events.close).toHaveBeenCalledOnce();
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  expect(h.wire.socket.close).toHaveBeenCalledOnce();
  expect(h.socket.readyState).toBe(3);
});

it("keeps the webview socket for relays that need no badge", async () => {
  const browser = { onopen: null as null | (() => void) } as {
    onopen: null | (() => void);
  };
  const h = open(
    async () => null,
    plugin(),
    vi.fn(() => browser),
  );
  await vi.waitFor(() => expect(h.browser).toHaveBeenCalled());
  expect(h.wire.connect).not.toHaveBeenCalled();
  browser.onopen?.();
  expect(h.events.open).toHaveBeenCalled();
});

it("closing before the webview socket opens cancels its pending connect", async () => {
  const browser = { close: vi.fn() };
  const h = open(
    async () => null,
    plugin(),
    vi.fn(() => browser),
  );
  await vi.waitFor(() => expect(h.browser).toHaveBeenCalled());
  h.socket.close();
  expect(browser.close).toHaveBeenCalledOnce();
});

it("rotates thirty seconds before the badge expires", async () => {
  vi.useFakeTimers();
  // Expires 300 s after `now`; rotation is due at 270 s.
  const h = open(badge);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.events.open).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(269_999);
  expect(h.events.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.events.close).toHaveBeenCalledWith({ code: BADGE_ROTATION_CLOSE });
  expect(h.wire.socket.close).toHaveBeenCalled();
});

it("fails, not rotates, on a badge with less than the rotation margin left", async () => {
  const h = open(async () => ({ header: "Bearer badge", expiresAt: 1_030 }));
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  expect(h.events.error).toHaveBeenCalled();
  expect(h.wire.connect).not.toHaveBeenCalled();
});

it("fails, not rotates, when the badge runs out while connecting", async () => {
  let now = 1_000_000;
  const h = open(badge, plugin({ pending: true }), vi.fn(), () => now);
  await vi.waitFor(() => expect(h.wire.connect).toHaveBeenCalled());
  now = 1_271_000;
  h.wire.resolve();
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  expect(h.events.open).not.toHaveBeenCalled();
  expect(h.wire.socket.close).toHaveBeenCalledOnce();
});

it("reports a session denial and closes as a failure", async () => {
  const denied = vi.fn();
  const stop = onEnterpriseSignInRequired(denied);
  const h = open(() => Promise.reject(ENTERPRISE_SIGN_IN_REQUIRED));
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(denied).toHaveBeenCalledOnce();
  expect(h.events.error).toHaveBeenCalled();
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  stop();
});

it("closes as access denied without signing out when the relay is refused", async () => {
  const denied = vi.fn();
  const stop = onEnterpriseSignInRequired(denied);
  const h = open(() => Promise.reject(ENTERPRISE_ACCESS_DENIED));
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(h.events.close).toHaveBeenCalledWith({ code: BADGE_DENIED_CLOSE });
  expect(denied).not.toHaveBeenCalled();
  stop();
});

it("does not report transient badge failures as a denial", async () => {
  const denied = vi.fn();
  const stop = onEnterpriseSignInRequired(denied);
  const h = open(() =>
    Promise.reject("Relay badge was refused (401 invalid_proof)"),
  );
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  expect(denied).not.toHaveBeenCalled();
  stop();
});
