// @vitest-environment jsdom
import {
  act,
  cleanup as cleanupUI,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueuedFollowUps } from "./QueuedFollowUps";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import type { LocalWork } from "../agents/local-activity";
import type { RelaySession } from "../relay/session";
import type { ProfileQueries } from "../relay/profile-directory";
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
import { messageTokenTags } from "./message-tokens";

// Pause storage helpers that read either saved pause shape, so the same
// test runs against the commit before a pause storage change.
type PauseStorage = {
  pauseState?(channelId: string): { paused: boolean };
  savePauseState?(
    channelId: string,
    state: {
      seq: number;
      paused: boolean;
      lastStopSeq: number;
      generation: number;
    },
  ): void;
  paused?(channelId: string): boolean;
  pause?(channelId: string, paused: boolean): void;
};
function savedPause(scope: string, channelId: string) {
  const storage = followUpStorage(scope) as unknown as PauseStorage;
  return storage.pauseState
    ? storage.pauseState(channelId).paused
    : !!storage.paused?.(channelId);
}
/** The storage event another window's latest pause write sends. */
function pauseStorageEvent(scope: string) {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.includes(scope) && key.includes("follow-up-pause"))
      return new StorageEvent("storage", {
        key,
        newValue: localStorage.getItem(key),
      });
  }
  return new StorageEvent("storage");
}
/** Releases check recipients before they take the chat lock; let those
 * checks finish, then wait for every release holding or queued on it. */
