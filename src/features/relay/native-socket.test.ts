import { afterEach, expect, it, vi } from "vitest";
import { BADGE_ROTATION_CLOSE } from "./live";
import { nativeRelaySocket } from "./native-socket";
import {
  ENTERPRISE_SIGN_IN_REQUIRED,
  onEnterpriseSignInRequired,
} from "./enterprise-sign-in";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-websocket", () => ({
  default: { connect: vi.fn() },
}));

afterEach(() => vi.useRealTimers());

type Listener = (message: { type: string; data: unknown }) => void;

function plugin() {
  let listener: Listener | undefined;
  const socket = {
    addListener: vi.fn((next: Listener) => {
      listener = next;
      return () => {};
    }),
    send: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  return {
    socket,
    connect: vi.fn(async () => socket),
    emit: (type: string, data: unknown) => listener?.({ type, data }),
  };
}

function open(
  badge: () => Promise<{ header: string; expiresAt: number } | null>,
  wire = plugin(),
  browser = vi.fn(),
) {
  const socket = nativeRelaySocket("wss://relay.example", {
    badge,
    plugin: wire.connect as never,
    browser,
    now: () => 1_000_000,
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

it("sends the relay badge on the plugin socket handshake and relays traffic", async () => {
  const h = open(async () => ({ header: "Bearer badge", expiresAt: 1_300 }));
  await vi.waitFor(() => expect(h.events.open).toHaveBeenCalled());
  expect(h.wire.connect).toHaveBeenCalledWith("wss://relay.example", {
    headers: { "Nostr-Federated-Identity": "Bearer badge" },
  });
  expect(h.socket.readyState).toBe(1);
  h.socket.send('["REQ"]');
  expect(h.wire.socket.send).toHaveBeenCalledWith('["REQ"]');
  h.wire.emit("Text", '["EOSE","x"]');
  expect(h.events.message).toHaveBeenCalledWith({ data: '["EOSE","x"]' });
  h.wire.emit("Close", { code: 1000, reason: "" });
  expect(h.events.close).toHaveBeenCalledWith({ code: 1000 });
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

it("rotates thirty seconds before the badge expires", async () => {
  vi.useFakeTimers();
  // Expires 300 s after `now`; rotation is due at 270 s.
  const h = open(async () => ({ header: "Bearer badge", expiresAt: 1_300 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.events.open).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(269_999);
  expect(h.events.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.events.close).toHaveBeenCalledWith({ code: BADGE_ROTATION_CLOSE });
  expect(h.wire.socket.disconnect).toHaveBeenCalled();
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

it("does not report transient badge failures as a denial", async () => {
  const denied = vi.fn();
  const stop = onEnterpriseSignInRequired(denied);
  const h = open(() =>
    Promise.reject("Relay badge was refused (401 invalid_proof)"),
  );
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(denied).not.toHaveBeenCalled();
  stop();
});
