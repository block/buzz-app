// @vitest-environment jsdom
import { cleanup as cleanupUI, render, screen } from "@testing-library/react";
import { QueuedFollowUps } from "./QueuedFollowUps";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import type { LocalWork } from "../agents/local-activity";
import type { RelaySession } from "../relay/session";
import {
  createOutbox,
  PublishRejected,
  type OutgoingEvent,
} from "../relay/outbox";
import { createMessages } from "../relay/messages";
import { followUpQueue } from "./follow-up-queue";
import { followUpMessage } from "./follow-up-message";
import {
  followUpRecovery,
  followUpStorage,
  type FollowUpMessage,
} from "./follow-up-storage";

const secret = new Uint8Array(32).fill(7);
const viewer = getPublicKey(secret);
const agent = "a".repeat(64);
const scope = `https://relay.example:${viewer}`;
const message: FollowUpMessage = {
  channelId: "chat",
  text: "Remember this",
  recipients: [agent],
  attachments: [],
  references: [],
  picks: { [agent]: { model: "model", effort: "high" } },
};
const cleanup: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request(
        name: string,
        options: unknown,
        callback?: (lock: unknown) => unknown,
      ) {
        if (callback) {
          return Promise.resolve(callback(locks.has(name) ? null : {}));
        }
        const run = options as () => unknown;
        const next = (locks.get(name) ?? Promise.resolve()).then(run);
        const held = next.catch(() => {});
        locks.set(name, held);
        void held.then(() => {
          if (locks.get(name) === held) locks.delete(name);
        });
        return next;
      },
    },
  });
});
afterEach(() => {
  cleanupUI();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function fixture(partition = scope, records: readonly OutgoingEvent[] = []) {
  let signGate: Promise<void> | undefined;
  let persisted = structuredClone(records);
  const publish = vi.fn(async () => {});
  const save = vi.fn(async (value: readonly OutgoingEvent[]) => {
    persisted = structuredClone(value);
  });
  const owner = createOutbox(
    viewer,
    {
      sign: async (event) => {
        await signGate;
        return finalizeEvent(structuredClone(event), secret);
      },
      publish,
    },
    { load: () => persisted, save },
  );
  const listeners = new Set<() => void>();
  let working = true;
  let complete = true;
  let selectable = [{ pubkey: agent }];
  let local: LocalWork[] = [];
  let observedRequest: string | undefined;
  let channel = {
    id: "chat",
    channelType: "solo",
    creator: viewer,
    members: [viewer, agent],
    archived: false,
  };
  let rosterStatus = "ready";
  let channelVisible = true;
  const channelListeners = new Set<() => void>();
  const refresh = vi.fn(async () => channel);
  const messages = createMessages(
    owner.outbox,
    viewer,
    () => undefined,
    () => [],
    () => {},
    () => true,
    "https://relay.example",
  );
  const send = vi.spyOn({ ...messages }, "send");
  const session = {
    scope: partition,
    viewer,
    channels: {
      list: () => ({
        status: rosterStatus,
        channels: channelVisible ? [channel] : [],
      }),
      subscribeList: (listener: () => void) => {
        channelListeners.add(listener);
        return () => channelListeners.delete(listener);
      },
    },
    channelWrites: { refreshMembership: refresh },
    agentChoices: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => ({
        identities: [{ pubkey: agent }],
        selectable,
        complete,
      }),
    },
    agentActivity: {
      activate: () => () => {},
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => ({
        status: "listening",
        typing: [],
        local,
        turns: [
          {
            agent,
            channelId: "chat",
            turnId: "old",
            state: working ? "working" : "ended",
            ...(observedRequest
              ? { requests: [{ messageId: observedRequest, threadRootId: "" }] }
              : {}),
          },
        ],
      }),
    },
    messages: { ...messages, send },
    outbox: owner.outbox,
  } as unknown as RelaySession;
  const queue = followUpQueue(session);
  cleanup.push(() => {
    for (const entry of queue.snapshot()) queue.remove(entry.id);
    owner.dispose();
  });
  return {
    session,
    queue,
    owner,
    save,
    publish,
    refresh,
    send,
    saved: () => persisted,
    holdSigning(gate: Promise<void>) {
      signGate = gate;
    },
    roster(status: string, visible: boolean) {
      rosterStatus = status;
      channelVisible = visible;
      for (const listener of channelListeners) listener();
    },
    finish() {
      working = false;
      for (const listener of listeners) listener();
    },
    work(messageId: string, state: LocalWork["state"], worker = agent) {
      local = [
        ...local.filter((row) => row.messageId !== messageId),
        {
          scope: partition,
          agent: worker,
          channelId: "chat",
          messageId,
          threadRootId: "",
          startedAt: 1,
          state,
        },
      ];
      for (const listener of listeners) listener();
    },
    observe(messageId: string) {
      observedRequest = messageId;
      for (const listener of listeners) listener();
    },
    choices(ready: boolean, keys: string[]) {
      complete = ready;
      selectable = keys.map((pubkey) => ({ pubkey }));
      for (const listener of listeners) listener();
    },
    deny() {
      channel = { ...channel, members: [viewer] };
    },
    enqueue(value = message) {
      queue.submit({
        ...value,
        message: value,
        ...followUpMessage(session, value),
      });
      return queue.snapshot().at(-1)?.id ?? "missing";
    },
  };
}

it("restores ordered payloads in the same account/community without automatically publishing", async () => {
  const first = fixture();
  const attachment = {
    name: "note.wav",
    url: `https://relay.example/media/${"b".repeat(64)}.wav`,
    type: "audio/wav",
    size: 32,
    sha256: "b".repeat(64),
    voice: { duration: 2, waveform: [20, 80] },
  };
  first.enqueue({
    ...message,
    attachments: [attachment],
    references: ["c".repeat(64)],
  });
  first.enqueue({ ...message, text: "Second" });
  const restored = fixture();
  await restored.owner.ready;
  restored.finish();
  expect(restored.queue.snapshot().map((row) => row.text)).toEqual([
    "Remember this",
    "Second",
  ]);
  expect(restored.queue.snapshot()[0]?.message).toMatchObject({
    attachments: [attachment],
    references: ["c".repeat(64)],
    picks: message.picks,
  });
  expect(restored.queue.snapshot().every((row) => row.restored)).toBe(true);
  expect(restored.send).not.toHaveBeenCalled();
  expect(fixture(`https://other.example:${viewer}`).queue.snapshot()).toEqual(
    [],
  );
  expect(
    fixture("https://relay.example:another-viewer").queue.snapshot(),
  ).toEqual([]);
  const id = restored.queue.snapshot()[0]?.id ?? "missing";
  restored.queue.sendNow(id);
  await vi.waitFor(() =>
    expect(
      restored.queue.snapshot().map(({ text, error }) => ({ text, error })),
    ).toEqual([{ text: "Second", error: undefined }]),
  );
  expect(restored.send).toHaveBeenCalledWith(
    "chat",
    "Remember this",
    [agent],
    [attachment],
    followUpRecovery(id),
    ["c".repeat(64)],
    message.picks,
  );
  expect(
    followUpStorage(scope)
      .load()
      .map((row) => row.text),
  ).toEqual(["Second"]);
});

it("refuses enqueue on save failure and leaves no in-memory-only queued row", () => {
  const h = fixture();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Disk full");
  });
  expect(() => h.enqueue()).toThrow("Could not save the queued message");
  expect(h.queue.snapshot()).toEqual([]);
  expect(h.send).not.toHaveBeenCalled();
});