async function releasesSettled(scope: string, channelId = "chat") {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await followUpStorage(scope).lockChat(channelId, async () => {});
}
function writeSavedPause(scope: string, channelId: string) {
  const storage = followUpStorage(scope) as unknown as PauseStorage;
  if (storage.savePauseState)
    storage.savePauseState(channelId, {
      seq: 1,
      paused: true,
      lastStopSeq: 1,
      generation: 0,
    });
  else storage.pause?.(channelId, true);
}

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
// Queued rows' durable admissions, which wait for the chat lock.
const admissions: Promise<unknown>[] = [];
/** Every row queued so far has been saved, or failed to save. */
async function admitted() {
  await Promise.all(admissions.splice(0));
}
const journals = new Map<string, readonly OutgoingEvent[]>();
beforeEach(() => {
  localStorage.clear();
  journals.clear();
  admissions.length = 0;
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      query: async () => ({
        held: [...locks.keys()].map((name) => ({ name })),
        pending: [],
      }),
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

function fixture(
  partition = scope,
  records: readonly OutgoingEvent[] = [],
  incremental = false,
  dm = false,
) {
  let signGate: Promise<void> | undefined;
  let persisted = structuredClone(records);
  if (records.length || !journals.has(partition))
    journals.set(partition, persisted);
  const publish = vi.fn(async () => {});
  const save = vi.fn(
    async (value: readonly OutgoingEvent[], options?: { force?: string }) => {
      if (incremental) {
        const next = new Map(
          (journals.get(partition) ?? []).map((item) => [item.event.id, item]),
        );
        for (const item of value) {
          const old = persisted.find(
            (previous) => previous.event.id === item.event.id,
          );
          if (
            options?.force === item.event.id ||
            JSON.stringify(old) !== JSON.stringify(item)
          )
            next.set(item.event.id, structuredClone(item));
        }
        for (const old of persisted)
          if (!value.some((item) => item.event.id === old.event.id))
            next.delete(old.event.id);
        journals.set(partition, [...next.values()]);
      } else journals.set(partition, structuredClone(value));
      persisted = structuredClone(value);
    },
  );
  const owner = createOutbox(
    viewer,
    {
      sign: async (event) => {
        await signGate;
        return finalizeEvent(structuredClone(event), secret);
      },
      publish,
    },
    {
      lock: (id, run) =>
        navigator.locks.request(`outbox:${partition}:${id}`, run),
      forget: (id) => {
        persisted = persisted.filter((item) => item.event.id !== id);
      },
      load: (options) => {
        const records = journals.get(partition) ?? [];
        if (!options?.readOnly) persisted = structuredClone(records);
        return records;
      },
      save,
    },
  );
  const listeners = new Set<() => void>();
  let working = true;
  let complete = true;
  let selectable: { pubkey: string; managed?: boolean }[] = [
    { pubkey: agent, ...(dm ? { managed: true } : {}) },
  ];
  let local: LocalWork[] = [];
  let observedRequest: string | undefined;
  let channel: {
    id: string;
    channelType: string;
    creator?: string;
    members: string[];
    archived: boolean;
  } = dm
    ? {
        id: "chat",
        channelType: "dm",
        members: [viewer, agent],
        archived: false,
      }
    : {
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
  let profileCache = new Map([[agent, { name: "Agent", isAgent: true }]]);
  const messages = createMessages(
    owner.outbox,
    viewer,
    () => undefined,
    () => [],
    () => {},
    () => true,
    "https://relay.example",
    undefined,
    undefined,
    {
      snapshot: () => profileCache,
    } as unknown as ProfileQueries,
    (id) =>
      id === channel.id && channel.channelType === "dm"
        ? channel.members.filter((key) => key !== viewer)
        : [],
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
  let lastAdmission: Promise<unknown> | undefined;
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
    /** The agent stays selectable, but its profile isn't cached yet. */
    coldProfiles() {
      profileCache = new Map();
    },
    members(keys: string[]) {
      channel = { ...channel, members: keys };
    },
    ownership(choice: { managed?: boolean; messageable?: boolean } | null) {
      selectable = choice ? [{ pubkey: agent, ...choice }] : [];
      for (const listener of listeners) listener();
    },
    enqueue(value = message, validated = false) {
      const admission = queue.submit(
        {
          ...value,
          message: value,
          ...followUpMessage(session, value),
        },
        validated,
      );
      if (admission instanceof Promise) {
        admissions.push(admission.catch(() => {}));
        lastAdmission = admission;
      }
      return queue.snapshot().at(-1)?.id ?? "missing";
    },
    /** The last queued row's durable admission under the chat lock. */
    admission: () => lastAdmission,
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
  await admitted();
  first.enqueue({ ...message, text: "Second" });
  await admitted();
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

it("restores a queued message's chips and signs them on the recovered send", async () => {
  const token = {
    kind: "folder" as const,
    id: "/example/repos/notes",
    label: "notes",
  };
  fixture().enqueue({ ...message, tokens: [token] });
  await admitted();
  const restored = fixture();
  await restored.owner.ready;
  const row = restored.queue.snapshot()[0];
  if (!row) throw new Error("Queued message was not restored");
  expect(row.message?.tokens).toEqual([token]);
  restored.queue.sendNow(row.id);
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledOnce());
  const [event] = restored.publish.mock.calls[0] as unknown as [
    { tags: string[][] },
  ];
  expect(event.tags).toContainEqual(messageTokenTags([token])[0]);
});

it.each([
  {},
  [{ kind: "unknown", id: "broken", label: "Broken" }],
  Array(33).fill({ kind: "folder", id: "/f", label: "f" }),
])(
  "keeps saved messages with invalid or oversized chips unsent and unchanged: %j",
  async (tokens) => {
    followUpStorage(scope).save({
      ...message,
      id: "invalid-tokens",
      createdAt: 1,
      tokens: tokens as unknown as NonNullable<FollowUpMessage["tokens"]>,
    });
    const key = `buzz-view.v1:${JSON.stringify([scope, "follow-up:invalid-tokens"])}`;
    const saved = localStorage.getItem(key);
    const restored = fixture();
    await restored.owner.ready.catch(() => {});
    expect(restored.queue.storageError()).toContain("could not be read");
    expect(restored.queue.snapshot()).toEqual([]);
    expect(restored.send).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(saved);
  },
);

it("refuses enqueue on save failure and leaves no in-memory-only queued row", async () => {
  const h = fixture();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Disk full");
  });
  h.enqueue();
  await expect(h.admission()).rejects.toThrow(
    "Could not save the queued message",
  );
  expect(h.queue.snapshot()).toEqual([]);
  expect(h.send).not.toHaveBeenCalled();
});

it("durably removes a restored row, and retains it if removal fails", async () => {
  const h = fixture();
  const id = h.enqueue();
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
  first.enqueue({ ...message, text: "Second" });
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
  first.enqueue({ ...message, text: "Second" });
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
  const later = first.enqueue({ ...message, text: "Later" });
  await admitted();
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
  await admitted();
  cleanup.push(first.queue.subscribe(() => {}));
  const second = fixture();
  const successor = second.enqueue({ ...message, text: "New successor" });
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
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
  await admitted();
  expect(restarted.send).not.toHaveBeenCalled();
  restarted.work("retained", "done", other);
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
});

it("lets the user remove an abandoned sending marker without trying Send first", async () => {
  const first = fixture();
  const id = first.enqueue();
  await admitted();
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
  await admitted();
  const restarted = fixture();
  restarted.choices(false, []);
  const guard = vi.fn();
  restarted.queue.sendNow(id, guard);
  // The chat lock surrounds the release, including its row-lock acquisition.
  await followUpStorage(scope).lockChat("chat", async () => {});
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
  await releasesSettled(scope);
  restarted.queue.remove(id);
  restarted.choices(true, [agent]);
  await followUpStorage(scope).lockChat("chat", async () => {});
  expect(restarted.queue.snapshot()).toEqual([]);
  expect(restarted.send).not.toHaveBeenCalled();
});

it("unlocks Remove in an already-open window after the sending window abandons its handoff", async () => {
  const first = fixture();
  const id = first.enqueue();
  await admitted();
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
  await admitted();
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
    await admitted();
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
      .mockImplementationOnce((_id, _recovery, consume) =>
        pending.then(() => {
          consume?.();
        }),
      );
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
    await admitted();
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
    await releasesSettled(scope);
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
    await admitted();
    await admitted();
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

it.each([
  "accepted",
  "failed",
  "storage-error",
  "storage-error-remove",
  "other-handoff",
  "claim-only",
  "newer-event",
  "newer-receipt",
])(
  "keeps Remove fenced after recovery failure until delivery or failed dismissal (%s)",
  async (mode) => {
    const failed = mode !== "accepted";
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
    await admitted();
    await admitted();
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
      const storage = followUpStorage(scope);
      if (mode === "other-handoff")
        storage.claim("chat", {
          id: "other-row",
          message: "other-event",
          recipients: [agent],
        });
      if (mode === "claim-only")
        storage.claim("chat", { id, recipients: [agent] });
      if (mode === "newer-event")
        storage.claim("chat", {
          id,
          message: "newer-event",
          recipients: [agent],
        });
      if (mode === "newer-receipt") {
        const receipt = h.owner.outbox.snapshot()[0];
        if (!receipt) throw new Error("Missing failed receipt");
        storage.retire("chat");
        Object.assign(h.session, {
          outbox: {
            ...h.owner.outbox,
            recovery: async () => ({
              ...receipt,
              event: { ...receipt.event, id: "f".repeat(64) },
            }),
          },
        });
      }
      const setItem = Storage.prototype.setItem;
      let rejectCleanup = mode.startsWith("storage-error");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key,
        value,
      ) {
        if (rejectCleanup && key.includes(`follow-up:${id}`))
          throw new Error("Cleanup disk failure");
        setItem.call(this, key, value);
      });
      await h.owner.outbox.dismiss(
        h.owner.outbox.snapshot()[0]?.event.id ?? "missing",
      );
      await followUpStorage(scope).lockChat("chat", async () => {});
      if (mode === "newer-receipt") {
        expect(storage.isSending(id)).toBe(true);
        expect(h.queue.snapshot()[0]).toMatchObject({
          sending: true,
          deliveryId: "f".repeat(64),
        });
        return;
      }
      if (mode === "newer-event") {
        expect(storage.isSending(id)).toBe(true);
        expect(h.queue.snapshot()[0]?.sending).toBe(true);
        expect(storage.handoff("chat")?.message).toBe("newer-event");
        return;
      }
      if (mode.startsWith("storage-error")) {
        expect(storage.isSending(id)).toBe(true);
        expect(h.queue.snapshot()[0]?.error).toBe(
          "Could not save queued message delivery. Try again.",
        );
        expect(h.queue.snapshot()[0]?.sending).toBe(false);
        await vi.waitFor(() =>
          expect(
            (
              screen.getByRole("button", {
                name: "Remove queued message",
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(false),
        );
        expect(
          screen.getByText(
            "Could not save queued message delivery. Try again.",
          ),
        ).not.toBeNull();
        window.dispatchEvent(new StorageEvent("storage"));
        await storage.lock(id, async () => {});
        expect(h.queue.snapshot()[0]?.sending).toBe(false);
        rejectCleanup = false;
        h.publish.mockResolvedValue(undefined);
        if (mode === "storage-error-remove") {
          h.enqueue({ ...message, text: "Successor" });
          await admitted();
          await admitted();
          h.finish();
          h.queue.remove(id);
        } else h.queue.sendNow(id);
        await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
        expect(h.send).toHaveBeenCalledTimes(2);
        return;
      }
      if (mode === "other-handoff")
        expect(storage.handoff("chat")).toMatchObject({
          id: "other-row",
          message: "other-event",
        });
      expect(
        (
          screen.getByRole("button", {
            name: "Remove queued message",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      expect(followUpStorage(scope).isSending(id)).toBe(false);
      window.dispatchEvent(new StorageEvent("storage"));
      await followUpStorage(scope).lock(id, async () => {});
      expect(h.queue.snapshot()[0]?.sending).toBe(false);
      h.publish.mockResolvedValue(undefined);
      h.queue.sendNow(id);
    } else h.queue.sendNow(id);
    await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
    expect(h.send).toHaveBeenCalledTimes(failed ? 2 : 1);
  },
);

it("abandoning a gated resumed reread pauses only its saved rows, not fresh submissions", async () => {
  const id = fixture().enqueue();
  await admitted();
  await admitted();
  await admitted();
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
  await admitted();
  await admitted();
  await admitted();
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

it.each(["together", "after handoff", "later row first"])(
  "coordinates distinct automatic rows with delayed storage notifications (%s)",
  async (order) => {
    const first = fixture();
    const firstId = first.enqueue({ ...message, text: "First" });
    await admitted();
    const savedFirst = followUpStorage(scope).load()[0];
    if (!savedFirst) throw new Error("Missing first row");
    // Model two windows reading before either sees the other's save. No storage
    // event is delivered; both records are durable before the turn completes.
    followUpStorage(scope).remove(firstId);
    const second = fixture();
    const secondId = second.enqueue({ ...message, text: "Second" });
    await admitted();
    followUpStorage(scope).save({
      ...savedFirst,
      createdAt: savedFirst.createdAt - 1,
    });
    expect(first.queue.snapshot().map((row) => row.id)).toEqual([firstId]);
    expect(second.queue.snapshot().map((row) => row.id)).toEqual([secondId]);
    if (order === "later row first") second.finish();
    first.finish();
    if (order === "after handoff")
      await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
    if (order !== "later row first") second.finish();
    await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
    await releasesSettled(scope);
    await followUpStorage(scope).lock(secondId, async () => {});
    expect(first.send).toHaveBeenCalledOnce();
    expect(second.send).not.toHaveBeenCalled();
    expect(followUpStorage(scope).has(secondId)).toBe(true);
    expect(second.queue.snapshot()[0]?.restored).toBe(true);
    second.queue.sendNow(secondId);
    await vi.waitFor(() => expect(second.queue.snapshot()).toEqual([]));
    expect(second.send).toHaveBeenCalledOnce();
  },
);

it("resumes the saved successor after restart during a handed-off turn", async () => {
  const first = fixture();
  first.enqueue({ ...message, text: "First" });
  await admitted();
  const secondId = first.enqueue({ ...message, text: "Second" });
  await admitted();
  first.finish();
  await vi.waitFor(() => expect(first.send).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(first.queue.snapshot().map((row) => row.id)).toEqual([secondId]),
  );
  const event = first.send.mock.results[0]?.value as string;
  first.owner.dispose();
  const restarted = fixture();
  restarted.finish();
  restarted.queue.resumeAfter(agent, { [event]: "chat" });
  restarted.work(event, "done");
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send.mock.calls[0]?.[1]).toBe("Second");
});

it("keeps completed handoffs from blocking a fresh queue after restart", async () => {
  const first = fixture();
  first.enqueue();
  first.finish();
  await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
  const event = first.send.mock.results[0]?.value as string;
  first.work(event, "done");
  await followUpStorage(scope).lockChat("chat", async () => {});
  expect(followUpStorage(scope).handoff("chat")?.complete).toBe(true);
  first.owner.dispose();
  const restarted = fixture();
  restarted.enqueue({ ...message, text: "New turn follow-up" });
  restarted.finish();
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send).toHaveBeenCalledOnce();
});

it("does not publish when the shared handoff claim cannot be saved", async () => {
  const h = fixture();
  const id = h.enqueue();
  const set = Storage.prototype.setItem;
  const failing = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.includes("follow-up-handoff:")) throw new Error("Disk full");
      set.call(this, key, value);
    });
  h.finish();
  await vi.waitFor(() =>
    expect(h.queue.snapshot()[0]?.error).toContain(
      "Could not save queued message ordering",
    ),
  );
  expect(h.send).not.toHaveBeenCalled();
  expect(followUpStorage(scope).has(id)).toBe(true);
  failing.mockRestore();
  h.queue.sendNow(id);
  await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
  expect(h.send).toHaveBeenCalledOnce();
});

it("repairs a failed event claim before recovering the receipt and restarting", async () => {
  const h = fixture();
  const id = h.enqueue({ ...message, text: "First" });
  h.enqueue({ ...message, text: "Second" });
  const set = Storage.prototype.setItem;
  const failing = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.includes("follow-up-handoff:") && JSON.parse(value).message)
        throw new Error("Event claim failed");
      set.call(this, key, value);
    });
  h.finish();
  await vi.waitFor(() =>
    expect(h.queue.snapshot()[0]?.error).toContain(
      "Could not save queued message ordering",
    ),
  );
  expect(h.send).toHaveBeenCalledOnce();
  failing.mockRestore();
  h.queue.sendNow(id);
  await vi.waitFor(() => expect(followUpStorage(scope).has(id)).toBe(false));
  const event = h.send.mock.results[0]?.value as string;
  expect(followUpStorage(scope).handoff("chat")?.message).toBe(event);
  h.owner.dispose();
  const restarted = fixture();
  restarted.finish();
  restarted.queue.resumeAfter(agent, { [event]: "chat" });
  restarted.work(event, "done");
  await vi.waitFor(() => expect(restarted.queue.snapshot()).toEqual([]));
  expect(restarted.send.mock.calls[0]?.[1]).toBe("Second");
});

it("settles a claim when publication fails synchronously before handoff", async () => {
  const h = fixture();
  const id = h.enqueue();
  h.send.mockImplementationOnce(() => {
    throw new Error("Publish unavailable");
  });
  h.finish();
  await vi.waitFor(() =>
    expect(h.queue.snapshot()[0]?.error).toBe("Publish unavailable"),
  );
  await followUpStorage(scope).lockChat("chat", async () => {});
  expect(followUpStorage(scope).handoff("chat")?.complete).toBe(true);
  h.queue.remove(id);
  await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
  const next = fixture();
  next.enqueue({ ...message, text: "Fresh" });
  next.finish();
  await vi.waitFor(() => expect(next.queue.snapshot()).toEqual([]));
  expect(next.send).toHaveBeenCalledOnce();
});

it("settles a newer completed handoff after an older completion write waits for its lock", async () => {
  const h = fixture();
  h.enqueue({ ...message, text: "First" });
  const next = h.enqueue({ ...message, text: "Second" });
  h.finish();
  await vi.waitFor(() =>
    expect(h.queue.snapshot().map((row) => row.id)).toEqual([next]),
  );
  const firstEvent = h.send.mock.results[0]?.value as string;
  const channel = await h.refresh();
  let releaseMembership!: () => void;
  const membership = new Promise<void>((resolve) => {
    releaseMembership = resolve;
  });
  h.refresh.mockImplementationOnce(async () => {
    await membership;
    return channel;
  });
  let releaseRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const recover = vi.fn(
    async (...args: Parameters<typeof h.owner.outbox.recover>) => {
      await h.owner.outbox.recover(...args);
      await recovery;
    },
  );
  Object.assign(h.session, { outbox: { ...h.owner.outbox, recover } });
  h.refresh.mockClear();
  try {
    h.queue.sendNow(next);
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
    h.work(firstEvent, "done");
    releaseMembership();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    const secondEvent = h.send.mock.results[1]?.value as string;
    h.work(secondEvent, "done");
  } finally {
    releaseMembership();
    releaseRecovery();
  }
  await vi.waitFor(() =>
    expect(followUpStorage(scope).handoff("chat")).toMatchObject({
      id: next,
      complete: true,
    }),
  );
});

it("removes a manual send while another row holds the chat lock", async () => {
  const h = fixture();
  const first = h.enqueue({ ...message, text: "First" });
  const second = h.enqueue({ ...message, text: "Second" });
  const channel = await h.refresh();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.refresh.mockImplementationOnce(async () => {
    await gate;
    return channel;
  });
  h.refresh.mockClear();
  const locks = vi.spyOn(navigator.locks, "request");
  // Recipient checks run before the chat lock, so model another row holding
  // it directly. The first row is still checking its recipients; the second
  // waits on the held lock.
  const held = followUpStorage(scope).lockChat("chat", () => gate);
  try {
    h.queue.sendNow(first);
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
    h.queue.sendNow(second);
    await vi.waitFor(() =>
      expect(
        locks.mock.calls.filter(([name]) =>
          name.startsWith("buzz-follow-up-chat:"),
        ),
      ).toHaveLength(2),
    );
    h.queue.remove(second);
    await vi.waitFor(() =>
      expect(followUpStorage(scope).has(second)).toBe(false),
    );
  } finally {
    release();
    await held;
    await releasesSettled(scope);
    await followUpStorage(scope).lock(second, async () => {});
  }
  await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.send.mock.calls[0]?.[1]).toBe("First");
});

it("renders the automatic predecessor pause without another store update", async () => {
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
  followUpStorage(scope).claim("chat", {
    id: "other-row",
    message: "other-message",
    recipients: [agent],
  });
  render(
    createElement(QueuedFollowUps, {
      session: h.session,
      channelId: "chat",
      disabled: false,
      focusComposer() {},
    }),
  );
  h.finish();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Another window may be handling an earlier queued message",
  );
  await followUpStorage(scope).lock(id, async () => {});
  expect(h.send).not.toHaveBeenCalled();
});

it("settles a resumed handoff without a saved successor before reopening", async () => {
  const event = "e".repeat(64);
  followUpStorage(scope).claim("chat", {
    id: "sent-row",
    message: event,
    recipients: [agent],
  });
  const h = fixture();
  // The old observer's replayed completion cannot finish the resumed request.
  h.observe(event);
  h.finish();
  h.queue.resumeAfter(agent, { [event]: "chat" });
  await Promise.resolve();
  await followUpStorage(scope).lockChat("chat", async () => {});
  expect(followUpStorage(scope).handoff("chat")?.complete).not.toBe(true);
  h.work(event, "done");
  await vi.waitFor(() =>
    expect(followUpStorage(scope).handoff("chat")?.complete).toBe(true),
  );
  h.owner.dispose();
  // A later session has no local or observer evidence for the old event.
  const reopened = fixture();
  reopened.enqueue({ ...message, text: "Fresh follow-up" });
  reopened.finish();
  await vi.waitFor(() => expect(reopened.queue.snapshot()).toEqual([]));
  expect(reopened.send).toHaveBeenCalledOnce();
});

it.each(["abandoned", "removed", "revoked"])(
  "retires resumed handoff tracking without a successor when %s",
  async (reason) => {
    const event = "e".repeat(64);
    followUpStorage(scope).claim("chat", {
      id: "sent-row",
      message: event,
      recipients: [agent],
    });
    const h = fixture();
    let removed!: (id: string) => void;
    Object.assign(h.session, {
      channelLifecycle: {
        observeRemoval(listener: (id: string) => void) {
          removed = listener;
          return () => {};
        },
      },
    });
    const deactivate = vi.fn();
    vi.spyOn(h.session.agentActivity, "activate").mockReturnValue(deactivate);
    h.finish();
    h.queue.resumeAfter(agent, { [event]: "chat" });
    await Promise.resolve();
    expect(deactivate).not.toHaveBeenCalled();
    if (reason === "abandoned") h.queue.pauseAfter(agent, { [event]: "chat" });
    else if (reason === "removed") removed("chat");
    else h.roster("ready", false);
    expect(deactivate).toHaveBeenCalledOnce();
    await followUpStorage(scope).lockChat("chat", async () => {});
    expect(followUpStorage(scope).handoff("chat")?.complete).not.toBe(true);
  },
);

it("keeps a restored mixed resume cohort paused when an unarmed request is abandoned", async () => {
  const other = "d".repeat(64);
  fixture().enqueue({ ...message, recipients: [agent, other] });
  await admitted();
  const h = fixture();
  h.choices(true, [agent, other]);
  h.finish();
  h.queue.resumeAfter(agent, { original: "chat" });
  h.queue.pauseAfter(other, { unsupported: "chat" });
  h.work("original", "done");
  await followUpStorage(scope).lockChat("chat", async () => {});
  expect(h.queue.snapshot()[0]?.restored).toBe(true);
  expect(h.send).not.toHaveBeenCalled();
});

it.each(["liveness", "owner"])(
  "keeps a restored mixed resume cohort paused when abandonment races the %s check",
  async (check) => {
    const other = "d".repeat(64);
    fixture().enqueue({ ...message, recipients: [agent, other] });
    const h = fixture();
    await h.owner.ready;
    h.choices(true, [agent, other]);
    h.refresh.mockResolvedValue({
      ...(await h.refresh()),
      members: [viewer, agent, other],
    });
    h.finish();
    const storage = followUpStorage(scope);
    storage.claim("chat", {
      id: "earlier-row",
      message: "earlier-request",
      recipients: [agent],
      owner: "closed-window",
    });
    let reached!: () => void;
    const checking = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (check === "liveness") {
      vi.spyOn(navigator.locks, "query").mockImplementation(async () => {
        reached();
        await gate;
        return { held: [], pending: [] };
      });
    } else {
      const request = navigator.locks.request.bind(navigator.locks);
      vi.spyOn(navigator.locks, "request").mockImplementation((...args) => {
        if (args[0].startsWith("buzz-follow-up-window:")) {
          reached();
          return gate.then(() => request(...args));
        }
        return request(...args);
      });
    }
    h.queue.resumeAfter(agent, { original: "chat" });
    h.work("original", "done");
    try {
      await checking;
      h.queue.pauseAfter(other, { unsupported: "chat" });
      expect(h.queue.snapshot()[0]?.restored).toBe(true);
    } finally {
      release();
      await storage.lockChat("chat", async () => {});
    }
    expect(h.queue.snapshot()[0]?.restored).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  },
);

it.each(["completion", "activity"])(
  "keeps a successor automatic when predecessor %s precedes removal",
  async (evidence) => {
    const first = fixture();
    const id = first.enqueue();
    const second = fixture();
    cleanup.push(second.queue.subscribe(() => {}));
    second.enqueue({ ...message, text: "Second" });
    // Hold the second window busy until it receives the removal notification.
    first.queue.sendNow(id);
    await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
    const event = first.send.mock.results[0]?.value as string;
    if (evidence === "completion") {
      first.work(event, "done");
      await followUpStorage(scope).lockChat("chat", async () => {});
    } else second.work(event, "done");
    window.dispatchEvent(new StorageEvent("storage"));
    expect(second.queue.snapshot()[0]?.restored).not.toBe(true);
    second.finish();
    await vi.waitFor(() => expect(second.send).toHaveBeenCalledOnce());
  },
);

it.each(["completion", "activity"])(
  "pauses successors when %s belongs to an older handoff",
  async (evidence) => {
    const first = fixture();
    const completed = first.enqueue({ ...message, text: "A" });
    await admitted();
    first.queue.sendNow(completed);
    await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
    const event = first.send.mock.results[0]?.value as string;
    if (evidence === "completion") {
      first.work(event, "done");
      await followUpStorage(scope).lockChat("chat", async () => {});
    }
    const observer = fixture();
    cleanup.push(observer.queue.subscribe(() => {}));
    if (evidence === "activity") observer.work(event, "done");
    const predecessor = observer.enqueue({ ...message, text: "B" });
    await admitted();
    const successor = observer.enqueue({ ...message, text: "C" });
    await admitted();
    const remover = fixture();
    remover.queue.remove(predecessor);
    await vi.waitFor(() =>
      expect(followUpStorage(scope).has(predecessor)).toBe(false),
    );
    window.dispatchEvent(new StorageEvent("storage"));
    expect(observer.queue.snapshot()).toMatchObject([
      { id: successor, restored: true, predecessorRemoved: true },
    ]);
    observer.finish();
    await followUpStorage(scope).lock(successor, async () => {});
    expect(observer.send).not.toHaveBeenCalled();
    observer.queue.sendNow(successor);
    await vi.waitFor(() => expect(observer.send).toHaveBeenCalledOnce());
  },
);

it("requires completion for every coalesced removed predecessor", async () => {
  const observer = fixture();
  cleanup.push(observer.queue.subscribe(() => {}));
  const unknown = observer.enqueue({ ...message, text: "B" });
  await admitted();
  await admitted();
  const completed = observer.enqueue({ ...message, text: "C" });
  await admitted();
  await admitted();
  const successor = observer.enqueue({ ...message, text: "D" });
  await admitted();
  await admitted();
  const storage = followUpStorage(scope);
  storage.claim("chat", { id: completed, recipients: [agent], complete: true });
  storage.remove(unknown);
  storage.remove(completed);
  window.dispatchEvent(new StorageEvent("storage"));
  expect(observer.queue.snapshot()).toMatchObject([
    { id: successor, restored: true, predecessorRemoved: true },
  ]);
  observer.finish();
  await storage.lock(successor, async () => {});
  expect(observer.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  "drains fresh rows after an interrupted handoff is abandoned (resumed: %s)",
  async (resumed) => {
    const event = "e".repeat(64);
    followUpStorage(scope).claim("chat", {
      id: "old",
      message: event,
      recipients: [agent],
    });
    const h = fixture();
    if (resumed) h.queue.resumeAfter(agent, { [event]: "chat" });
    h.queue.pauseAfter(agent, { [event]: "chat" });
    await followUpStorage(scope).lockChat("chat", async () => {});
    h.enqueue();
    h.finish();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
  },
);

it.each([false, true])(
  "does not let a closed window's incomplete handoff pause fresh rows (receipt retry: %s)",
  async (retry) => {
    const first = fixture();
    const id = first.enqueue();
    const set = Storage.prototype.setItem;
    const failing = retry
      ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
          this: Storage,
          key,
          value,
        ) {
          if (key.includes("follow-up-handoff:") && JSON.parse(value).message)
            throw new Error("Event claim failed");
          set.call(this, key, value);
        })
      : undefined;
    first.finish();
    if (failing) {
      await vi.waitFor(() =>
        expect(first.queue.snapshot()[0]?.error).toBeTruthy(),
      );
      failing.mockRestore();
      first.queue.sendNow(id);
    }
    await vi.waitFor(() => expect(first.queue.snapshot()).toEqual([]));
    first.owner.dispose();
    // A closed document releases its Web Locks, even after a crash.
    vi.spyOn(navigator.locks, "query").mockResolvedValue({
      held: [],
      pending: [],
    });
    const next = fixture();
    next.enqueue();
    next.finish();
    await vi.waitFor(() => expect(next.send).toHaveBeenCalledOnce());
  },
);

it("keeps cross-window Remove fenced by a receipt absent from the observer snapshot", async () => {
  const first = fixture();
  await first.owner.ready;
  const id = first.enqueue();
  const second = fixture();
  await second.owner.ready;
  cleanup.push(second.queue.subscribe(() => {}));
  let release!: () => void;
  first.holdSigning(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  first.save
    .mockImplementationOnce(async (value) => {
      journals.set(scope, structuredClone(value));
    })
    .mockRejectedValueOnce(new Error("Recovery disk failure"));
  try {
    first.queue.sendNow(id);
    await vi.waitFor(() =>
      expect(first.queue.snapshot()[0]?.error).toBe("Recovery disk failure"),
    );
    window.dispatchEvent(new StorageEvent("storage"));
    await followUpStorage(scope).lock(id, async () => {});
    expect(second.queue.snapshot()[0]?.sending).toBe(true);
    second.queue.remove(id);
    await followUpStorage(scope).lock(id, async () => {});
    expect(followUpStorage(scope).has(id)).toBe(true);
  } finally {
    release();
  }
  await vi.waitFor(() => expect(first.publish).toHaveBeenCalledOnce());
});

it.each([false, true])(
  "keeps another window behind a resumed handoff after original owner exits (partial abandonment: %s)",
  async (abandon) => {
    const other = "d".repeat(64);
    const event = "e".repeat(64);
    followUpStorage(scope).claim("chat", {
      id: "old",
      message: event,
      recipients: [agent, other],
      owner: "closed-window",
    });
    const recovering = fixture();
    recovering.queue.resumeAfter(agent, { [event]: "chat" });
    if (abandon) recovering.queue.pauseAfter(other, { [event]: "chat" });
    await followUpStorage(scope).lockChat("chat", async () => {});
    const next = fixture();
    next.enqueue();
    next.finish();
    await releasesSettled(scope);
    expect(next.send).not.toHaveBeenCalled();
    expect(next.queue.snapshot()[0]?.restored).toBe(true);
    expect(followUpStorage(scope).handoff("chat")?.recipients).toContain(agent);
    if (abandon) {
      recovering.work(event, "done");
      await followUpStorage(scope).lockChat("chat", async () => {});
      expect(followUpStorage(scope).handoff("chat")?.complete).toBe(true);
    }
  },
);

it.each(["send", "storage", "after-lookup"])(
  "revalidates a stale hydrated failed receipt after another window dismisses it (%s)",
  async (trigger) => {
    const first = fixture(scope, [], true);
    await first.owner.ready;
    const id = first.enqueue();
    await admitted();
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
    const dismissing = fixture(
      scope,
      [
        {
          event,
          signed: event,
          recovery: followUpRecovery(id),
          delivery: "failed",
        },
      ],
      true,
    );
    const stale = fixture(scope, [], true);
    cleanup.push(stale.queue.subscribe(() => {}));
    await Promise.all([dismissing.owner.ready, stale.owner.ready]);
    const old = stale.owner.outbox.snapshot()[0];
    if (!old) throw new Error("Missing failed receipt");
    await followUpStorage(scope).lock(id, async () => {});
    expect(stale.queue.snapshot()[0]?.deliveryId).toBe(old.event.id);
    if (trigger === "after-lookup") {
      let reached!: () => void;
      const adopting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(stale.session, {
        outbox: {
          ...stale.owner.outbox,
          recover: async (
            ...args: Parameters<typeof stale.owner.outbox.recover>
          ) => {
            reached();
            await gate;
            return stale.owner.outbox.recover(...args);
          },
        },
      });
      stale.queue.sendNow(id);
      await adopting;
      await dismissing.owner.outbox.dismiss(old.event.id);
      release();
      await followUpStorage(scope).lockChat("chat", async () => {});
      expect(followUpStorage(scope).has(id)).toBe(true);
      expect(stale.publish).not.toHaveBeenCalled();
      Object.assign(stale.session, { outbox: stale.owner.outbox });
    } else await dismissing.owner.outbox.dismiss(old.event.id);
    await followUpStorage(scope).lockChat("chat", async () => {});
    expect(journals.get(scope)).toEqual([]);
    expect(stale.owner.outbox.snapshot()[0]?.event.id).toBe(old.event.id);
    if (trigger === "storage") {
      window.dispatchEvent(new StorageEvent("storage"));
      await followUpStorage(scope).lock(id, async () => {});
      await vi.waitFor(() =>
        expect(stale.queue.snapshot()[0]?.deliveryId).toBeUndefined(),
      );
      expect(stale.queue.snapshot()[0]?.sending).toBe(false);
    }
    stale.queue.sendNow(id);
    await vi.waitFor(() => expect(stale.publish).toHaveBeenCalledOnce());
    expect(stale.send).toHaveBeenCalledOnce();
    expect(
      stale.owner.outbox
        .snapshot()
        .some((item) => item.event.id === old.event.id),
    ).toBe(false);
    await vi.waitFor(() => expect(stale.queue.snapshot()).toEqual([]));
    expect(followUpStorage(scope).has(id)).toBe(false);
    expect(
      journals
        .get(scope)
        ?.some(
          (item) =>
            item.event.content === message.text &&
            item.event.id !== old.event.id,
        ),
    ).toBe(true);
    if (trigger === "after-lookup") {
      const replacement = stale.send.mock.results[0]?.value as string;
      expect(replacement).not.toBe(old.event.id);
      stale.enqueue({ ...message, text: "Successor" });
      await admitted();
      stale.finish();
      stale.work(replacement, "done");
      await vi.waitFor(() => expect(stale.send).toHaveBeenCalledTimes(2));
      expect(stale.send.mock.calls[1]?.[1]).toBe("Successor");
      await vi.waitFor(() => expect(stale.queue.snapshot()).toEqual([]));
    }
  },
);

it("durably adopts a locally owned failed receipt after another window dismisses it", async () => {
  const h = fixture(scope, [], true);
  await h.owner.ready;
  const id = h.enqueue();
  await admitted();
  let release!: () => void;
  h.holdSigning(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  h.publish.mockRejectedValue(new PublishRejected("Refused"));
  h.save
    .mockImplementationOnce(async () => {})
    .mockRejectedValueOnce(new Error("Recovery disk failure"));
  h.queue.sendNow(id);
  try {
    await vi.waitFor(() =>
      expect(h.queue.snapshot()[0]?.error).toBe("Recovery disk failure"),
    );
  } finally {
    release();
  }
  await vi.waitFor(() =>
    expect(journals.get(scope)?.[0]?.delivery).toBe("failed"),
  );
  const receipt = h.owner.outbox.snapshot()[0];
  if (!receipt) throw new Error("Missing receipt");
  const peer = fixture(scope, [], true);
  await peer.owner.ready;
  await peer.owner.outbox.dismiss(receipt.event.id);
  expect(journals.get(scope)).toEqual([]);
  h.queue.sendNow(id);
  await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
  expect(followUpStorage(scope).has(id)).toBe(false);
  expect(journals.get(scope)?.[0]).toMatchObject({
    event: { id: receipt.event.id },
    recovery: followUpRecovery(id),
  });
  const reloaded = fixture(scope, [], true);
  await reloaded.owner.ready;
  expect(reloaded.owner.outbox.snapshot()[0]).toMatchObject({
    event: { id: receipt.event.id },
    recovery: followUpRecovery(id),
  });
  expect(h.send).toHaveBeenCalledOnce();
});

it("edits durable text in place and publishes that text from another window", async () => {
  const first = fixture();
  const id = first.enqueue(structuredClone(message));
  await admitted();
  const second = fixture();
  cleanup.push(second.queue.subscribe(() => {}));
  const before = followUpStorage(scope).load()[0];
  const edit = first.queue.edit(id);
  await edit.save("Updated queued request");
  expect(followUpStorage(scope).load()[0]).toEqual({
    ...before,
    text: "Updated queued request",
  });
  second.queue.sendNow(id);
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledOnce());
  expect(second.send.mock.calls[0]?.[1]).toBe("Updated queued request");
});

it("keeps the original text after cancelling and rejects a stale edit", async () => {
  const first = fixture();
  const id = first.enqueue(structuredClone(message));
  await admitted();
  const cancelled = first.queue.edit(id);
  cancelled.cancel();
  await expect(cancelled.save("Discarded")).rejects.toThrow(
    "no longer available",
  );
  expect(followUpStorage(scope).load()[0]?.text).toBe(message.text);
  const second = fixture();
  const edit = first.queue.edit(id);
  const otherEdit = second.queue.edit(id);
  await otherEdit.save("Other window edit");
  await expect(edit.save("My stale edit")).rejects.toThrow(
    "changed in another window",
  );
  expect(followUpStorage(scope).load()[0]?.text).toBe("Other window edit");
  edit.cancel();
});

it("does not resurrect a removed queued message when saving an edit", async () => {
  const h = fixture();
  const id = h.enqueue(structuredClone(message));
  await admitted();
  const edit = h.queue.edit(id);
  followUpStorage(scope).remove(id);
  await expect(edit.save("Keep my draft")).rejects.toThrow("sent or removed");
  expect(followUpStorage(scope).has(id)).toBe(false);
  edit.cancel();
});

it("keeps an edit open on blank text or storage failure", async () => {
  const h = fixture();
  const id = h.enqueue(structuredClone(message));
  await admitted();
  const edit = h.queue.edit(id);
  await expect(edit.save("  ")).rejects.toThrow("Enter a message");
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Disk full");
  });
  await expect(edit.save("Changed")).rejects.toThrow("Could not save");
  expect(h.queue.snapshot()[0]?.text).toBe(message.text);
  Storage.prototype.setItem = original;
  await edit.save("Changed");
  expect(h.queue.snapshot()[0]?.text).toBe("Changed");
});

