import { assert, afterEach, expect, it, vi } from "vitest";
import {
  BADGE_DENIED_CLOSE,
  BADGE_ROTATION_CLOSE,
  subscribeRelayTraffic,
  type LiveCallbacks,
} from "./live";
import { nativeRelaySocket, type SocketEvent } from "./native-socket";
import {
  ENTERPRISE_ACCESS_DENIED,
  ENTERPRISE_SIGN_IN_REQUIRED,
  onEnterpriseSignInRequired,
} from "./enterprise-sign-in";
import { keypair, signed } from "./testing";

/** A stand-in for the native commands in `relay_socket.rs`, so the real
 * `Channel`/`invoke` bridge runs. Like the native owner, it delivers frames
 * only after `relay_socket_start`. */
const native = vi.hoisted(() => {
  type Receiver = { onmessage: (event: unknown) => void };
  const state = {
    commands: [] as [string, Record<string, unknown>][],
    channel: undefined as Receiver | undefined,
    connect: (): Promise<unknown> =>
      Promise.resolve({ id: 7, expiresAt: Date.now() / 1000 + 300 }),
    onStart: () => {},
    onSend: (_data: string) => {},
    emit: (event: unknown) => state.channel?.onmessage(event),
  };
  return state;
});
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    native.commands.push([command, args]);
    if (command === "relay_socket_connect") {
      native.channel = args.onEvent as typeof native.channel;
      return native.connect();
    }
    if (command === "relay_socket_start") native.onStart();
    if (command === "relay_socket_send") native.onSend(args.data as string);
  },
}));

afterEach(() => {
  vi.useRealTimers();
  native.commands = [];
  native.connect = () =>
    Promise.resolve({ id: 7, expiresAt: Date.now() / 1000 + 300 });
  native.onStart = () => {};
  native.onSend = () => {};
});

const commands = (name: string) =>
  native.commands.filter(([command]) => command === name);

function open(socket = nativeRelaySocket("wss://relay.example")) {
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
  return { socket, events };
}

it("authenticates when the relay's AUTH is ready before connect resolves", async () => {
  // The relay sends AUTH at once; the native owner holds it until start.
  let resolve = (_: unknown) => {};
  native.connect = () => new Promise((done) => (resolve = done));
  native.onStart = () =>
    native.emit({ type: "text", data: '["AUTH","challenge"]' });
  native.onSend = (data) => {
    const [type, event] = JSON.parse(data) as [string, { id: string }];
    if (type === "AUTH")
      queueMicrotask(() =>
        native.emit({
          type: "text",
          data: JSON.stringify(["OK", event.id, true]),
        }),
      );
  };
  const key = keypair();
  const state = vi.fn<LiveCallbacks["state"]>();
  const owner = subscribeRelayTraffic(
    "wss://relay.example",
    async (event) => signed(key, event),
    key.pubkey,
    {
      presence: vi.fn(),
      receive: vi.fn(),
      state,
      established: vi.fn(),
      denied: vi.fn(),
    },
    nativeRelaySocket,
  );
  await vi.waitFor(() =>
    expect(commands("relay_socket_connect")).toHaveLength(1),
  );
  resolve({ id: 7, expiresAt: Date.now() / 1000 + 300 });
  await vi.waitFor(() =>
    expect(state.mock.lastCall?.[0]).toMatchObject({ status: "connected" }),
  );
  const sent = commands("relay_socket_send").map(([, args]) =>
    JSON.parse(args.data as string),
  );
  expect(sent[0]?.[0]).toBe("AUTH");
  expect(sent[0]?.[1]).toMatchObject({ pubkey: key.pubkey, kind: 22242 });
  owner.dispose();
});

it("relays traffic and starts frame delivery only once open", async () => {
  native.onStart = () => native.emit({ type: "text", data: '["EOSE","x"]' });
  const h = open();
  await vi.waitFor(() => expect(h.events.message).toHaveBeenCalled());
  const order = native.commands.map(([command]) => command);
  expect(order).toEqual(["relay_socket_connect", "relay_socket_start"]);
  expect(h.events.open).toHaveBeenCalledBefore(h.events.message);
  expect(h.events.message).toHaveBeenCalledWith({ data: '["EOSE","x"]' });
  h.socket.send('["REQ"]');
  expect(commands("relay_socket_send")).toEqual([
    ["relay_socket_send", { id: 7, data: '["REQ"]' }],
  ]);
  native.emit({ type: "close", code: 1000 });
  expect(h.events.close).toHaveBeenCalledWith({ code: 1000 });
  expect(h.socket.readyState).toBe(3);
  expect(commands("relay_socket_close")).toHaveLength(1);
});