it("durably removes a restored row, and retains it if removal fails", () => {
  const h = fixture();
  const id = h.enqueue();
  const restarted = fixture();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Disk unavailable");
    });
  restarted.queue.remove(id);
  expect(restarted.queue.snapshot()[0]?.error).toBe("Disk unavailable");
  expect(followUpStorage(scope).load()).toHaveLength(1);
  remove.mockRestore();
  restarted.queue.remove(id);
  expect(fixture().queue.snapshot()).toEqual([]);
  expect(restarted.send).not.toHaveBeenCalled();
});

it("revalidates restored recipients and retains the payload on denial", async () => {
  const h = fixture();
  const id = h.enqueue();
  const restarted = fixture();
  restarted.deny();
  restarted.queue.sendNow(id);
  await vi.waitFor(() =>
    expect(restarted.queue.snapshot()[0]?.error).toContain(
      "no longer a member",
    ),
  );
  expect(restarted.send).not.toHaveBeenCalled();
  expect(followUpStorage(scope).load()).toHaveLength(1);
});

it("checks compaction again after fresh membership validation", async () => {
  const h = fixture();
  const id = h.enqueue();
  const restarted = fixture();
  restarted.queue.sendNow(id, () => {
    throw new Error("Compacting");
  });
  await vi.waitFor(() =>
    expect(restarted.queue.snapshot()[0]?.error).toBe("Compacting"),
  );
  expect(restarted.refresh).toHaveBeenCalledOnce();
  expect(restarted.send).not.toHaveBeenCalled();
});

