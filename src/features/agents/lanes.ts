// Several links over one port. The native port between two webviews has one
// end per page, so each link between those pages takes a named lane of it.
import type { LinkPort } from "./link";

type Lane = Readonly<{ lane: string; data: unknown }>;

const isLane = (message: unknown): message is Lane =>
  typeof message === "object" &&
  message !== null &&
  typeof (message as { lane?: unknown }).lane === "string" &&
  "data" in message;

/** A port for each of `names` over `port`. Each delivers what the same lane
 * of the other end sends, once and in order, as `port` does; what arrives
 * before the lane listens waits for it, as for a `MessagePort`. `port`
 * closes once every lane has. */
export function lanes<Name extends string>(
  port: LinkPort,
  names: readonly Name[],
): Readonly<Record<Name, LinkPort>> {
  const open = new Set<Name>(names);
  const ports = {} as Record<Name, LinkPort>;
  const waiting = new Map<Name, unknown[]>();
  const deliver = (name: Name, data: unknown) =>
    ports[name].onmessage?.(new MessageEvent("message", { data }));
  const flush = (name: Name) => {
    const held = waiting.get(name) ?? [];
    while (held.length && ports[name].onmessage) deliver(name, held.shift());
  };
  for (const name of names) {
    let listener: LinkPort["onmessage"] = null;
    waiting.set(name, []);
    ports[name] = {
      get onmessage() {
        return listener;
      },
      set onmessage(next) {
        listener = next;
        // Later, as a MessagePort starts, and before what arrives next.
        if (next && waiting.get(name)?.length)
          queueMicrotask(() => flush(name));
      },
      postMessage(data) {
        if (open.has(name)) port.postMessage({ lane: name, data });
      },
      close() {
        if (!open.delete(name)) return;
        listener = null;
        waiting.delete(name);
        if (open.size === 0) port.close();
      },
    };
  }
  port.onmessage = (event) => {
    const message: unknown = event.data;
    if (!isLane(message) || !open.has(message.lane as Name)) return;
    const name = message.lane as Name;
    const held = waiting.get(name);
    if (ports[name].onmessage && !held?.length) deliver(name, message.data);
    else held?.push(message.data);
  };
  return ports;
}
