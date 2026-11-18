import { describe, expect, it, vi } from "vitest";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { readyOwnerReads, workflowMarked } from "./reads";
import type { RelayEvent } from "../relay/events";

const owner = "a".repeat(64);
const agent = { relay: "wss://relay.example", owner, pubkey: "b".repeat(64) };
const ready = (session: object, over: Partial<RelaySnapshot> = {}) =>
  ({
    status: "ready",
    generation: 1,
    origin: "https://relay.example",
    viewer: owner,
    scope: `https://relay.example:${owner}`,
    session,
    ...over,
  }) as unknown as RelaySnapshot;

/** A community connection whose snapshot the test sets, as its service would. */
function community(first: RelaySnapshot) {
  let snapshot = first;
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
    retry: vi.fn(),
    tryAgain: vi.fn(),
  } as unknown as RelayData & {
    subscribe: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
  return {
    relay,
    listeners,
    publish(next: RelaySnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
/** A session whose channel list the test settles. */
function session(status = "ready", workflowAuthority?: string) {
  const listeners = new Set<() => void>();
  return {
    workflowAuthority,
    listeners,
    channels: {
      list: () => ({ status, channels: [] }),
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    listed() {
      status = "ready";
      for (const listener of [...listeners]) listener();
    },
  };
}
const connecting = {
  status: "connecting",
  generation: 2,
  session: session(),
} as unknown as RelaySnapshot;

describe("readyOwnerReads", () => {
  it("answers a ready community now, without waiting or reconnecting", async () => {
    // Ready with no workflow key is the permission check's to refuse.
    const first = session();
    const c = community(ready(first));
    const reads = await readyOwnerReads(
      c.relay,
      agent,
      new AbortController().signal,
    );
    expect(reads?.connection).toBe(first);
    expect(reads?.workflowAuthority()).toBeUndefined();
    expect(c.relay.retry).not.toHaveBeenCalled();
    expect(c.listeners.size).toBe(0);
  });

  it("waits for a ready community's channel list when it starts while loading", async () => {
    const first = session("loading", "c".repeat(64));
    const c = community(ready(first));
    const settled = vi.fn();
    const reads = readyOwnerReads(c.relay, agent, new AbortController().signal);
    void reads.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    first.listed();
    expect((await reads).connection).toBe(first);
    expect(first.listeners.size).toBe(0);
    expect(c.listeners.size).toBe(0);
    expect(c.relay.retry).not.toHaveBeenCalled();
  });

  it("waits through a reconnect for the replacing session of the same community and owner", async () => {
    const c = community(connecting);
    const reads = readyOwnerReads(c.relay, agent, new AbortController().signal);
    c.publish({
      ...connecting,
      status: "error",
      retrying: true,
    } as RelaySnapshot);
    const replacement = session("loading", "c".repeat(64));
    const settled = vi.fn();
    void reads.then(settled);
    c.publish(ready(replacement, { generation: 3 }));
    await Promise.resolve();
    // It waits for the replacement to list its channels too.
    expect(settled).not.toHaveBeenCalled();
    replacement.listed();
    expect((await reads)?.connection).toBe(replacement);
    expect(replacement.listeners.size).toBe(0);
    expect((await reads)?.workflowAuthority()).toBe("c".repeat(64));
    expect(c.listeners.size).toBe(0);
    expect(c.relay.retry).not.toHaveBeenCalled();
  });

  it.each([
    [
      "another community",
      {
        origin: "https://other.example",
        scope: `https://other.example:${owner}`,
      },
    ],
    [
      "another owner",
      {
        viewer: "d".repeat(64),
        scope: `https://relay.example:${"d".repeat(64)}`,
      },
    ],
  ])("rejects a community ready as %s", async (_name, over) => {
    const c = community(connecting);
    const reads = readyOwnerReads(c.relay, agent, new AbortController().signal);
    c.publish(ready(session(), over as Partial<RelaySnapshot>));
    await expect(reads).rejects.toThrow(
      "Workflow request could not start: its community is no longer connected.",
    );
    expect(c.listeners.size).toBe(0);
  });

  it.each([
    ["a disconnect", { status: "disconnected" }],
    ["a terminal error", { status: "error" }],
    ["a refusal", { status: "error", retrying: true, denied: true }],
  ])("rejects after %s", async (_name, over) => {
    const c = community(connecting);
    const reads = readyOwnerReads(c.relay, agent, new AbortController().signal);
    c.publish({ ...connecting, ...over } as RelaySnapshot);
    await expect(reads).rejects.toThrow(
      "Workflow request could not start: its community is no longer connected.",
    );
    expect(c.listeners.size).toBe(0);
  });

  it("rejects without a connection", async () => {
    await expect(
      readyOwnerReads(undefined, agent, new AbortController().signal),
    ).rejects.toThrow("its community is no longer connected");
  });

  it("rejects visibly on the deadline, stops listening, and a later ready does nothing", async () => {
    const c = community(connecting);
    const deadline = new AbortController();
    const reads = readyOwnerReads(c.relay, agent, deadline.signal);
    const settled = vi.fn();
    void reads.then(settled, () => {});
    expect(c.listeners.size).toBe(1);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    await expect(reads).rejects.toThrow(
      "Workflow request could not start: its community did not reconnect before the delivery deadline.",
    );
    expect(c.listeners.size).toBe(0);
    c.publish(ready(session()));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });

  it("rejects an aborted request without listening", async () => {
    const c = community(connecting);
    const stop = new AbortController();
    stop.abort();
    await expect(readyOwnerReads(c.relay, agent, stop.signal)).rejects.toThrow(
      "Workflow request could not start",
    );
    expect(c.relay.subscribe).not.toHaveBeenCalled();
  });
});

describe("workflowMarked", () => {
  const event = (pubkey: string, tags: string[][]) =>
    ({ pubkey, tags }) as unknown as RelayEvent;
  it("marks only a workflow's message that is not the owner's own", () => {
    expect(
      workflowMarked(event("e".repeat(64), [["buzz:workflow", "true"]]), owner),
    ).toBe(true);
    expect(
      workflowMarked(event(owner, [["buzz:workflow", "true"]]), owner),
    ).toBe(false);
    expect(workflowMarked(event("e".repeat(64), [["p", owner]]), owner)).toBe(
      false,
    );
  });
});