it("keeps the queued payload until Outbox durability succeeds and recovers the same event", async () => {
  const h = fixture();
  await h.owner.ready;
  const id = h.enqueue();
  h.save.mockRejectedValue(new Error("Disk full"));
  h.queue.sendNow(id);
  await vi.waitFor(() => expect(h.queue.snapshot()[0]?.error).toBeTruthy());
  expect(followUpStorage(scope).load()).toHaveLength(1);
  expect(h.send).toHaveBeenCalledOnce();
  h.save.mockImplementation(async () => {});
  h.queue.sendNow(id);
  await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
  expect(h.send).toHaveBeenCalledOnce();
  expect(followUpStorage(scope).load()).toEqual([]);
});

it("does not create another message after restart between Outbox save and queue cleanup", async () => {
  const h = fixture();
  await h.owner.ready;
  const id = h.enqueue();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Cleanup failed");
    });
  h.queue.sendNow(id);
  await vi.waitFor(() =>
    expect(h.queue.snapshot()[0]?.error).toBe("Cleanup failed"),
  );
  expect(h.send).toHaveBeenCalledOnce();
  remove.mockRestore();
  const restarted = fixture(scope, h.saved());
  restarted.queue.sendNow(id);
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).not.toHaveBeenCalled();
  expect(followUpStorage(scope).load()).toEqual([]);
});

it("waits for a recovered unknown receipt before releasing the next resumed row", async () => {
  const first = fixture();
  const id = first.enqueue();
  first.enqueue({ ...message, text: "Second" });
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: 1,
      content: message.text,
      tags: [
        ["h", "chat"],
        ["p", agent],
      ],
    },
    secret,
  );
  followUpStorage(scope).sending(id, true);
  const restarted = fixture(scope, [
    {
      event,
      signed: event,
      recovery: followUpRecovery(id),
      delivery: "unknown",
    },
  ]);
  await restarted.owner.ready;
  restarted.finish();
  restarted.queue.resumeAfter(agent, { original: "chat" });
  restarted.work("original", "done");
  // Wait for recovery, queue cleanup, and the finally-scheduled pump to settle.
  await vi.waitFor(() => expect(followUpStorage(scope).has(id)).toBe(false));
  expect(restarted.queue.snapshot().map((row) => row.text)).toEqual(["Second"]);
  expect(restarted.send).not.toHaveBeenCalled();
  expect(restarted.owner.outbox.snapshot()[0]?.delivery).toBe("unknown");
  restarted.work(event.id, "working");
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.work(event.id, "done");
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).toHaveBeenCalledOnce();
  expect(restarted.send.mock.calls[0]?.[1]).toBe("Second");
});

it("serializes competing releases from two windows", async () => {
  const h = fixture();
  const id = h.enqueue();
  const second = fixture();
  h.queue.sendNow(id);
  second.queue.sendNow(id);
  await vi.waitFor(() => {
    expect(h.queue.snapshot()).toEqual([]);
    expect(second.queue.snapshot()).toEqual([]);
  });
  expect(h.send.mock.calls.length + second.send.mock.calls.length).toBe(1);
});

it("keeps unreadable storage intact and reports it instead of overwriting", () => {
  const key = `buzz-view.v1:${JSON.stringify([scope, "follow-up:broken"])}`;
  localStorage.setItem(key, "not json");
  const h = fixture();
  expect(h.queue.storageError()).toContain("could not be read");
  expect(() => h.enqueue()).toThrow("could not be read");
  expect(localStorage.getItem(key)).toBe("not json");
});

