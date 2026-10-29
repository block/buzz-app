// @vitest-environment jsdom
import { cleanup as cleanupUI, render, screen } from "@testing-library/react";
import { QueuedFollowUps } from "./QueuedFollowUps";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import type { LocalWork } from "../agents/local-activity";
import type { RelaySession } from "../relay/session";
import { createOutbox, type OutgoingEvent } from "../relay/outbox";
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
  let persisted = structuredClone(records);
  const publish = vi.fn(async () => {});
  const save = vi.fn(async (value: readonly OutgoingEvent[]) => {
    persisted = structuredClone(value);
  });
  const owner = createOutbox(
    viewer,
    {
      sign: async (event) => finalizeEvent(structuredClone(event), secret),
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
    channels: { list: () => ({ status: "ready", channels: [channel] }) },
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
