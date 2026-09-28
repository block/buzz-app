import { Channel, invoke } from "@tauri-apps/api/core";
import { eventDto } from "./events";
import { observerFrame } from "../agents/observer";
import type { LiveSocket } from "./live";
type Packet = {
  socket: string;
  seq: number;
  kind: "open" | "message" | "observer" | "closed";
  value: unknown;
};
export type NativeSocketHost = {
  open(lease: string, receive: (packet: Packet) => void): Promise<string>;
  send(lease: string, socket: string, frame: string): Promise<void>;
  authenticate(lease: string, socket: string): Promise<unknown>;
  ack(lease: string, socket: string, seq: number): Promise<void>;
  close(lease: string, socket: string): Promise<void>;
};
export const nativeSocketHost: NativeSocketHost = {
  open(lease, receive) {
    const channel = new Channel<Packet>();
    channel.onmessage = receive;
    return invoke("account_socket_open", { lease, channel });
  },
  send: (lease, socket, frame) =>
    invoke("account_socket_send", { lease, socket, frame }),
  authenticate: (lease, socket) =>
    invoke("account_socket_auth", { lease, socket }),
  ack: (lease, socket, seq) =>
    invoke("account_socket_ack", { lease, socket, seq }),
  close: (lease, socket) => invoke("account_socket_close", { lease, socket }),
};
/** Adapts exactly one physical native socket. Live.ts owns retries and routing. */
export function nativeSocket(
  lease: string,
  host: NativeSocketHost = nativeSocketHost,
  lifetime?: AbortSignal,
): LiveSocket {
  let id: string | undefined,
    closed = false,
    ready: 0 | 1 | 2 | 3 = 0,
    queue: Packet[] = [],
    writes = Promise.resolve();
  let pendingWrites = 0,
    pendingPackets = 0;
  let deliveries = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    ready = 3;
    queue = [];
    lifetime?.removeEventListener("abort", close);
    if (id) void host.close(lease, id).catch(() => {});
  };
  const fail = () => {
    close();
    socket.onerror?.call(socket as WebSocket, new Event("error"));
  };
  const socket: LiveSocket = {
    get readyState() {
      return ready;
    },
    onmessage: null,
    onclose: null,
    onerror: null,
    onobserver: null,
    async authenticate() {
      if (!id || closed) throw new Error("Native socket closed");
      const event = eventDto(await host.authenticate(lease, id));
      if (closed) throw new Error("Native socket closed");
      return event;
    },
    send(frame) {
      if (closed || !id || ready !== 1) return;
      if (++pendingWrites > 64) {
        fail();
        return;
      }
      const captured = id;
      writes = writes
        .then(async () => {
          if (!closed && id === captured)
            await host.send(lease, captured, frame);
        })
        .catch(fail)
        .finally(() => {
          pendingWrites--;
        });
    },
    close,
  };
  const receive = (packet: Packet) => {
    if (closed) return;
    if (!id) {
      if (queue.length >= 32) {
        fail();
        return;
      }
      queue.push(packet);
      return;
    }
    if (packet.socket !== id) return;
    const captured = id;
    if (packet.kind === "closed") {
      close();
      socket.onclose?.call(
        socket as WebSocket,
        new Event("close") as CloseEvent,
      );
      return;
    }
    if (++pendingPackets > 32) {
      fail();
      return;
    }
    deliveries = deliveries
      .then(async () => {
        if (closed) return;
        try {
          if (packet.kind === "open") ready = 1;
          else if (packet.kind === "closed") {
            close();
            socket.onclose?.call(
              socket as WebSocket,
              new Event("close") as CloseEvent,
            );
          } else if (packet.kind === "message")
            await socket.onmessage?.({ data: JSON.stringify(packet.value) });
          else if (packet.kind === "observer") {
            const value = packet.value as { wire?: unknown; frame?: unknown };
            if (typeof value?.wire !== "string")
              throw new Error("Invalid native observer route");
            socket.onobserver?.(value.wire, observerFrame(value.frame));
          }
          if (packet.seq > 0)
            void host.ack(lease, captured, packet.seq).catch(fail);
        } catch {
          fail();
        }
      })
      .catch(fail)
      .finally(() => {
        pendingPackets--;
      });
  };
  lifetime?.addEventListener("abort", close, { once: true });
  if (lifetime?.aborted) close();
  if (!closed)
    void host
      .open(lease, receive)
      .then((socketId) => {
        id = socketId;
        if (closed) {
          void host.close(lease, id).catch(() => {});
          return;
        }
        const early = queue;
        queue = [];
        for (const packet of early) receive(packet);
      })
      .catch(fail);
  return socket;
}