it("does not republish from a stale window after the sending window fails queue cleanup", async () => {
  const first = fixture();
  const id = first.enqueue();
  const stale = fixture();
  await Promise.all([first.owner.ready, stale.owner.ready]);
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Cleanup failed");
    });
  first.queue.sendNow(id);
  await vi.waitFor(() =>
    expect(first.queue.snapshot()[0]?.error).toBe("Cleanup failed"),
  );
  remove.mockRestore();
  stale.queue.sendNow(id);
  await vi.waitFor(() =>
    expect(stale.queue.snapshot()[0]?.error).toContain("Reload to recover"),
  );
  expect(stale.send).not.toHaveBeenCalled();
  expect(followUpStorage(scope).load()[0]?.sending).toBe(true);
  const refreshed = fixture(scope, first.saved());
  refreshed.queue.sendNow(id);
  await vi.waitFor(() => expect(refreshed.queue.snapshot()).toEqual([]));
  expect(refreshed.send).not.toHaveBeenCalled();
});

it("retains an interrupted handoff with no receipt for explicit inspection, never automatic resend", async () => {
  const first = fixture();
  const id = first.enqueue();
  followUpStorage(scope).sending(id, true);
  const restarted = fixture();
  restarted.queue.sendNow(id);
  await vi.waitFor(() =>
    expect(restarted.queue.snapshot()[0]?.error).toContain(
      "check the conversation",
    ),
  );
  expect(restarted.send).not.toHaveBeenCalled();
  expect(restarted.queue.snapshot()[0]?.text).toBe(message.text);
  restarted.queue.remove(id);
  await vi.waitFor(() => expect(followUpStorage(scope).load()).toEqual([]));
});

it("Resume waits for the restarted request, then drains restored rows one turn at a time", async () => {
  const first = fixture();
  first.enqueue();
  first.enqueue({ ...message, text: "Second" });
  const restarted = fixture();
  restarted.finish();
  restarted.queue.resumeAfter(agent, { original: "chat" });
  await Promise.resolve();
  expect(restarted.queue.snapshot().every((row) => !row.restored)).toBe(true);
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.work("original", "working");
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.work("original", "done");
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toHaveLength(1));
  expect(restarted.send).toHaveBeenCalledOnce();
  const sentId = restarted.send.mock.results[0]?.value as string;
  restarted.work(sentId, "working");
  expect(restarted.send).toHaveBeenCalledOnce();
  restarted.work(sentId, "done");
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).toHaveBeenCalledTimes(2);
});

it("does not let an old observer turn hold the queue after its resumed request completes", async () => {
  const first = fixture();
  first.enqueue();
  const restarted = fixture();
  restarted.observe("original");
  restarted.queue.resumeAfter(agent, { original: "chat" });
  restarted.work("original", "working");
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.work("original", "done");
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).toHaveBeenCalledOnce();
});

it("keeps unrelated restored chats paused and uncertain resumed requests waiting", async () => {
  const first = fixture();
  first.enqueue();
  const restarted = fixture();
  restarted.finish();
  restarted.queue.resumeAfter(agent, { elsewhere: "other-chat" });
  await Promise.resolve();
  expect(restarted.queue.snapshot()[0]?.restored).toBe(true);
  restarted.queue.resumeAfter(agent, { missing: "chat" });
  restarted.work("unrelated", "done");
  expect(restarted.send).not.toHaveBeenCalled();
  expect(restarted.queue.snapshot()).toHaveLength(1);
});

it("rechecks resumed automatic sends at the final publication boundary", async () => {
  const first = fixture();
  first.enqueue();
  const restarted = fixture();
  restarted.finish();
  const guard = vi.fn(() => {
    throw new Error("Compacting");
  });
  restarted.queue.resumeAfter(agent, { original: "chat" }, guard);
  restarted.work("original", "done");
  await vi.waitFor(() =>
    expect(restarted.queue.snapshot()[0]?.error).toBe("Compacting"),
  );
  expect(restarted.refresh).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledWith(
    expect.objectContaining({ channelId: "chat", recipients: [agent] }),
  );
  expect(restarted.send).not.toHaveBeenCalled();
  expect(
    followUpStorage(scope).isSending(
      restarted.queue.snapshot()[0]?.id ?? "missing",
    ),
  ).toBe(false);
});

