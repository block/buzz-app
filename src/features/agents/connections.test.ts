import { expect, it, vi } from "vitest";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { RunnerConnections } from "./connections";
import type { AgentIdentity } from "./native";

const viewer = "b".repeat(64);
const identity: AgentIdentity = {
  pubkey: "a".repeat(64),
  relay: "wss://relay.example",
  owner: viewer,
  type: "test/agent",
  name: "Ada",
  deleted: false,
};

/** A community relay whose session goes live and down on demand. */
function community() {
  const listeners = new Set<() => void>();
  const session = {} as RelaySession;
  let live = false;
  const relay = {
    snapshot: () =>
      live
        ? {
            status: "ready",
            scope: "scope",
            origin: "https://relay.example",
            viewer,
            session,
          }
        : { status: "connecting" },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  const set = (next: boolean) => {
    live = next;
    for (const listener of [...listeners]) listener();
  };
  return { relay, session, set };
}

it("hears a session while it is live, and says each time its connection changes", () => {
  const { relay, session, set } = community();
  const stopLive = vi.fn();
  const listen = vi.fn(() => stopLive);
  const changed = vi.fn();
  const connections = new RunnerConnections({
    open: () => relay,
    listen,
    changed,
  });
  connections.watch([identity], viewer);
  expect(connections.binding(identity)).toBeUndefined();
  expect(changed).toHaveBeenLastCalledWith("https://relay.example", false);
  // A session that starts after it began watching may have missed changes.
  set(true);
  expect(listen).toHaveBeenCalledWith(
    session,
    "https://relay.example",
    expect.objectContaining({ epoch: 0 }),
  );
  expect(changed).toHaveBeenLastCalledWith("https://relay.example", true);
  // The same session again starts nothing.
  set(true);
  expect(listen).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenLastCalledWith("https://relay.example", false);
  set(false);
  expect(stopLive).toHaveBeenCalled();
  expect(connections.binding(identity)).toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(4);
});

it("does not call a session it found live when it began watching renewed", () => {
  const { relay, set } = community();
  set(true);
  const changed = vi.fn();
  const connections = new RunnerConnections({
    open: () => relay,
    listen: () => () => {},
    changed,
  });
  connections.watch([identity], viewer);
  expect(connections.entries()).toEqual([
    ["https://relay.example", expect.objectContaining({ scope: "scope" })],
  ]);
  expect(changed).toHaveBeenCalledExactlyOnceWith(
    "https://relay.example",
    false,
  );
});

it("calls a community joined again renewed, since it may have missed changes", () => {
  const { relay, set } = community();
  set(true);
  let open: RelayData | undefined = relay;
  const changed = vi.fn();
  const connections = new RunnerConnections({
    open: () => open,
    listen: () => () => {},
    changed,
  });
  connections.watch([identity], viewer);
  open = undefined;
  connections.watch([identity], viewer);
  expect(connections.entries()).toEqual([]);
  const again = community();
  again.set(true);
  open = again.relay;
  connections.watch([identity], viewer);
  expect(changed).toHaveBeenLastCalledWith("https://relay.example", true);
});
