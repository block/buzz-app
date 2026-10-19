import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { LocalWork } from "../agents/local-activity";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { createOutbox } from "../relay/outbox";
import { createAgentActivity } from "../agents/activity";
import { followUpQueue } from "./follow-up-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(extra: Partial<RelaySession> = {}) {
  const listeners = new Set<() => void>();
  let local: readonly LocalWork[] = [];
  let turns: ReturnType<RelaySession["agentActivity"]["snapshot"]>["turns"] =
    [];
  const deactivate = vi.fn();
  const session = {
    ...extra,
    agentActivity: {
      activate: () => deactivate,
      snapshot: () => ({ local, turns, status: "listening" }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const queue = followUpQueue(session);
  return {
    queue,
    session,
    deactivate,
    work(messageId: string, state: LocalWork["state"], channelId = "chat") {
      local = [
        ...local.filter((row) => row.messageId !== messageId),
        {
          messageId,
          state,
          channelId,
          agent: "agent",
          scope: "scope",
          threadRootId: "",
          startedAt: 1,
        },
      ];
      for (const listener of listeners) listener();
    },
    remote(state: "working" | "unknown" | "ended") {
      turns = [
        {
          agent: "agent",
          channelId: "chat",
          turnId: "turn",
          timestamp: 1,
          state,
        },
      ];
      for (const listener of listeners) listener();
    },
    loseEvidence() {
      local = [];
      turns = [];
      for (const listener of listeners) listener();
    },
    entry(text: string, channelId = "chat") {
      return {
        text,
        channelId,
        recipients: ["agent"],
        publish: vi.fn(() => text),
      };
    },
  };
}

it("sends idle messages immediately and holds rapid follow-ups through the start gap", () => {
  const h = fixture(),
    first = h.entry("first"),
    second = h.entry("second"),
    third = h.entry("third");
  expect(h.queue.submit(first)).toBe("first");
  h.queue.submit(second);
  h.queue.submit(third);
  expect(second.publish).not.toHaveBeenCalled();
  h.work("first", "working");
  h.work("first", "done");
  expect(second.publish).toHaveBeenCalledOnce();
  expect(third.publish).not.toHaveBeenCalled();
  h.work("second", "working");
  h.work("second", "done");
  expect(third.publish).toHaveBeenCalledOnce();
  expect(h.queue.snapshot()).toEqual([]);
});

it("waits for existing work, survives lost evidence, and permits Send now", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.work("previous", "working");
  h.queue.submit(entry);
  h.loseEvidence();
  expect(entry.publish).not.toHaveBeenCalled();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  expect(entry.publish).toHaveBeenCalledOnce();
  h.work("previous", "done");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("uses explicit remote completion, never a stale unknown state", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.remote("working");
  h.queue.submit(entry);
  h.remote("unknown");
  expect(entry.publish).not.toHaveBeenCalled();
  h.remote("ended");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("retains failed sends for explicit retry without a retry loop", () => {
  const h = fixture(),
    entry = h.entry("next");
  entry.publish.mockImplementationOnce(() => {
    throw new Error("Unavailable recipient");
  });
  h.work("previous", "working");
  h.queue.submit(entry);
  h.work("previous", "done");
  expect(h.queue.snapshot()[0]?.error).toBe("Unavailable recipient");
  h.work("unrelated", "done", "other");
  expect(entry.publish).toHaveBeenCalledOnce();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  expect(entry.publish).toHaveBeenCalledTimes(2);
  expect(h.queue.snapshot()).toEqual([]);
});

it("isolates channels and sessions, and removal never publishes", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.work("previous", "working");
  h.queue.submit(entry);
  expect(h.queue.submit(h.entry("elsewhere", "other"))).toBe("elsewhere");
  expect(followUpQueue(h.session)).toBe(h.queue);
  expect(fixture().queue.snapshot()).toEqual([]);
  h.queue.remove(h.queue.snapshot()[0]?.id ?? "missing");
  h.work("previous", "done");
  expect(entry.publish).not.toHaveBeenCalled();
});

it("does not publish a removed entry while release validation is pending", async () => {
  const h = fixture();
  h.work("previous", "working");
  let resume!: () => void;
  const entry = {
    ...h.entry("next"),
    beforeRelease: () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  };
  h.queue.submit(entry);
  const id = h.queue.snapshot()[0]?.id ?? "missing";
  h.queue.sendNow(id);
  h.queue.remove(id);
  resume();
  await Promise.resolve();
  expect(entry.publish).not.toHaveBeenCalled();
  expect(h.queue.snapshot()).toEqual([]);
});

it("does not let settled local work mask a remote turn", () => {
  const h = fixture();
  h.work("old", "done");
  h.remote("working");
  const entry = h.entry("next");
  h.queue.submit(entry);
  expect(entry.publish).not.toHaveBeenCalled();
  h.remote("ended");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("rechecks automatic blockers after validation but preserves explicit Send", async () => {
  const h = fixture();
  h.work("old", "working");
  const gate = deferred();
  const first = {
    ...h.entry("first"),
    beforeRelease: vi.fn(() => gate.promise),
  };
  h.queue.submit(first);
  h.work("old", "done");
  expect(first.beforeRelease).toHaveBeenCalledOnce();
  h.remote("working");
  gate.resolve();
  await gate.promise;
  expect(first.publish).not.toHaveBeenCalled();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  await Promise.resolve();
  expect(first.publish).toHaveBeenCalledOnce();
});

it("retains a second explicit Send while another entry validates", async () => {
  const h = fixture();
  h.work("old", "working");
  const gate = deferred();
  const first = { ...h.entry("first"), beforeRelease: () => gate.promise };
  const second = { ...h.entry("second"), beforeRelease: async () => {} };
  h.queue.submit(first);
  h.queue.submit(second);
  const [a, b] = h.queue.snapshot();
  h.queue.sendNow(a?.id ?? "missing");
  h.queue.sendNow(b?.id ?? "missing");
  await Promise.resolve();
  expect(second.publish).toHaveBeenCalledOnce();
  gate.resolve();
  await gate.promise;
  expect(first.publish).toHaveBeenCalledOnce();
});

it("validates the idle path and upgrades an automatic release to explicit Send", async () => {
  const h = fixture();
  const gate = deferred();
  const entry = {
    ...h.entry("next"),
    beforeRelease: vi.fn(() => gate.promise),
  };
  h.queue.submit(entry);
  expect(entry.beforeRelease).toHaveBeenCalledOnce();
  expect(entry.publish).not.toHaveBeenCalled();
  h.remote("working");
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  gate.resolve();
  await gate.promise;
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("activates the real observer before deciding and waits for its live snapshot", () => {
  const observe = vi.fn();
  const activity = createAgentActivity(true, observe, () => true);
  const session = { agentActivity: activity.queries } as RelaySession;
  const queue = followUpQueue(session);
  const publish = vi.fn(() => "next");
  try {
    queue.submit({ channelId: "chat", text: "next", recipients: [], publish });
    expect(activity.queries.snapshot().status).toBe("connecting");
    expect(publish).not.toHaveBeenCalled();
    activity.receive(
      {
        id: "1".repeat(64),
        agent: "a".repeat(64),
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: "turn_started",
          turnId: "turn",
          channelId: "chat",
          timestamp: new Date().toISOString(),
        }),
      },
      observe.mock.lastCall?.[0],
    );
    activity.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
    expect(publish).not.toHaveBeenCalled();
    activity.receive(
      {
        id: "2".repeat(64),
        agent: "a".repeat(64),
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: "turn_completed",
          turnId: "turn",
          channelId: "chat",
          timestamp: new Date().toISOString(),
        }),
      },
      observe.mock.lastCall?.[0],
    );
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    activity.dispose();
  }
});

it("only releases a failed Outbox wait after durable dismissal", async () => {
  const save = vi.fn(async () => {});
  const sign = vi.fn(async () => {
    throw new Error("Signing failed");
  });
  const owner = createOutbox(
    "a".repeat(64),
    { sign, publish: async () => {} },
    { load: () => [], save },
  );
  const h = fixture({ outbox: owner.outbox });
  try {
    await owner.ready;
    const first = {
      ...h.entry("first"),
      publish: () =>
        owner.outbox.send({ kind: 9, content: "first", tags: [["h", "chat"]] }),
    };
    const id = h.queue.submit(first) ?? "missing";
    await vi.waitFor(() =>
      expect(owner.outbox.snapshot()[0]?.delivery).toBe("failed"),
    );
    const next = h.entry("next");
    h.queue.submit(next);
    save.mockRejectedValueOnce(new Error("Disk full"));
    await expect(owner.outbox.dismiss(id)).rejects.toThrow("Disk full");
    expect(next.publish).not.toHaveBeenCalled();
    await owner.outbox.dismiss(id);
    expect(next.publish).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});

it.each(["unknown", "accepted"] as const)(
  "retains waits after dismissing %s delivery",
  async (delivery) => {
    const key = new Uint8Array(32).fill(7);
    const owner = createOutbox(
      getPublicKey(key),
      {
        sign: async (event) => finalizeEvent(structuredClone(event), key),
        publish: async () => {
          if (delivery === "unknown") throw new Error("Disconnected");
        },
      },
      { load: () => [], save: async () => {} },
    );
    const h = fixture({ outbox: owner.outbox });
    try {
      await owner.ready;
      const id =
        h.queue.submit({
          ...h.entry("first"),
          publish: () =>
            owner.outbox.send({
              kind: 9,
              content: "first",
              tags: [["h", "chat"]],
            }),
        }) ?? "missing";
      await vi.waitFor(() =>
        expect(owner.outbox.snapshot()[0]?.delivery).toBe(delivery),
      );
      const next = h.entry("next");
      h.queue.submit(next);
      await owner.outbox.dismiss(id);
      expect(next.publish).not.toHaveBeenCalled();
      h.work(id, "done");
      expect(next.publish).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  },
);