it("waits for every resumed agent in a chat before releasing its first saved message", async () => {
  const first = fixture();
  first.enqueue();
  const restarted = fixture();
  restarted.finish();
  const otherAgent = "d".repeat(64);
  restarted.queue.resumeAfter(agent, { firstRequest: "chat" });
  restarted.queue.resumeAfter(otherAgent, { secondRequest: "chat" });
  restarted.work("firstRequest", "done");
  restarted.work("secondRequest", "working", otherAgent);
  await Promise.resolve();
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.work("secondRequest", "done", otherAgent);
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).toHaveBeenCalledOnce();
});

it("refuses Remove in either window while the Outbox handoff is pending", async () => {
  const first = fixture();
  const id = first.enqueue();
  const second = fixture();
  cleanup.push(second.queue.subscribe(() => {}));
  await first.owner.ready;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  first.save.mockImplementationOnce(() => pending);
  try {
    first.queue.sendNow(id);
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledOnce());
    window.dispatchEvent(new StorageEvent("storage"));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    render(
      createElement(QueuedFollowUps, {
        session: second.session,
        channelId: "chat",
        disabled: false,
        focusComposer() {},
      }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Remove queued message",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(first.queue.snapshot()[0]?.sending).toBe(true);
    expect(second.queue.snapshot()[0]?.sending).toBe(true);
    first.queue.remove(id);
    second.queue.remove(id);
    await Promise.resolve();
    expect(followUpStorage(scope).has(id)).toBe(true);
    expect(first.queue.snapshot()).toHaveLength(1);
    expect(second.queue.snapshot()).toHaveLength(1);
  } finally {
    finish();
  }
  await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
  expect(first.send).toHaveBeenCalledOnce();
});

it("keeps earlier rows draining when another window removes a later row", async () => {
  const first = fixture();
  const earlier = first.enqueue();
  const later = first.enqueue({ ...message, text: "Later" });
  cleanup.push(first.queue.subscribe(() => {}));
  const second = fixture();
  second.queue.remove(later);
  await vi.waitFor(() => expect(followUpStorage(scope).has(later)).toBe(false));
  window.dispatchEvent(new StorageEvent("storage"));
  expect(first.queue.snapshot()).toMatchObject([{ id: earlier }]);
  expect(first.queue.snapshot()[0]?.restored).not.toBe(true);
  first.finish();
  await vi.waitFor(() => expect(first.send).toHaveBeenCalledOnce());
});

it("cancels a local queued send while membership validation is pending", async () => {
  const first = fixture();
  const id = first.enqueue();
  const channel = await first.refresh();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.refresh.mockImplementationOnce(async () => {
    await held;
    return channel;
  });
  first.refresh.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(
    createElement(QueuedFollowUps, {
      session: first.session,
      channelId: "chat",
      disabled: false,
      focusComposer() {},
    }),
  );
  first.finish();
  try {
    await vi.waitFor(() => expect(first.refresh).toHaveBeenCalledOnce());
    screen.getByRole("button", { name: "Remove queued message" }).click();
    expect(first.queue.snapshot()).toEqual([]);
    expect(followUpStorage(scope).has(id)).toBe(false);
  } finally {
    release();
    // Acquiring the row lock proves the validation/release operation finished.
    await followUpStorage(scope).lock(id, async () => {});
  }
  expect(first.send).not.toHaveBeenCalled();
});

it("pauses newly discovered successors when predecessor storage events are coalesced", async () => {
  const first = fixture();
  const predecessor = first.enqueue();
  cleanup.push(first.queue.subscribe(() => {}));
  const second = fixture();
  const successor = second.enqueue({ ...message, text: "New successor" });
  second.queue.remove(predecessor);
  await vi.waitFor(() =>
    expect(followUpStorage(scope).has(predecessor)).toBe(false),
  );
  // This window never observed the successor while its predecessor existed.
  window.dispatchEvent(new StorageEvent("storage"));
  expect(first.queue.snapshot()).toMatchObject([
    {
      id: successor,
      restored: true,
      resumeCancelled: true,
      predecessorRemoved: true,
    },
  ]);
  first.queue.resumeAfter(agent, { original: "chat" });
  first.work("original", "done");
  first.finish();
  await followUpStorage(scope).lock(successor, async () => {});
  expect(first.send).not.toHaveBeenCalled();
  expect(first.queue.snapshot()[0]?.restored).toBe(true);
});

it("refuses removal while another window owns the row before setting its sending marker", async () => {
  const first = fixture();
  const id = first.enqueue();
  const second = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const acquired = new Promise<void>((resolve) => {
    started = resolve;
  });
  const lock = followUpStorage(scope).lock(id, async () => {
    started();
    await held;
  });
  try {
    await acquired;
    expect(followUpStorage(scope).isSending(id)).toBe(false);
    second.queue.remove(id);
    await Promise.resolve();
    expect(followUpStorage(scope).has(id)).toBe(true);
  } finally {
    release();
    await lock;
  }
  second.queue.remove(id);
  await vi.waitFor(() => expect(followUpStorage(scope).has(id)).toBe(false));
});

it("pauses a later row when another window removes its handed-off predecessor", async () => {
  const first = fixture();
  const id = first.enqueue();
  const second = fixture();
  cleanup.push(second.queue.subscribe(() => {}));
  second.enqueue({ ...message, text: "Second" });
  second.finish();
  first.queue.sendNow(id);
  await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
  // The second window has no Outbox receipt or activity for the predecessor.
  window.dispatchEvent(new StorageEvent("storage"));
  expect(second.queue.snapshot()).toMatchObject([
    { text: "Second", restored: true },
  ]);
  expect(second.send).not.toHaveBeenCalled();
  second.queue.resumeAfter(agent, { original: "chat" });
  second.work("original", "done");
  expect(second.queue.snapshot()[0]?.restored).toBe(true);
  expect(second.send).not.toHaveBeenCalled();
  second.queue.sendNow(second.queue.snapshot()[0]?.id ?? "missing");
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledOnce());
});