it("holds automatic release while editing, then sends the saved text", async () => {
  const h = fixture();
  const id = h.enqueue(structuredClone(message));
  await admitted();
  const edit = h.queue.edit(id);
  h.finish();
  // Drain the same locks automatic release uses before asserting it was held.
  const storage = followUpStorage(scope);
  await storage.lockChat("chat", () => storage.lock(id, async () => {}));
  expect(h.send).not.toHaveBeenCalled();
  await edit.save("Saved before release");
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
  expect(h.send.mock.calls[0]?.[1]).toBe("Saved before release");
});

it("resolves queued agent mentions before publishing its snapshot with recovery", async () => {
  const h = fixture();
  const reference = {
    version: 1 as const,
    origin: "https://relay.example",
    channelId: "source",
    id: "c".repeat(64),
  };
  const saved = {
    ...message,
    forward: reference,
    id: "queued-forward",
    createdAt: 1,
  };
  followUpStorage(scope).save(saved);
  expect(followUpStorage(scope).load()[0]?.forward).toEqual(reference);
  const forward = vi
    .spyOn(h.session.messages, "forward")
    .mockReturnValue("forward-id");
  const row = {
    id: reference.id,
    channelId: "source",
    authorId: viewer,
    createdAt: 1,
    content: "Hello @Local Agent",
    mentions: [agent],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  Object.assign(h.session, {
    profiles: { snapshot: () => new Map() },
    agentLibrary: {
      snapshot: () => ({
        identities: [{ pubkey: agent, name: "Local Agent" }],
      }),
    },
    thread: () => ({
      snapshot: () => ({
        status: "ready",
        targetStatus: "ready",
        target: row,
        replies: [],
        canLoadMore: false,
      }),
      subscribe: () => () => {},
      refresh: async () => {},
      dispose() {},
    }),
  });
  vi.spyOn(h.session.messages, "forwardProblem").mockReturnValue(undefined);
  const entry = followUpMessage(h.session, saved);
  await entry.beforeRelease();
  const recovery = followUpRecovery(saved.id);
  expect(entry.publish(recovery)).toBe("forward-id");
  expect(forward).toHaveBeenCalledWith(
    "chat",
    { ...row, mentionLabels: [{ id: agent, names: ["Local Agent"] }] },
    viewer.slice(0, 10),
    message.text,
    recovery,
    {
      mentions: message.recipients,
      attachments: [],
      references: [],
      picks: message.picks,
    },
  );
  expect(h.send).not.toHaveBeenCalled();
});

it("allows clearing a queued forward note and labels the remaining content", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const h = fixture();
  const forward = {
    version: 1 as const,
    origin: "https://relay.example",
    channelId: "source",
    id: "c".repeat(64),
  };
  const id = h.enqueue({ ...structuredClone(message), forward });
  await admitted();
  await h.queue.edit(id).save("");
  expect(followUpStorage(scope).load()[0]).toMatchObject({ text: "", forward });
  render(
    createElement(QueuedFollowUps, {
      session: h.session,
      channelId: "chat",
      disabled: false,
      focusComposer() {},
    }),
  );
  expect(screen.getAllByText("Forwarded message").length).toBeGreaterThan(0);
});

