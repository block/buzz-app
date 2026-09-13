import { expect, it, vi } from "vitest";
import {
  createChannelActivity,
  CHANNEL_ACTIVITY_KINDS,
} from "./channel-activity";
import { flush, keypair, message, signed } from "./testing";

const forumActivity = (
  key: ReturnType<typeof keypair>,
  channelId: string,
  kind: 45001 | 45003,
  created_at: number,
) =>
  signed(key, { kind, created_at, content: "forum", tags: [["h", channelId]] });

function deferredReader() {
  const pending: {
    ids: readonly string[];
    signal: AbortSignal;
    resolve(events: readonly import("./events").RelayEvent[]): void;
    reject(error: unknown): void;
  }[] = [];
  return {
    pending,
    read(ids: readonly string[], signal: AbortSignal) {
      return new Promise<readonly import("./events").RelayEvent[]>(
        (resolve, reject) => pending.push({ ids, signal, resolve, reject }),
      );
    },
  };
}

it("reads authoritative activity in 128-channel batches across message and forum kinds", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const changed = vi.fn();
  const activity = createChannelActivity(wire.read);
  activity.subscribe(changed);
  const ids = Array.from({ length: 257 }, (_, index) => `room-${index}`);
  const refresh = activity.refresh(ids);
  await flush();
  for (const [index, size] of [128, 128, 1].entries()) {
    const request = wire.pending.shift();
    expect(request?.ids).toEqual(ids.slice(index * 128, index * 128 + size));
    expect(CHANNEL_ACTIVITY_KINDS).toEqual([9, 40002, 45001, 45003]);
    const channelId = ids[index * 128];
    request?.resolve(
      channelId ? [forumActivity(peer, channelId, 45003, 100 + index)] : [],
    );
    await flush();
  }
  await refresh;
  expect(activity.last(ids[0] ?? "")).toBe(100);
  expect(activity.last(ids[128] ?? "")).toBe(101);
  expect(activity.last(ids[256] ?? "")).toBe(102);
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps the last good projection on failure and never rolls back newer live activity", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read, vi.fn());
  activity.accept([message(peer, "alpha", "seed", 50)]);

  const failed = activity.refresh(["alpha"]);
  await flush();
  wire.pending.shift()?.reject(new Error("offline"));
  await expect(failed).rejects.toThrow("offline");
  expect(activity.last("alpha")).toBe(50);

  const refresh = activity.refresh(["alpha", "quiet"]);
  await flush();
  activity.accept([message(peer, "alpha", "live", 90)]);
  wire.pending.shift()?.resolve([message(peer, "alpha", "stale query", 60)]);
  await refresh;
  expect(activity.last("alpha")).toBe(90);
  expect(activity.last("quiet")).toBeUndefined();
});

it("authoritative absence clears unchanged recency but cache clear rejects late settlement", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read, vi.fn());
  activity.accept([forumActivity(peer, "forum", 45001, 70)]);
  const absent = activity.refresh(["forum"]);
  await flush();
  wire.pending.shift()?.resolve([]);
  await absent;
  expect(activity.last("forum")).toBeUndefined();

  activity.accept([message(peer, "forum", "again", 80)]);
  const stale = activity.refresh(["forum"]);
  await flush();
  activity.clear();
  wire.pending.shift()?.resolve([message(peer, "forum", "late", 100)]);
  await stale;
  expect(activity.last("forum")).toBeUndefined();
});