it("defers missing recipients in partial inventory, then drains when choices arrive", async () => {
  fixture().enqueue();
  const restarted = fixture();
  restarted.choices(false, []);
  restarted.finish();
  restarted.queue.resumeAfter(agent, { original: "chat" });
  restarted.work("original", "done");
  // Drain the current microtask work (including membership validation and release).
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(restarted.queue.snapshot()[0]?.error).toBeUndefined();
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.choices(true, [agent]);
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).toHaveBeenCalledOnce();
});

it("retains an availability error once inventory confirms a missing recipient", async () => {
  fixture().enqueue();
  const restarted = fixture();
  restarted.choices(false, []);
  restarted.finish();
  restarted.queue.resumeAfter(agent, { original: "chat" });
  restarted.work("original", "done");
  restarted.choices(true, []);
  await vi.waitFor(() =>
    expect(restarted.queue.snapshot()[0]?.error).toContain(
      "no longer available",
    ),
  );
  expect(restarted.send).not.toHaveBeenCalled();
});

it("pauses forgotten resumes without discarding another agent's barrier", async () => {
  fixture().enqueue();
  const restarted = fixture();
  restarted.finish();
  const other = "d".repeat(64);
  restarted.queue.resumeAfter(agent, { missing: "chat" });
  restarted.queue.resumeAfter(other, { retained: "chat" });
  restarted.queue.pauseAfter(agent, { missing: "chat" });
  expect(restarted.queue.snapshot()[0]?.restored).toBe(true);
  expect(restarted.send).not.toHaveBeenCalled();
  // Another runner arming this same chat must not undo an abandonment pause.
  restarted.queue.resumeAfter(agent, { newer: "chat" });
  restarted.work("newer", "done");
  await Promise.resolve();
  expect(restarted.send).not.toHaveBeenCalled();
  expect(restarted.queue.snapshot()[0]?.restored).toBe(true);
  restarted.queue.remove(restarted.queue.snapshot()[0]?.id ?? "missing");
  restarted.enqueue({ ...message, text: "New follow-up" });
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.work("retained", "done", other);
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
});