const dmMessage: FollowUpMessage = {
  channelId: "chat",
  text: "Use the other repo",
  recipients: [],
  dmAgent: agent,
  attachments: [],
  references: [],
  picks: {},
};

it("releases an untagged DM row to the owner's agent with an immediate send's tags", async () => {
  const h = fixture(scope, [], false, true);
  await h.owner.ready;
  const id = h.enqueue(dmMessage);
  await admitted();
  expect(h.queue.snapshot()[0]?.recipients).toEqual([agent]);
  expect(h.send).not.toHaveBeenCalled();
  h.finish();
  await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
  expect(h.send).toHaveBeenCalledWith(
    "chat",
    "Use the other repo",
    [agent],
    [],
    followUpRecovery(id),
    [],
    {},
  );
  h.session.messages.send("chat", "Use the other repo", [], []);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  // Each event has its own client ID and timing; every other tag matches.
  const [queued, immediate] = (
    h.publish.mock.calls as unknown as [{ tags: string[][] }][]
  ).map(([event]) =>
    event.tags.filter(([name]) => name !== "client-id" && name !== "ms"),
  );
  expect(queued).toContainEqual(["p", agent]);
  expect(queued).toEqual(immediate);
});

it("restores a DM row with its agent and sends it on Send now", async () => {
  const first = fixture(scope, [], false, true);
  first.enqueue(dmMessage);
  await admitted();
  const restored = fixture(scope, [], false, true);
  await restored.owner.ready;
  const [row] = restored.queue.snapshot();
  expect(row?.recipients).toEqual([agent]);
  expect(row?.message?.dmAgent).toBe(agent);
  restored.finish();
  expect(restored.send).not.toHaveBeenCalled();
  restored.queue.sendNow(row?.id ?? "missing");
  await vi.waitFor(() => expect(restored.queue.snapshot()).toEqual([]));
  expect(restored.send).toHaveBeenCalledWith(
    "chat",
    "Use the other repo",
    [agent],
    [],
    followUpRecovery(row?.id ?? "missing"),
    [],
    {},
  );
});

