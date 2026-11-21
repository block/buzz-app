// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { profileFromEvent } from "../communities/api";
import {
  backgroundProfileWrites,
  beginProfileSave,
  endProfileSave,
} from "../communities/profile-saves";
import type { Communities } from "../communities/service";
import { keypair, profile } from "../relay/testing";
import {
  followDeviceTimeZone,
  resetFollowedTimeZones,
  setTimeZonePinned,
  timeZonePinned,
  withDeviceTimeZone,
} from "./share-time-zone";

const viewer = keypair();
const community = "https://community.example.org";
const other = "https://other.example.org";
const zone = "America/Los_Angeles";

afterEach(resetFollowedTimeZones);

function communitiesOf(ids: string[], who = viewer.pubkey) {
  const snapshot = { viewer: who, memberships: ids.map((id) => ({ id })) };
  return { snapshot: () => snapshot } as unknown as Communities;
}

/** Runs the follower over `profiles`, the strong read of each community. */
function follow(
  profiles: Record<string, Record<string, unknown> | undefined>,
  options: {
    zone?: string | undefined;
    signal?: AbortSignal;
    only?: string[];
    communities?: Communities;
    inspect?: (id: string) => Promise<ReturnType<typeof profileFromEvent>>;
  } = {},
) {
  const publish = vi.fn(async () => {});
  const inspect = vi.fn(
    options.inspect ??
      (async (id: string) => {
        const content = profiles[id];
        return profileFromEvent(content && profile(viewer, content));
      }),
  );
  return {
    publish,
    inspect,
    followed: followDeviceTimeZone({
      viewer: viewer.pubkey,
      communities: options.communities ?? communitiesOf(Object.keys(profiles)),
      inspect,
      publish,
      zone: "zone" in options ? options.zone : zone,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.only ? { only: options.only } : {}),
    }),
  };
}

it("moves a stale zone to this device's, keeping the profile's other fields", async () => {
  const { publish, followed } = follow({
    [community]: {
      name: "Mic",
      display_name: "Mic",
      picture: "https://example.org/mic.png",
      website: "https://example.org",
      tz: "Pacific/Honolulu",
    },
  });
  expect(await followed).toEqual([]);
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    community,
    { name: "Mic", picture: "https://example.org/mic.png", about: "" },
    {
      name: "Mic",
      display_name: "Mic",
      picture: "https://example.org/mic.png",
      website: "https://example.org",
      tz: zone,
    },
  );
});

it("follows in every joined community, not only one", async () => {
  const { publish, followed } = follow({
    [community]: { name: "Mic", tz: "Pacific/Honolulu" },
    [other]: { name: "Mic" },
  });
  expect(await followed).toEqual([]);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledWith(
    other,
    { name: "Mic", picture: "", about: "" },
    { name: "Mic", tz: zone },
  );
});

it.each([
  ["an opt-out", { name: "Mic", tz: "" }],
  ["this device's zone", { name: "Mic", tz: zone }],
  ["another spelling of this device's zone", { name: "Mic", tz: "US/Pacific" }],
  ["a handle the writer would rename", { name: "mic", display_name: "Mic" }],
  ["no profile", undefined],
])("leaves %s alone", async (_case, content) => {
  const { publish, followed } = follow({ [community]: content });
  expect(await followed).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

it("never overwrites a zone pinned on this device", async () => {
  setTimeZonePinned(community, viewer.pubkey, true);
  const { publish, inspect, followed } = follow({
    [community]: { name: "Mic", tz: "Europe/Paris" },
  });
  expect(await followed).toEqual([]);
  expect(inspect).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  // Unpinning follows again.
  setTimeZonePinned(community, viewer.pubkey, false);
  expect(timeZonePinned(community, viewer.pubkey)).toBe(false);
  const again = follow({ [community]: { name: "Mic", tz: "Europe/Paris" } });
  expect(await again.followed).toEqual([]);
  expect(again.publish).toHaveBeenCalledOnce();
});

it("keeps a zone pinned while its read was in flight", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { publish, inspect, followed } = follow(
    { [community]: undefined },
    {
      inspect: async () => {
        await held;
        return profileFromEvent(
          profile(viewer, { name: "Mic", tz: "Europe/Paris" }),
        );
      },
    },
  );
  await vi.waitFor(() => expect(inspect).toHaveBeenCalled());
  setTimeZonePinned(community, viewer.pubkey, true);
  release();
  expect(await followed).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

it("remembers a pinned zone across launches", async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  try {
    setTimeZonePinned(community, viewer.pubkey, true);
    vi.resetModules();
    const next = await import("./share-time-zone");
    expect(next.timeZonePinned(community, viewer.pubkey)).toBe(true);
    expect(next.timeZonePinned(other, viewer.pubkey)).toBe(false);
  } finally {
    resetFollowedTimeZones();
    vi.unstubAllGlobals();
  }
});

it("stands aside for a profile save that is running or started after it began", async () => {
  const communities = communitiesOf([community]);
  const content = { name: "Mic", tz: "Pacific/Honolulu" };
  // A save running when the run begins.
  beginProfileSave(communities);
  const running = follow({ [community]: content }, { communities });
  expect(await running.followed).toEqual([community]);
  expect(running.publish).not.toHaveBeenCalled();
  endProfileSave(communities);
  // A save that starts and finishes while the strong read is in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = follow(
    { [community]: content },
    {
      communities,
      inspect: async () => {
        await held;
        return profileFromEvent(profile(viewer, content));
      },
    },
  );
  await vi.waitFor(() => expect(started.inspect).toHaveBeenCalled());
  beginProfileSave(communities);
  endProfileSave(communities);
  release();
  expect(await started.followed).toEqual([community]);
  expect(started.publish).not.toHaveBeenCalled();
});

it("runs one at a time, so a second trigger sees the first's write", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const first = follow({ [community]: { name: "Mic", tz: "Asia/Tokyo" } });
  first.publish.mockImplementation(() => held);
  await vi.waitFor(() => expect(first.publish).toHaveBeenCalled());
  const second = follow({ [community]: { name: "Mic", tz: zone } });
  await new Promise((resolve) => setTimeout(resolve));
  expect(second.inspect).not.toHaveBeenCalled();
  release();
  expect(await first.followed).toEqual([]);
  expect(await second.followed).toEqual([]);
  expect(second.publish).not.toHaveBeenCalled();
});