it("ends an abruptly broken connection exactly once and releases it", async () => {
  const h = open();
  await vi.waitFor(() =>
    expect(commands("relay_socket_start")).toHaveLength(1),
  );
  native.emit({ type: "error" } satisfies SocketEvent);
  native.emit({ type: "close", code: 1000 } satisfies SocketEvent);
  expect(h.events.error).toHaveBeenCalledOnce();
  expect(h.events.close).toHaveBeenCalledOnce();
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  expect(commands("relay_socket_close")).toEqual([
    ["relay_socket_close", { id: 7 }],
  ]);
});

it("treats a relay's close in the app's reserved range as a plain failure", async () => {
  const h = open();
  await vi.waitFor(() =>
    expect(commands("relay_socket_start")).toHaveLength(1),
  );
  native.emit({ type: "close", code: BADGE_DENIED_CLOSE });
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
});

it("keeps the webview socket for relays that need no badge, and maps its reserved closes", async () => {
  native.connect = async () => null;
  const browser = { close: vi.fn() } as {
    close: () => void;
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
  };
  const h = open(
    nativeRelaySocket("wss://relay.example", {
      connect: (await import("./native-socket")).nativeConnect,
      browser: vi.fn(() => browser) as never,
      now: Date.now,
    }),
  );
  await vi.waitFor(() => expect(browser.onopen).toBeDefined());
  browser.onopen?.();
  expect(h.events.open).toHaveBeenCalled();
  browser.onclose?.({ code: BADGE_ROTATION_CLOSE });
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
});

it("closing before the webview socket opens cancels its pending connect", async () => {
  native.connect = async () => null;
  const browser = { close: vi.fn() };
  const factory = vi.fn(() => browser);
  const h = open(
    nativeRelaySocket("wss://relay.example", {
      connect: (await import("./native-socket")).nativeConnect,
      browser: factory as never,
      now: Date.now,
    }),
  );
  await vi.waitFor(() => expect(factory).toHaveBeenCalled());
  h.socket.close();
  expect(browser.close).toHaveBeenCalledOnce();
});

it("rotates thirty seconds before the badge expires", async () => {
  vi.useFakeTimers();
  native.connect = async () => ({ id: 7, expiresAt: Date.now() / 1000 + 300 });
  const h = open();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.events.open).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(269_999);
  expect(h.events.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.events.close).toHaveBeenCalledWith({ code: BADGE_ROTATION_CLOSE });
  expect(commands("relay_socket_close")).toHaveLength(1);
});

// The check runs once connected, so it also covers a badge that arrived with
// enough time but ran down during the handshake.
it("fails, not rotates, when 30 s or less of the badge remain once connected", async () => {
  native.connect = async () => ({ id: 7, expiresAt: Date.now() / 1000 + 30 });
  const h = open();
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  expect(h.events.error).toHaveBeenCalled();
  expect(h.events.open).not.toHaveBeenCalled();
  expect(commands("relay_socket_start")).toHaveLength(0);
  expect(commands("relay_socket_close")).toHaveLength(1);
});

it("reports a session denial and closes as a failure", async () => {
  const denied = vi.fn();
  const stop = onEnterpriseSignInRequired(denied);
  native.connect = () => Promise.reject(ENTERPRISE_SIGN_IN_REQUIRED);
  const h = open();
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(denied).toHaveBeenCalledOnce();
  expect(h.events.error).toHaveBeenCalled();
  expect(h.events.close).toHaveBeenCalledWith({ code: 1006 });
  stop();
});

it("closes as access denied without signing out when the relay is refused", async () => {
  const denied = vi.fn();
  const stop = onEnterpriseSignInRequired(denied);
  native.connect = () => Promise.reject(ENTERPRISE_ACCESS_DENIED);
  const h = open();
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  expect(h.events.close).toHaveBeenCalledWith({ code: BADGE_DENIED_CLOSE });
  expect(denied).not.toHaveBeenCalled();
  stop();
});

it("does not report transient badge failures as a denial", async () => {
  const denied = vi.fn();
  const stop = onEnterpriseSignInRequired(denied);
  native.connect = () =>
    Promise.reject("Relay badge was refused (401 invalid_proof)");
  const h = open();
  await vi.waitFor(() => expect(h.events.close).toHaveBeenCalled());
  assert.deepEqual(h.events.close.mock.lastCall, [{ code: 1006 }]);
  expect(denied).not.toHaveBeenCalled();
  stop();
});