it.each([
  [
    "someone joins the DM",
    (h: ReturnType<typeof fixture>) =>
      h.members([viewer, agent, "c".repeat(64)]),
    "This DM's members changed",
  ],
  [
    "the agent becomes another owner's",
    (h: ReturnType<typeof fixture>) => h.ownership({ managed: false }),
    "no longer available",
  ],
  [
    "the agent is archived or deleting",
    (h: ReturnType<typeof fixture>) => h.ownership(null),
    "no longer available",
  ],
] as const)(
  "keeps a DM row queued with an error when %s",
  async (_label, change, error) => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue(dmMessage);
    change(h);
    h.finish();
    await vi.waitFor(() =>
      expect(h.queue.snapshot()[0]?.error).toContain(error),
    );
    expect(h.send).not.toHaveBeenCalled();
    expect(followUpStorage(scope).load()).toHaveLength(1);
  },
);

it("refuses a DM row whose saved recipients are empty", async () => {
  const h = fixture(scope, [], false, true);
  await h.owner.ready;
  const { dmAgent: _, ...untargeted } = dmMessage;
  h.enqueue(untargeted);
  h.finish();
  await vi.waitFor(() => expect(h.queue.snapshot()[0]?.error).toBeTruthy());
  expect(h.send).not.toHaveBeenCalled();
});

it("holds at most 20 rows in a DM queue", async () => {
  const h = fixture(scope, [], false, true);
  for (let index = 0; index < 20; index++)
    h.enqueue({ ...dmMessage, text: `Row ${index}` });
  expect(() => h.enqueue(dmMessage)).toThrow(
    "Queue is full: remove one or send now.",
  );
  expect(h.queue.snapshot()).toHaveLength(20);
});