it("lets the user remove an abandoned sending marker without trying Send first", async () => {
  const first = fixture();
  const id = first.enqueue();
  followUpStorage(scope).sending(id, true);
  const restarted = fixture();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(
    createElement(QueuedFollowUps, {
      session: restarted.session,
      channelId: "chat",
      disabled: false,
      focusComposer() {},
    }),
  );
  const remove = screen.getByRole("button", {
    name: "Remove queued message",
  }) as HTMLButtonElement;
  await vi.waitFor(() => expect(remove.disabled).toBe(false));
  remove.click();
  await vi.waitFor(() => expect(followUpStorage(scope).has(id)).toBe(false));
  expect(restarted.send).not.toHaveBeenCalled();
});

it("retains a manual Send through partial discovery even while another turn works", async () => {
  const id = fixture().enqueue();
  const restarted = fixture();
  restarted.choices(false, []);
  const guard = vi.fn();
  restarted.queue.sendNow(id, guard);
  // Taking the row lock proves the prior release has finished deferring.
  await followUpStorage(scope).lock(id, async () => {});
  expect(restarted.send).not.toHaveBeenCalled();
  expect(guard).not.toHaveBeenCalled();
  restarted.choices(true, [agent]);
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledOnce();
});

it("cancels a deferred manual Send when its row is removed", async () => {
  const id = fixture().enqueue();
  const restarted = fixture();
  restarted.choices(false, []);
  restarted.queue.sendNow(id);
  await followUpStorage(scope).lock(id, async () => {});
  restarted.queue.remove(id);
  restarted.choices(true, [agent]);
  await followUpStorage(scope).lock(id, async () => {});
  expect(restarted.queue.snapshot()).toEqual([]);
  expect(restarted.send).not.toHaveBeenCalled();
});

