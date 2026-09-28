import { afterEach, expect, it, vi } from "vitest";
import { nativeSocket, type NativeSocketHost } from "./native-socket";
import { subscribeRelayTraffic } from "./live";
import { createRelaySession } from "./session";
import { nativeTransport, type NativeRelayHost } from "./native-transport";
import { keypair, signed } from "./testing";
afterEach(() => vi.useRealTimers());
function fixture() {
  const viewer = keypair();
  let serial = 0;
  const callbacks = new Map<string, Parameters<NativeSocketHost["open"]>[1]>();
  const frames: { socket: string; frame: unknown[] }[] = [];
  const host: NativeSocketHost = {
    open: vi.fn(async (_lease, receive) => {
      const id = `socket-${++serial}`;
      callbacks.set(id, receive);
      return id;
    }),
    send: vi.fn(async (_lease, socket, frame) => {
      frames.push({ socket, frame: JSON.parse(frame) });
    }),
    authenticate: vi.fn(async () =>
      signed(viewer, {
        kind: 22242,
        content: "",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      }),
    ),
    ack: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  let seq = 0;
  const emit = (
    socket: string,
    kind: "open" | "message" | "observer" | "closed",
    value: unknown,
  ) => callbacks.get(socket)?.({ socket, kind, value, seq: ++seq });
  return { viewer, host, frames, emit, callbacks };
}
it("shared live owner authenticates and gates native observer by current wire without chat reconciliation", async () => {
  const f = fixture();
  const observer = vi.fn(),
    receive = vi.fn();
  const native = nativeSocket("lease", f.host);
  const traffic = subscribeRelayTraffic(
    "wss://relay.example",
    async () => {
      throw new Error("no general native signer");
    },
    f.viewer.pubkey,
    {
      observer,
      receive,
      state: () => {},
      established: () => {},
      denied: () => {},
    },
    () => native,
  );
  try {
    traffic.observe?.(1);
    await vi.waitFor(() => expect(f.host.open).toHaveBeenCalledOnce());
    f.emit("socket-1", "open", null);
    f.emit("socket-1", "message", ["AUTH", "observed"]);
    await vi.waitFor(() =>
      expect(f.frames.some(({ frame }) => frame[0] === "AUTH")).toBe(true),
    );
    const auth = f.frames.find(({ frame }) => frame[0] === "AUTH")
      ?.frame[1] as { id: string };
    f.emit("socket-1", "message", ["OK", auth.id, true, ""]);
    await vi.waitFor(() =>
      expect(
        f.frames.some(
          ({ frame }) =>
            frame[0] === "REQ" &&
            (frame[2] as { kinds: number[] }).kinds[0] === 24200,
        ),
      ).toBe(true),
    );
    const wire = f.frames.find(
      ({ frame }) =>
        frame[0] === "REQ" &&
        (frame[2] as { kinds: number[] }).kinds[0] === 24200,
    )?.frame[1];
    const packet = {
      id: "a".repeat(64),
      agent: "b".repeat(64),
      createdAt: Math.floor(Date.now() / 1000),
      plaintext: '{"kind":"turn_started"}',
    };
    f.emit("socket-1", "observer", { wire, frame: packet });
    await vi.waitFor(() =>
      expect(observer).toHaveBeenCalledExactlyOnceWith(packet, 1),
    );
    expect(receive).not.toHaveBeenCalled();
    traffic.observe?.(null);
    f.emit("socket-1", "observer", { wire, frame: packet });
    await vi.waitFor(() => expect(f.host.ack).toHaveBeenCalledTimes(4));
    expect(observer).toHaveBeenCalledTimes(1);
    traffic.dispose();
    f.emit("socket-1", "observer", { wire, frame: packet });
    expect(observer).toHaveBeenCalledTimes(1);
  } finally {
    traffic.dispose();
  }
});
it("acks only after async handling, fences close during open, and closes without waiting for data backlog", async () => {
  const f = fixture();
  const pending = deferred<void>();
  const socket = nativeSocket("lease", f.host);
  socket.onmessage = () => pending.promise;
  const closed = vi.fn();
  socket.onclose = closed;
  await vi.waitFor(() => expect(f.host.open).toHaveBeenCalledOnce());
  f.emit("socket-1", "message", ["AUTH", "x"]);
  await Promise.resolve();
  expect(f.host.ack).not.toHaveBeenCalled();
  f.emit("socket-1", "closed", null);
  expect(closed).toHaveBeenCalledOnce();
  pending.resolve(undefined);
  await Promise.resolve();
  const waiting = deferred<string>();
  vi.mocked(f.host.open).mockReturnValueOnce(waiting.promise);
  const next = nativeSocket("lease", f.host);
  next.close();
  waiting.resolve("late");
  await vi.waitFor(() =>
    expect(f.host.close).toHaveBeenCalledWith("lease", "late"),
  );
});
it("native transport owns one shared observer route and capture reset fences old decoded traffic", async () => {
  const f = fixture();
  const relay = keypair();
  const h: NativeRelayHost = {
    sockets: f.host,
    begin: async () => "op",
    run: async () => ({ kind: "response", value: { status: 200, body: "[]" } }),
    cancel: async () => {},
    close: async () => {},
  };
  const transport = nativeTransport(
    {
      viewer: f.viewer.pubkey,
      origin: "https://relay.example",
      relayAuthor: relay.pubkey,
      archiveAuthority: null,
      lease: "lease",
    },
    h,
  );
  const owner = createRelaySession(transport, {
    outboxStorage: { load: () => [], save: () => {} },
  });
  const release = owner.session.agentActivity.activate();
  try {
    await vi.waitFor(() => expect(f.host.open).toHaveBeenCalledOnce());
    f.emit("socket-1", "open", null);
    f.emit("socket-1", "message", ["AUTH", "x"]);
    await vi.waitFor(() =>
      expect(f.frames.some(({ frame }) => frame[0] === "AUTH")).toBe(true),
    );
    const auth = f.frames.find(({ frame }) => frame[0] === "AUTH")
      ?.frame[1] as { id: string };
    f.emit("socket-1", "message", ["OK", auth.id, true]);
    const observerWire = () =>
      f.frames
        .filter(
          ({ frame }) =>
            frame[0] === "REQ" &&
            (frame[2] as { kinds: number[] }).kinds[0] === 24200,
        )
        .at(-1)?.frame[1];
    await vi.waitFor(() => expect(observerWire()).toBeTruthy());
    const wire = observerWire();
    const value = {
      id: "a".repeat(64),
      agent: "b".repeat(64),
      createdAt: Math.floor(Date.now() / 1000),
      plaintext: JSON.stringify({
        kind: "turn_started",
        channelId: null,
        turnId: "T",
        seq: 1,
        timestamp: new Date().toISOString(),
      }),
    };
    f.emit("socket-1", "observer", { wire, frame: value });
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().records).toHaveLength(1),
    );
    await owner.clearCache();
    f.emit("socket-1", "observer", { wire, frame: value });
    await vi.waitFor(() => expect(observerWire()).not.toBe(wire));
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(0);
    expect(f.host.open).toHaveBeenCalledOnce();
  } finally {
    release();
    owner.dispose();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