describe("Stop pauses the queue", () => {
  it("holds automatic release until Resume queue, then releases in order", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue({ ...dmMessage, text: "First" });
    h.enqueue({ ...dmMessage, text: "Second" });
    await h.queue.pause("chat");
    expect(h.queue.pauses().get("chat")).toEqual({});
    expect(savedPause(scope, "chat")).toBe(true);
    h.finish();
    await Promise.resolve();
    expect(h.send).not.toHaveBeenCalled();
    await h.queue.resume("chat");
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]?.[1]).toBe("First");
    const firstId = h.send.mock.results[0]?.value as string;
    h.work(firstId, "working");
    h.work(firstId, "done");
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.send.mock.calls[1]?.[1]).toBe("Second");
    expect(savedPause(scope, "chat")).toBe(false);
  });

  it("sends only the chosen row on Send now and keeps the chat paused", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue({ ...dmMessage, text: "First" });
    const second = h.enqueue({ ...dmMessage, text: "Correction" });
    await h.queue.pause("chat");
    h.finish();
    h.queue.sendNow(second);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]?.[1]).toBe("Correction");
    const id = h.send.mock.results[0]?.value as string;
    h.work(id, "working");
    h.work(id, "done");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.queue.pauses().has("chat")).toBe(true);
    expect(h.queue.snapshot().map((row) => row.text)).toEqual(["First"]);
  });

  it("keeps the in-memory pause and reports separately when it cannot be saved", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue(dmMessage);
    const request = navigator.locks.request.bind(navigator.locks);
    vi.spyOn(navigator.locks, "request").mockImplementation(((
      name: string,
      ...rest: unknown[]
    ) =>
      name.startsWith("buzz-follow-up-chat:")
        ? Promise.reject(new Error("Locks unavailable"))
        : (request as (...args: unknown[]) => Promise<unknown>)(
            name,
            ...rest,
          )) as typeof navigator.locks.request);
    await expect(h.queue.pause("chat")).rejects.toThrow("Locks unavailable");
    expect(h.queue.pauses().get("chat")?.saveError).toBe(
      "Queue paused in this window only. Couldn’t save the pause, so other windows or a restart may not keep it.",
    );
    h.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.send).not.toHaveBeenCalled();
  });

  it("keeps a saved pause across restart, even when interrupted turns resume", async () => {
    const first = fixture(scope, [], false, true);
    await first.owner.ready;
    first.enqueue(dmMessage);
    await admitted();
    await first.queue.pause("chat");
    const restored = fixture(scope, [], false, true);
    await restored.owner.ready;
    expect(restored.queue.pauses().has("chat")).toBe(true);
    restored.queue.resumeAfter(agent, { previous: "chat" });
    restored.work("previous", "done");
    restored.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restored.send).not.toHaveBeenCalled();
    await restored.queue.resume("chat");
    await vi.waitFor(() => expect(restored.send).toHaveBeenCalledOnce());
  });

  it("reports a row already being sent at Stop as one that may still go out", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    const gate = deferredVoid();
    h.enqueue({ ...dmMessage, text: "First" });
    h.enqueue({ ...dmMessage, text: "Second" });
    // Hold the Outbox journal save: the first row is past its final check.
    const save = h.save.getMockImplementation();
    h.save.mockImplementation(async (...args) => {
      await gate.promise;
      return save?.(...args);
    });
    h.finish();
    await vi.waitFor(() => expect(h.queue.snapshot()[0]?.sending).toBe(true));
    void h.queue.pause("chat");
    expect(h.queue.pauses().get("chat")).toEqual({ sentBeforeStop: true });
    gate.resolve();
    await vi.waitFor(() =>
      expect(h.queue.snapshot().map((row) => row.text)).toEqual(["Second"]),
    );
    const id = h.send.mock.results[0]?.value as string;
    h.work(id, "working");
    h.work(id, "done");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.send).toHaveBeenCalledOnce();
  });

  it("queues a new message while paused rows wait, and sends at once after they leave", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    const first = h.enqueue({ ...dmMessage, text: "First" });
    await h.queue.pause("chat");
    h.finish();
    // The agent is idle, but the paused row still waits, so a new message joins it.
    const next = h.enqueue({ ...dmMessage, text: "Next" }, true);
    await Promise.resolve();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queue.snapshot().map((row) => row.text)).toEqual([
      "First",
      "Next",
    ]);
    h.queue.remove(first);
    h.queue.remove(next);
    await vi.waitFor(() => expect(h.queue.pauses().size).toBe(0));
    // With nothing left to protect, a correction sends at once.
    h.enqueue({ ...dmMessage, text: "Correction" }, true);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]?.[1]).toBe("Correction");
    expect(h.queue.snapshot()).toEqual([]);
  });

  it("does nothing without queued rows and clears once the queue empties", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    await h.queue.pause("chat");
    expect(h.queue.pauses().size).toBe(0);
    const only = h.enqueue(dmMessage);
    await h.queue.pause("chat");
    h.queue.sendNow(only);
    await vi.waitFor(() => expect(h.queue.snapshot()).toEqual([]));
    await vi.waitFor(() => expect(h.queue.pauses().size).toBe(0));
    await vi.waitFor(() => expect(savedPause(scope, "chat")).toBe(false));
  });
});

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Stop pause across windows and restarts", () => {
  it("keeps each successor held after overriding an unresolved handoff for one row", async () => {
    const storage = followUpStorage(scope);
    storage.save({ ...dmMessage, id: "second", createdAt: 2 });
    storage.save({ ...dmMessage, id: "third", createdAt: 3 });
    storage.claim("chat", {
      id: "first",
      message: "f".repeat(64),
      recipients: [agent],
      owner: "buzz-follow-up-window:closed",
    });
    writeSavedPause(scope, "chat");
    const restarted = fixture(scope, [], true, true);
    await restarted.owner.ready;
    restarted.finish();
    await restarted.queue.resume("chat");
    await storage.lockChat("chat", async () => {});
    expect(restarted.queue.snapshot()[0]?.error).toContain(
      "earlier queued message",
    );
    expect(restarted.send).not.toHaveBeenCalled();

    restarted.queue.sendNow("second");
    await vi.waitFor(() =>
      expect(restarted.queue.snapshot().map((row) => row.id)).toEqual([
        "third",
      ]),
    );
    const sent = restarted.send.mock.results[0]?.value as string;
    restarted.work(sent, "done");
    await storage.lockChat("chat", async () => {});
    expect(restarted.send).toHaveBeenCalledOnce();
    expect(storage.has("third")).toBe(true);
  });

  it("saves the hold on later rows when Send now goes first, across another restart", async () => {
    const storage = followUpStorage(scope);
    storage.save({ ...dmMessage, id: "second", createdAt: 2 });
    storage.save({ ...dmMessage, id: "third", createdAt: 3 });
    storage.claim("chat", {
      id: "first",
      message: "f".repeat(64),
      recipients: [agent],
      owner: "buzz-follow-up-window:closed",
    });
    const restarted = fixture(scope, [], true, true);
    await restarted.owner.ready;
    restarted.finish();
    // Send now before Resume queue still replaces the unresolved hand-off.
    restarted.queue.sendNow("second");
    await vi.waitFor(() =>
      expect(restarted.queue.snapshot().map((row) => row.id)).toEqual([
        "third",
      ]),
    );
    expect(storage.held("third")).toBe(true);
    const sent = restarted.send.mock.results[0]?.value as string;
    restarted.work(sent, "done");
    await restarted.queue.resume("chat");
    await storage.lockChat("chat", async () => {});
    expect(restarted.send).toHaveBeenCalledOnce();

    const again = fixture(scope, [], true, true);
    await again.owner.ready;
    again.finish();
    expect(again.queue.snapshot()[0]?.error).toContain(
      "earlier queued message",
    );
    again.queue.resumeAfter(agent, { [sent]: "chat" });
    await again.queue.resume("chat");
    await storage.lockChat("chat", async () => {});
    expect(again.send).not.toHaveBeenCalled();
    again.queue.sendNow("third");
    await vi.waitFor(() => expect(again.send).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(storage.held("third")).toBe(false));
  });

  it("persists Stop when another window queued after this window stopped observing", async () => {
    const stopping = fixture(scope, [], true, true);
    const producing = fixture(scope, [], true, true);
    await Promise.all([stopping.owner.ready, producing.owner.ready]);
    producing.enqueue(dmMessage);
    await admitted();
    expect(stopping.queue.snapshot()).toEqual([]);
    await stopping.queue.pause("chat");
    producing.finish();
    await followUpStorage(scope).lockChat("chat", async () => {});
    expect(producing.send).not.toHaveBeenCalled();
    expect(savedPause(scope, "chat")).toBe(true);
  });

  it("keeps the saved pause if another window still has a waiting row", async () => {
    const first = fixture(scope, [], true, true);
    await first.owner.ready;
    const id = first.enqueue(dmMessage);
    await first.queue.pause("chat");
    const second = fixture(scope, [], true, true);
    await second.owner.ready;
    const remaining = second.enqueue({ ...dmMessage, text: "Still paused" });
    expect(first.queue.snapshot().map((row) => row.id)).toEqual([id]);
    first.queue.remove(id);
    await vi.waitFor(() => expect(followUpStorage(scope).has(id)).toBe(false));
    await followUpStorage(scope).lockChat("chat", async () => {});
    expect(followUpStorage(scope).has(remaining)).toBe(true);
    expect(savedPause(scope, "chat")).toBe(true);
  });

  it("keeps a restored successor held when the former owner's handoff is unresolved", async () => {
    const storage = followUpStorage(scope);
    storage.save({ ...dmMessage, id: "successor", createdAt: 2 });
    storage.claim("chat", {
      id: "first",
      message: "f".repeat(64),
      recipients: [agent],
      owner: "buzz-follow-up-window:closed",
    });
    writeSavedPause(scope, "chat");
    const restarted = fixture(scope, [], true, true);
    await restarted.owner.ready;
    restarted.finish();
    await restarted.queue.resume("chat");
    await storage.lockChat("chat", async () => {});
    expect(restarted.send).not.toHaveBeenCalled();
    expect(storage.has("successor")).toBe(true);
  });
});