it("unlocks Remove in an already-open window after the sending window abandons its handoff", async () => {
  const first = fixture();
  const id = first.enqueue();
  const second = fixture();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(
    createElement(QueuedFollowUps, {
      session: second.session,
      channelId: "chat",
      disabled: false,
      focusComposer() {},
    }),
  );
  const remove = screen.getByRole("button", {
    name: "Remove queued message",
  }) as HTMLButtonElement;
  await first.owner.ready;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  first.save.mockImplementation(() => pending);
  try {
    first.queue.sendNow(id);
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledOnce());
    window.dispatchEvent(new StorageEvent("storage"));
    await vi.waitFor(() => expect(remove.disabled).toBe(true));
  } finally {
    fail(new Error("Outbox unavailable"));
  }
  // No storage event or remount follows the lock release.
  await vi.waitFor(() => expect(first.queue.snapshot()[0]?.error).toBeTruthy());
  await vi.waitFor(() => expect(remove.disabled).toBe(false));
  expect(followUpStorage(scope).isSending(id)).toBe(true);
  const next = second.enqueue();
  await followUpStorage(scope).lock(id, async () => {});
  await vi.waitFor(() => expect(remove.disabled).toBe(false));
  expect(followUpStorage(scope).isSending(id)).toBe(true);
  remove.click();
  await vi.waitFor(() =>
    expect(second.queue.snapshot().map((entry) => entry.id)).toEqual([next]),
  );
  expect(second.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves in-flight cleanup and errors when a resume is abandoned (failure: %s)",
  async (failure) => {
    const id = fixture().enqueue();
    const restarted = fixture();
    restarted.queue.resumeAfter(agent, { missing: "chat" });
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const outbox = { ...restarted.owner.outbox };
    const recover = vi
      .spyOn(outbox, "recover")
      .mockImplementationOnce(() => pending);
    Object.assign(restarted.session, { outbox });
    try {
      restarted.queue.sendNow(id);
      await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
      restarted.queue.pauseAfter(agent, { missing: "chat" });
      expect(restarted.queue.snapshot()[0]?.restored).toBe(true);
    } finally {
      if (failure) fail(new Error("Recovery failed"));
      else finish();
    }
    if (failure) {
      await vi.waitFor(() =>
        expect(restarted.queue.snapshot()[0]?.error).toBe("Recovery failed"),
      );
      expect(restarted.queue.snapshot()[0]?.sending).toBe(true);
    } else {
      await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
      expect(followUpStorage(scope).has(id)).toBe(false);
    }
    expect(restarted.send).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "respects a pause during membership validation except for explicit Send (manual: %s)",
  async (manual) => {
    const id = fixture().enqueue();
    const restarted = fixture();
    const channel = await restarted.refresh();
    restarted.refresh.mockClear();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    restarted.refresh.mockImplementationOnce(async () => {
      await pending;
      return channel;
    });
    restarted.finish();
    restarted.queue.resumeAfter(agent, { original: "chat" });
    try {
      if (manual) restarted.queue.sendNow(id);
      else restarted.work("original", "done");
      await vi.waitFor(() => expect(restarted.refresh).toHaveBeenCalledOnce());
      restarted.queue.pauseAfter(agent, { original: "chat" });
    } finally {
      finish();
    }
    await followUpStorage(scope).lock(id, async () => {});
    if (manual) {
      expect(restarted.send).toHaveBeenCalledOnce();
      expect(restarted.queue.snapshot()).toEqual([]);
    } else {
      expect(restarted.send).not.toHaveBeenCalled();
      expect(restarted.queue.snapshot()[0]?.restored).toBe(true);
    }
  },
);

it.each(["loading", "error"])(
  "keeps resumed saved rows when the empty roster is %s",
  async (status) => {
    const id = fixture().enqueue();
    const h = fixture();
    h.roster(status, false);
    h.queue.resumeAfter(agent, { original: "chat" });
    h.roster(status, false);
    await followUpStorage(scope).lock(id, async () => {});
    expect(h.queue.snapshot().map((row) => row.id)).toEqual([id]);
    expect(followUpStorage(scope).has(id)).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    h.roster("ready", true);
    h.work("original", "done");
    h.finish();
    await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
    expect(h.send).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "keeps Remove fenced after recovery failure until delivery or failed dismissal (%s)",
  async (failed) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const h = fixture();
    await h.owner.ready;
    const id = h.enqueue();
    let release!: () => void;
    h.holdSigning(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    if (failed)
      h.publish.mockRejectedValue(new PublishRejected("Publish refused"));
    h.save
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("Recovery disk failure"));
    render(
      createElement(QueuedFollowUps, {
        session: h.session,
        channelId: "chat",
        disabled: false,
        focusComposer() {},
      }),
    );
    try {
      h.queue.sendNow(id);
      await vi.waitFor(() =>
        expect(h.queue.snapshot()[0]?.error).toBe("Recovery disk failure"),
      );
      await followUpStorage(scope).lock(id, async () => {});
      expect(
        (
          screen.getByRole("button", {
            name: "Remove queued message",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      h.queue.remove(id);
      await followUpStorage(scope).lock(id, async () => {});
      expect(followUpStorage(scope).has(id)).toBe(true);
      // Restoring the row must not clear known Outbox ownership either.
      window.dispatchEvent(new StorageEvent("storage"));
      await followUpStorage(scope).lock(id, async () => {});
      expect(h.queue.snapshot()[0]?.sending).toBe(true);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    if (failed) {
      await vi.waitFor(() =>
        expect(h.owner.outbox.snapshot()[0]?.delivery).toBe("failed"),
      );
      await h.owner.outbox.dismiss(
        h.owner.outbox.snapshot()[0]?.event.id ?? "missing",
      );
      expect(
        (
          screen.getByRole("button", {
            name: "Remove queued message",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      h.queue.remove(id);
    } else h.queue.sendNow(id);
    await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
    expect(h.send).toHaveBeenCalledOnce();
  },
);

it("abandoning a gated resumed reread pauses only its saved rows, not fresh submissions", async () => {
  const id = fixture().enqueue();
  const h = fixture();
  h.finish();
  h.queue.resumeAfter(agent, { original: "chat" });
  let finishRead!: () => void;
  const read = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const abandoned = read.then(() =>
    h.queue.pauseAfter(agent, { original: "chat" }),
  );
  const fresh = h.enqueue({ ...message, text: "Fresh follow-up" });
  finishRead();
  await abandoned;
  expect(h.queue.snapshot().find((row) => row.id === id)?.restored).toBe(true);
  expect(h.queue.snapshot().find((row) => row.id === fresh)?.restored).not.toBe(
    true,
  );
  h.queue.remove(id);
  await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.send.mock.calls[0]?.[1]).toBe("Fresh follow-up");
});
