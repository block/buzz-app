import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { StatusInput, UserStatus } from "../../features/relay/user-status";
import { createFocus } from "./state";
import { FOCUS_STATUS, bindFocusStatus, soloConversation } from "./status";

const NOW = Date.UTC(2026, 10, 2, 20);
const at = (seconds: number) => Math.floor(NOW / 1000) + seconds;
const flush = () => vi.advanceTimersByTimeAsync(0);

type Raw = {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
};
const raw = (input: StatusInput, createdAt: number): Raw => ({
  id: `event-${createdAt}`,
  pubkey: "viewer",
  created_at: createdAt,
  content: input.text,
  tags: [
    ["d", "general"],
    ...(input.emoji ? [["emoji", input.emoji]] : []),
    ...(input.expiresAt === undefined
      ? []
      : [["expiration", String(input.expiresAt)]]),
  ],
});
/** What the status store shows: the newest event, unless a clear or expired. */
function visible(event: Raw | undefined): UserStatus | undefined {
  if (!event) return undefined;
  const emoji = event.tags.find(([key]) => key === "emoji")?.[1] ?? "";
  const expiration = event.tags.find(([key]) => key === "expiration")?.[1];
  const expiresAt = expiration === undefined ? undefined : Number(expiration);
  if (!event.content && !emoji) return undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now() / 1000)
    return undefined;
  return {
    userId: "viewer",
    text: event.content,
    emoji,
    updatedAt: event.created_at,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function relay(initial?: StatusInput) {
  // The relay keeps the newest replacement, clears and expired ones included.
  let latest: Raw | undefined = initial && raw(initial, at(-100));
  let clock = 0;
  const save = vi.fn(async (input: StatusInput) => {
    latest = raw(input, at(0) + clock++);
  });
  const listeners = new Set<() => void>();
  let state = {
    status: "ready",
    cached: false,
    scope: "wss://a:viewer",
    viewer: "viewer",
    session: {
      readRemote: vi.fn(async () => (latest ? [latest] : [])),
      statuses: {
        writable: true,
        save,
        current: vi.fn(async () => visible(latest)),
        snapshot: () => {
          const shown = visible(latest);
          return new Map(shown ? [["viewer", shown]] : []);
        },
      },
      channels: {
        list: () => ({
          channels: [
            { id: "solo", channelType: "solo" },
            { id: "team", channelType: "stream" },
          ],
        }),
      },
    },
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const data = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  return {
    data,
    save,
    /** Another device or the status dialog publishes a newer status. */
    publish(input: StatusInput) {
      latest = raw(input, at(0) + clock++);
    },
    /** The relay has nothing, as one that drops expired events would. */
    forget() {
      latest = undefined;
    },
    select(scope: string) {
      state = { ...state, scope };
      notify();
    },
    connection(status: string) {
      state = { ...state, status };
      notify();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

it("sets the telescope until the deadline and restores the previous status", async () => {
  const lunch = { text: "Lunch", emoji: "🥪", expiresAt: at(9000) };
  const community = relay(lunch);
  const focus = createFocus(undefined);
  const stop = bindFocusStatus(focus, community.data);
  focus.start(at(3600));
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({
    ...FOCUS_STATUS,
    expiresAt: at(3600),
  });
  expect(focus.snapshot().status).toEqual({
    until: at(3600),
    scope: "wss://a:viewer",
    previous: lunch,
    published: at(0),
  });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith(lunch);
  expect(focus.snapshot().status).toBeUndefined();
  stop();
});

it("clears the telescope when Focus ends early with no previous status", async () => {
  const community = relay();
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  focus.end();
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({ text: "", emoji: "" });
});

it("leaves an expired telescope alone when there is nothing to restore", async () => {
  const community = relay();
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("leaves a status the person changed during Focus alone", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.publish({ text: "Travelling", emoji: "✈️" });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("does not bring back the old status after the person cleared theirs", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.publish({ text: "", emoji: "" });
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("does not bring back the old status after a newer one expired", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.publish({ text: "Call", emoji: "📞", expiresAt: at(30) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(focus.snapshot().until).toBeUndefined();
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("restores after the telescope expired, but not a stale status", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪", expiresAt: at(30) });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
});

it("restores when the relay no longer has the expired telescope", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.forget();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(community.save).toHaveBeenLastCalledWith({
    text: "Lunch",
    emoji: "🥪",
  });
});

it("waits for the community it changed before restoring", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.select("wss://b:viewer");
  focus.end();
  await flush();
  expect(community.save).toHaveBeenCalledTimes(1);
  community.select("wss://a:viewer");
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({
    text: "Lunch",
    emoji: "🥪",
  });
});

it("a later Focus elsewhere still sets the telescope", async () => {
  const community = relay({ text: "Lunch", emoji: "🥪" });
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data);
  focus.start(at(60));
  await flush();
  community.select("wss://b:viewer");
  focus.end();
  await flush();
  focus.start(at(120));
  await flush();
  expect(community.save).toHaveBeenLastCalledWith({
    ...FOCUS_STATUS,
    expiresAt: at(120),
  });
  expect(focus.snapshot().status).toMatchObject({
    until: at(120),
    scope: "wss://b:viewer",
  });
});

it("retries a failed set once the connection comes back, not before", async () => {
  const community = relay();
  community.save.mockRejectedValueOnce(new Error("offline"));
  const report = vi.fn();
  const focus = createFocus(undefined);
  bindFocusStatus(focus, community.data, report);
  focus.start(at(60));
  await flush();
  community.select("wss://a:viewer");
  await flush();
  expect(report).toHaveBeenCalledTimes(1);
  expect(community.save).toHaveBeenCalledTimes(1);
  expect(focus.snapshot().status).toBeUndefined();
  community.connection("connecting");
  await flush();
  community.connection("ready");
  await flush();
  expect(community.save).toHaveBeenCalledTimes(2);
  expect(community.save).toHaveBeenLastCalledWith({
    ...FOCUS_STATUS,
    expiresAt: at(60),
  });
  expect(focus.snapshot().status).toMatchObject({ until: at(60) });
});

it("recognises only listed Solo conversations", () => {
  const { data } = relay();
  expect(
    soloConversation(data, { kind: "conversation", channelId: "solo" }),
  ).toBe(true);
  expect(
    soloConversation(data, { kind: "conversation", channelId: "team" }),
  ).toBe(false);
  expect(soloConversation(data, { kind: "page" })).toBe(false);
});