describe("Stop pause review round", () => {
  it("keeps another window's next row paused after a row it was already sending at Stop", async () => {
    const sending = fixture(scope, [], true, true);
    await sending.owner.ready;
    sending.enqueue({ ...dmMessage, text: "First" });
    sending.enqueue({ ...dmMessage, text: "Second" });
    const stopping = fixture(scope, [], true, true);
    await stopping.owner.ready;
    const gate = deferredVoid();
    const save = sending.save.getMockImplementation();
    sending.save.mockImplementation(async (...args) => {
      await gate.promise;
      return save?.(...args);
    });
    sending.finish();
    await vi.waitFor(() =>
      expect(sending.queue.snapshot()[0]?.sending).toBe(true),
    );
    // Accepted race (design §6): that row may still go out. The rows after
    // it must see the saved pause.
    const stopped = stopping.queue.pause("chat");
    gate.resolve();
    await stopped;
    expect(savedPause(scope, "chat")).toBe(true);
    const id = sending.send.mock.results[0]?.value as string;
    sending.work(id, "working");
    sending.work(id, "done");
    await followUpStorage(scope).lockChat("chat", async () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sending.send).toHaveBeenCalledOnce();
    expect(
      followUpStorage(scope)
        .load()
        .map((row) => row.text),
    ).toEqual(["Second"]);
  });

  it("sees another window's row mid-handoff at Stop", async () => {
    const sending = fixture(scope, [], true, true);
    await sending.owner.ready;
    sending.enqueue({ ...dmMessage, text: "First" });
    sending.enqueue({ ...dmMessage, text: "Second" });
    const stopping = fixture(scope, [], true, true);
    await stopping.owner.ready;
    const gate = deferredVoid();
    const save = sending.save.getMockImplementation();
    sending.save.mockImplementation(async (...args) => {
      await gate.promise;
      return save?.(...args);
    });
    sending.finish();
    await vi.waitFor(() =>
      expect(sending.queue.snapshot()[0]?.sending).toBe(true),
    );
    const stopped = stopping.queue.pause("chat");
    expect(stopping.queue.pauses().get("chat")).toEqual({
      sentBeforeStop: true,
    });
    gate.resolve();
    await stopped;
    expect(stopping.queue.pauses().get("chat")).toEqual({
      sentBeforeStop: true,
    });
  });

  it("holds another window's row still checking its recipients when Stop is pressed", async () => {
    const sending = fixture(scope, [], true, true);
    await sending.owner.ready;
    sending.enqueue({ ...dmMessage, text: "First" });
    sending.enqueue({ ...dmMessage, text: "Second" });
    const stopping = fixture(scope, [], true, true);
    await stopping.owner.ready;
    const gate = deferredVoid();
    const refresh = sending.refresh.getMockImplementation();
    sending.refresh.mockImplementationOnce(async () => {
      await gate.promise;
      return refresh?.() as ReturnType<NonNullable<typeof refresh>>;
    });
    sending.finish();
    // The other window is still checking its first row's recipients.
    await vi.waitFor(() => expect(sending.refresh).toHaveBeenCalled());
    const stopped = stopping.queue.pause("chat");
    expect(stopping.queue.pauses().get("chat")).toEqual({});
    gate.resolve();
    await stopped;
    await releasesSettled(scope);
    // Design §6 accepts only a row already past those checks.
    expect(sending.send).not.toHaveBeenCalled();
    expect(sending.queue.pauses().has("chat")).toBe(true);
    expect(stopping.queue.pauses().get("chat")).toEqual({});
    expect(followUpStorage(scope).load()).toHaveLength(2);
  });

  it("puts a Send now still short of its handoff back in the paused queue at Stop", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue({ ...dmMessage, text: "First" });
    const second = h.enqueue({ ...dmMessage, text: "Correction" });
    const gate = deferredVoid();
    const refresh = h.refresh.getMockImplementation();
    h.refresh.mockImplementationOnce(async () => {
      await gate.promise;
      return refresh?.() as ReturnType<NonNullable<typeof refresh>>;
    });
    h.queue.sendNow(second);
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalled());
    void h.queue.pause("chat");
    expect(h.queue.pauses().get("chat")).toEqual({});
    gate.resolve();
    await followUpStorage(scope).lockChat("chat", async () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queue.snapshot().map((row) => row.text)).toEqual([
      "First",
      "Correction",
    ]);
    expect(h.queue.pauses().get("chat")).toEqual({});
    // A Send now after Stop still sends that one row.
    h.queue.sendNow(second);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]?.[1]).toBe("Correction");
    expect(h.queue.pauses().has("chat")).toBe(true);
  });

  it("waits on the DM's agent, never the owner, when the owner mentions themselves", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue({ ...dmMessage, recipients: [viewer], text: "Note to self" });
    await admitted();
    h.enqueue({ ...dmMessage, text: "Next" });
    await admitted();
    expect(h.queue.snapshot()[0]?.recipients).toEqual([agent]);
    const restored = fixture(scope, [], false, true);
    expect(restored.queue.snapshot()[0]?.recipients).toEqual([agent]);
    h.finish();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    const id = h.send.mock.results[0]?.value as string;
    h.work(id, "working");
    h.work(id, "done");
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.send.mock.calls[1]?.[1]).toBe("Next");
  });

  it("resumes in a window with no composer mounted when another window resumes", async () => {
    // The resuming window never heard of the row, so only this one can send it.
    const other = fixture(scope, [], true, true);
    await other.owner.ready;
    const kept = fixture(scope, [], true, true);
    await kept.owner.ready;
    kept.enqueue(dmMessage);
    const unsubscribe = kept.queue.subscribe(() => {});
    await kept.queue.pause("chat");
    // Every composer unmounts.
    unsubscribe();
    await other.queue.resume("chat");
    expect(savedPause(scope, "chat")).toBe(false);
    window.dispatchEvent(new StorageEvent("storage"));
    expect(kept.queue.pauses().has("chat")).toBe(false);
    kept.finish();
    await vi.waitFor(() => expect(kept.send).toHaveBeenCalledOnce());
  });

  it("keeps a Resume it couldn't save in this window and says so", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue(dmMessage);
    await h.queue.pause("chat");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(
      createElement(QueuedFollowUps, {
        session: h.session,
        channelId: "chat",
        disabled: false,
        focusComposer() {},
      }),
    );
    const request = navigator.locks.request.bind(navigator.locks);
    const failing = vi
      .spyOn(navigator.locks, "request")
      .mockImplementation(((name: string, ...rest: unknown[]) =>
        name.startsWith("buzz-follow-up-chat:")
          ? Promise.reject(new Error("Locks unavailable"))
          : (request as (...args: unknown[]) => Promise<unknown>)(
              name,
              ...rest,
            )) as typeof navigator.locks.request);
    fireEvent.click(screen.getByRole("button", { name: "Resume queue" }));
    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "Queue resumed in this window only. Couldn’t save that, so other windows or a restart may keep it paused.",
        ),
      ).toBeTruthy(),
    );
    expect(savedPause(scope, "chat")).toBe(true);
    failing.mockRestore();
    h.finish();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.queue.pauses().has("chat")).toBe(false);
    expect(screen.queryByText(/paused after Stop/)).toBeNull();
  });

  it("honours another window's later Stop after a Resume this window couldn't save", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue(dmMessage);
    await h.queue.pause("chat");
    const request = navigator.locks.request.bind(navigator.locks);
    const failing = vi
      .spyOn(navigator.locks, "request")
      .mockImplementation(((name: string, ...rest: unknown[]) =>
        name.startsWith("buzz-follow-up-chat:")
          ? Promise.reject(new Error("Locks unavailable"))
          : (request as (...args: unknown[]) => Promise<unknown>)(
              name,
              ...rest,
            )) as typeof navigator.locks.request);
    await expect(h.queue.resume("chat")).rejects.toThrow("Locks unavailable");
    failing.mockRestore();
    expect(h.queue.pauses().has("chat")).toBe(false);
    // Another window presses Stop, and its storage event reaches this window.
    const other = fixture(scope, [], false, true);
    await other.owner.ready;
    await other.queue.pause("chat");
    window.dispatchEvent(pauseStorageEvent(scope));
    expect(h.queue.pauses().has("chat")).toBe(true);
    h.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.send).not.toHaveBeenCalled();
  });
  const failChatLocks = () => {
    const request = navigator.locks.request.bind(navigator.locks);
    return vi
      .spyOn(navigator.locks, "request")
      .mockImplementation(((name: string, ...rest: unknown[]) =>
        name.startsWith("buzz-follow-up-chat:")
          ? Promise.reject(new Error("Locks unavailable"))
          : (request as (...args: unknown[]) => Promise<unknown>)(
              name,
              ...rest,
            )) as typeof navigator.locks.request);
  };

  it("holds automatic release after a failed Resume when another window's later Stop has no storage event yet", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue(dmMessage);
    await h.queue.pause("chat");
    const failing = failChatLocks();
    await expect(h.queue.resume("chat")).rejects.toThrow("Locks unavailable");
    failing.mockRestore();
    expect(h.queue.pauses().has("chat")).toBe(false);
    // Another window stops; its storage event never reaches this window.
    const other = fixture(scope, [], false, true);
    await other.owner.ready;
    await other.queue.pause("chat");
    h.finish();
    await releasesSettled(scope);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queue.pauses().has("chat")).toBe(true);
    expect(h.queue.notices().get("chat")).toBeUndefined();
  });

  it("keeps a failed Resume through another window's ordinary enqueue", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue({ ...dmMessage, text: "First" });
    await h.queue.pause("chat");
    const failing = failChatLocks();
    await expect(h.queue.resume("chat")).rejects.toThrow("Locks unavailable");
    failing.mockRestore();
    const other = fixture(scope, [], false, true);
    await other.owner.ready;
    other.enqueue({ ...dmMessage, text: "Other" });
    await releasesSettled(scope);
    window.dispatchEvent(new StorageEvent("storage"));
    h.finish();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]?.[1]).toBe("First");
  });

  it("drops an earlier Send now after another window's Stop and Resume, and keeps queue order", async () => {
    const a = fixture(scope, [], false, true);
    await a.owner.ready;
    a.enqueue({ ...dmMessage, text: "First" });
    const correction = a.enqueue({ ...dmMessage, text: "Correction" });
    const b = fixture(scope, [], false, true);
    await b.owner.ready;
    const gate = deferredVoid();
    const refresh = a.refresh.getMockImplementation();
    a.refresh.mockImplementationOnce(async () => {
      await gate.promise;
      return refresh?.() as ReturnType<NonNullable<typeof refresh>>;
    });
    a.queue.sendNow(correction);
    await vi.waitFor(() => expect(a.refresh).toHaveBeenCalled());
    // Both save before A's handoff takes the chat lock.
    const stopped = b.queue.pause("chat");
    const resumed = b.queue.resume("chat");
    gate.resolve();
    await Promise.all([stopped, resumed]);
    await releasesSettled(scope);
    // The agent is still busy: nothing jumps the queue.
    expect(a.send).not.toHaveBeenCalled();
    expect(
      followUpStorage(scope)
        .load()
        .map((row) => row.text),
    ).toEqual(["First", "Correction"]);
    window.dispatchEvent(new StorageEvent("storage"));
    a.finish();
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledOnce());
    expect(a.send.mock.calls[0]?.[1]).toBe("First");
  });

  it("sends a Send now clicked after another window's saved Stop and keeps the rest paused", async () => {
    const a = fixture(scope, [], false, true);
    await a.owner.ready;
    a.enqueue({ ...dmMessage, text: "First" });
    const correction = a.enqueue({ ...dmMessage, text: "Correction" });
    const b = fixture(scope, [], false, true);
    await b.owner.ready;
    await b.queue.pause("chat");
    a.queue.sendNow(correction);
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledOnce());
    expect(a.send.mock.calls[0]?.[1]).toBe("Correction");
    expect(savedPause(scope, "chat")).toBe(true);
    expect(
      followUpStorage(scope)
        .load()
        .map((row) => row.text),
    ).toEqual(["First"]);
  });

  it("re-reads a row's saved text under the lock after its recipient checks", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    const id = h.enqueue({ ...dmMessage, text: "Draft" });
    const gate = deferredVoid();
    const refresh = h.refresh.getMockImplementation();
    h.refresh.mockImplementationOnce(async () => {
      await gate.promise;
      return refresh?.() as ReturnType<NonNullable<typeof refresh>>;
    });
    h.queue.sendNow(id);
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalled());
    // Another window saves an edit while this one checks recipients.
    const storage = followUpStorage(scope);
    const saved = storage.load()[0];
    if (!saved) throw new Error("Missing row");
    storage.save({ ...saved, text: "Edited" });
    gate.resolve();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]?.[1]).toBe("Edited");
  });

  it.each([
    ["the new row", "enqueue", true],
    ["the new row", "enqueue and Stop", true],
    ["the queue emptying", "enqueue", false],
    ["the queue emptying", "enqueue and Stop", true],
  ] as const)(
    "orders a new row and the queue emptying in another window by the chat lock: %s first (%s)",
    async (winner, race, held) => {
      const storage = followUpStorage(scope);
      // B opens before A queues, so only its own row and the saved record
      // tell it about the pause.
      const b = fixture(scope, [], false, true);
      await b.owner.ready;
      const a = fixture(scope, [], false, true);
      await a.owner.ready;
      const only = a.enqueue({ ...dmMessage, text: "Only" });
      await admitted();
      await a.queue.pause("chat");
      const gate = deferredVoid();
      const busy = storage.lockChat("chat", () => gate.promise);
      const empty = async () => {
        // A's last row leaves; its cleanup waits for the chat lock.
        void a.queue.remove(only);
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      if (winner === "the queue emptying") await empty();
      b.enqueue({ ...dmMessage, text: "New" });
      if (race === "enqueue and Stop") void b.queue.pause("chat");
      if (winner === "the new row") await empty();
      gate.resolve();
      await busy;
      await admitted();
      await releasesSettled(scope);
      b.finish();
      await releasesSettled(scope);
      expect(a.queue.snapshot()).toEqual([]);
      if (held) {
        expect(b.send).not.toHaveBeenCalled();
        expect(b.queue.pauses().has("chat")).toBe(true);
        expect(savedPause(scope, "chat")).toBe(true);
      } else {
        // The emptied queue ended the pause before the row read it.
        await vi.waitFor(() => expect(b.send).toHaveBeenCalledOnce());
        expect(storage.pauseState("chat")).toMatchObject({
          paused: false,
          generation: 1,
        });
      }
    },
  );

  it("refuses to edit a new row until its save takes the chat lock", async () => {
    const h = fixture(scope, [], true, true);
    await h.owner.ready;
    const gate = deferredVoid();
    const busy = followUpStorage(scope).lockChat("chat", () => gate.promise);
    const id = h.enqueue({ ...dmMessage, text: "New" });
    expect(() => h.queue.edit(id)).toThrow(
      "This message is still being queued. Try again.",
    );
    gate.resolve();
    await busy;
    await admitted();
    const lease = h.queue.edit(id);
    await lease.save("Edited");
    expect(followUpStorage(scope).load()[0]?.text).toBe("Edited");
  });

  it("warns about a message sent past Stop only when its handoff recorded one", async () => {
    const stopping = fixture(scope, [], true, true);
    await stopping.owner.ready;
    stopping.enqueue(dmMessage);
    await admitted();
    const storage = followUpStorage(scope);
    for (const message of [undefined, "f".repeat(64)]) {
      const held = deferredVoid();
      const busy = storage.lockChat("chat", () => held.promise);
      const stopped = stopping.queue.pause("chat");
      // Another window claims a row under the lock; its publish either threw
      // before recording a message, or recorded one.
      storage.claim("chat", {
        id: `other-${message ? "sent" : "claim"}`,
        recipients: [agent],
        owner: "buzz-follow-up-window:other",
        ...(message ? { message } : {}),
      });
      held.resolve();
      await busy;
      await stopped;
      expect(stopping.queue.pauses().get("chat")).toEqual(
        message ? { sentBeforeStop: true } : {},
      );
      await stopping.queue.resume("chat");
    }
  });

  it("keeps the went-out note visible after the chat's only row hands off", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const stopping = fixture(scope, [], true, true);
    await stopping.owner.ready;
    const only = stopping.enqueue(dmMessage);
    render(
      createElement(QueuedFollowUps, {
        session: stopping.session,
        channelId: "chat",
        disabled: false,
        focusComposer() {},
      }),
    );
    const storage = followUpStorage(scope);
    await releasesSettled(scope);
    const held = deferredVoid();
    const busy = storage.lockChat("chat", () => held.promise);
    const stopped = stopping.queue.pause("chat");
    // Another window, already past its checks, hands off the only row.
    storage.claim("chat", {
      id: only,
      message: "f".repeat(64),
      recipients: [agent],
      owner: "buzz-follow-up-window:other",
    });
    storage.remove(only);
    held.resolve();
    await busy;
    await stopped;
    act(() => {
      window.dispatchEvent(new StorageEvent("storage"));
    });
    await vi.waitFor(() => expect(stopping.queue.snapshot()).toEqual([]));
    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "One queued message was already being sent when you pressed Stop and may still go out.",
        ),
      ).toBeTruthy(),
    );
  });

  it("retires the failed-Resume alert at a later Stop, and keeps it gone after another window's Resume", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.enqueue(dmMessage);
    await h.queue.pause("chat");
    render(
      createElement(QueuedFollowUps, {
        session: h.session,
        channelId: "chat",
        disabled: false,
        focusComposer() {},
      }),
    );
    const alert =
      "Queue resumed in this window only. Couldn’t save that, so other windows or a restart may keep it paused.";
    const failing = failChatLocks();
    fireEvent.click(screen.getByRole("button", { name: "Resume queue" }));
    await vi.waitFor(() => expect(screen.getByText(alert)).toBeTruthy());
    failing.mockRestore();
    await act(() => h.queue.pause("chat"));
    expect(screen.queryByText(alert)).toBeNull();
    const other = fixture(scope, [], false, true);
    await other.owner.ready;
    await other.queue.resume("chat");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage"));
    });
    await releasesSettled(scope);
    expect(screen.queryByText(alert)).toBeNull();
  });
});