it("lets a save wait for a write it has handed to the writer", async () => {
  const communities = communitiesOf([community]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { publish, followed } = follow(
    { [community]: { name: "Mic", tz: "Asia/Tokyo" } },
    { communities },
  );
  publish.mockImplementation(() => held);
  await vi.waitFor(() => expect(publish).toHaveBeenCalled());
  let settled = false;
  void backgroundProfileWrites(communities)?.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve));
  expect(settled).toBe(false);
  release();
  expect(await followed).toEqual([]);
  await vi.waitFor(() => expect(settled).toBe(true));
});

it("reports a failed read or publication so the check can be retried, and still checks the rest", async () => {
  const unread = follow(
    { [community]: undefined, [other]: { name: "Mic" } },
    {
      inspect: async (id) => {
        if (id === community) throw new Error("offline");
        return profileFromEvent(profile(viewer, { name: "Mic" }));
      },
    },
  );
  expect(await unread.followed).toEqual([community]);
  expect(unread.publish).toHaveBeenCalledExactlyOnceWith(
    other,
    expect.anything(),
    expect.anything(),
  );
  const unpublished = follow({ [community]: { name: "Mic" } });
  unpublished.publish.mockRejectedValueOnce(new Error("offline"));
  expect(await unpublished.followed).toEqual([community]);
});

it("publishes nothing once abandoned, after an identity switch, or without a usable device zone", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = follow(
    { [community]: { name: "Mic" } },
    { signal: controller.signal },
  );
  expect(await aborted.followed).toEqual([]);
  expect(aborted.publish).not.toHaveBeenCalled();
  const switched = follow(
    { [community]: { name: "Mic" } },
    { communities: communitiesOf([community], keypair().pubkey) },
  );
  await switched.followed;
  expect(switched.publish).not.toHaveBeenCalled();
  const unzoned = follow({ [community]: { name: "Mic" } }, { zone: undefined });
  expect(await unzoned.followed).toEqual([]);
  expect(unzoned.inspect).not.toHaveBeenCalled();
});

it("adds the device zone to a first or untouched profile but keeps an opt-out", () => {
  expect(withDeviceTimeZone({}, zone)).toEqual({ tz: zone });
  expect(withDeviceTimeZone({ tz: "" }, zone)).toEqual({ tz: "" });
  expect(withDeviceTimeZone({ name: "Mic" }, undefined)).toEqual({
    name: "Mic",
  });
});

it("writes nothing to a community left while its read was in flight", async () => {
  const snapshot = {
    viewer: viewer.pubkey,
    memberships: [{ id: community }],
  };
  const communities = { snapshot: () => snapshot } as unknown as Communities;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { publish, inspect, followed } = follow(
    { [community]: undefined },
    {
      communities,
      inspect: async () => {
        await held;
        return profileFromEvent(
          profile(viewer, { name: "Mic", tz: "Asia/Tokyo" }),
        );
      },
    },
  );
  await vi.waitFor(() => expect(inspect).toHaveBeenCalled());
  snapshot.memberships = [];
  release();
  expect(await followed).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

it("checks only the communities it is given", async () => {
  const { inspect, followed } = follow(
    {
      [community]: { name: "Mic", tz: "Asia/Tokyo" },
      [other]: { name: "Mic", tz: "Asia/Tokyo" },
    },
    { only: [other] },
  );
  expect(await followed).toEqual([]);
  expect(inspect).toHaveBeenCalledExactlyOnceWith(other);
});