describe("Stop pause, chat-lock admission and recovery", () => {
  it("holds a row still validating after its old Outbox receipt disappeared", async () => {
    const a = fixture(scope, [], true, true);
    await a.owner.ready;
    const id = a.enqueue(dmMessage);
    await releasesSettled(scope);
    const entry = a.queue.snapshot().find((row) => row.id === id);
    if (!entry) throw new Error("Missing row");
    // Another window dismissed the old event. A still has its local ID
    // because receipt/removal notifications have not reached it.
    entry.deliveryId = "f".repeat(64);
    const b = fixture(scope, [], true, true);
    await b.owner.ready;
    const gate = deferredVoid();
    const refresh = a.refresh.getMockImplementation();
    a.refresh.mockImplementationOnce(async () => {
      await gate.promise;
      return refresh?.() as ReturnType<NonNullable<typeof refresh>>;
    });
    a.queue.sendNow(id);
    await vi.waitFor(() => expect(a.refresh).toHaveBeenCalled());
    const stopped = b.queue.pause("chat");
    gate.resolve();
    await stopped;
    await releasesSettled(scope);
    expect(a.send).not.toHaveBeenCalled();
    expect(followUpStorage(scope).has(id)).toBe(true);
  });

  it("tags a queued DM's agent when its profile isn't cached", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    h.coldProfiles();
    h.enqueue(dmMessage);
    await admitted();
    h.finish();
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    const [event] = h.publish.mock.calls[0] as unknown as [
      { tags: string[][] },
    ];
    expect(event.tags).toContainEqual(["p", agent]);
  });

  it("clears the last Stop's note when a Stop finds no rows", async () => {
    const stopping = fixture(scope, [], true, true);
    await stopping.owner.ready;
    const only = stopping.enqueue(dmMessage);
    await admitted();
    const storage = followUpStorage(scope);
    await releasesSettled(scope);
    const held = deferredVoid();
    const busy = storage.lockChat("chat", () => held.promise);
    const stopped = stopping.queue.pause("chat");
    // Another window, already past its checks, hands off the only row.
    storage.claim("chat", {
      id: only,
      message: "f".repeat(64),
      recipients: [agent],
      owner: "buzz-follow-up-window:other",
    });
    storage.remove(only);
    held.resolve();
    await busy;
    await stopped;
    window.dispatchEvent(new StorageEvent("storage"));
    await vi.waitFor(() =>
      expect(stopping.queue.notices().get("chat")).toEqual({
        sentBeforeStop: true,
      }),
    );
    await stopping.queue.pause("chat");
    expect(stopping.queue.notices().get("chat")).toBeUndefined();
  });

  it("drops a Send now clicked before another window's Stop that saved ahead of this window's", async () => {
    const storage = followUpStorage(scope);
    const a = fixture(scope, [], false, true);
    await a.owner.ready;
    const id = a.enqueue(dmMessage);
    await admitted();
    const b = fixture(scope, [], false, true);
    await b.owner.ready;
    const gate = deferredVoid();
    const busy = storage.lockChat("chat", () => gate.promise);
    // B's Stop waits for the lock first; A's Stop waits behind it.
    const bStopped = b.queue.pause("chat");
    const aStopped = a.queue.pause("chat");
    // A's Send now, clicked before B's Stop is saved.
    a.queue.sendNow(id);
    gate.resolve();
    await busy;
    await bStopped;
    await aStopped;
    await releasesSettled(scope);
    a.finish();
    await releasesSettled(scope);
    expect(a.send).not.toHaveBeenCalled();
    expect(a.queue.snapshot().map((row) => row.id)).toEqual([id]);
  });

  it("clears the saved pause when the queue empties after a Resume this window couldn't save", async () => {
    const h = fixture(scope, [], false, true);
    await h.owner.ready;
    const id = h.enqueue(dmMessage);
    await admitted();
    await h.queue.pause("chat");
    const request = navigator.locks.request.bind(navigator.locks);
    const failing = vi
      .spyOn(navigator.locks, "request")
      .mockImplementation(((name: string, ...rest: unknown[]) =>
        name.startsWith("buzz-follow-up-chat:")
          ? Promise.reject(new Error("Locks unavailable"))
          : (request as (...args: unknown[]) => Promise<unknown>)(
              name,
              ...rest,
            )) as typeof navigator.locks.request);
    await expect(h.queue.resume("chat")).rejects.toThrow("Locks unavailable");
    failing.mockRestore();
    expect(h.queue.notices().get("chat")).toEqual({ resumeUnsaved: true });
    expect(savedPause(scope, "chat")).toBe(true);
    await h.queue.remove(id);
    await releasesSettled(scope);
    expect(savedPause(scope, "chat")).toBe(false);
    expect(h.queue.notices().get("chat")).toBeUndefined();
  });

  it("reports a publication recorded after Stop for the row another window had already claimed", async () => {
    const stopping = fixture(scope, [], true, true);
    await stopping.owner.ready;
    stopping.enqueue(dmMessage);
    await admitted();
    const storage = followUpStorage(scope);
    await releasesSettled(scope);
    const claim = {
      id: "other",
      recipients: [agent],
      owner: "buzz-follow-up-window:other",
    };
    // Another window claimed its row and is publishing when Stop is pressed.
    storage.claim("chat", claim);
    const held = deferredVoid();
    const busy = storage.lockChat("chat", () => held.promise);
    const stopped = stopping.queue.pause("chat");
    storage.claim("chat", { ...claim, message: "f".repeat(64) });
    held.resolve();
    await busy;
    await stopped;
    expect(stopping.queue.pauses().get("chat")).toEqual({
      sentBeforeStop: true,
    });
  });
});
