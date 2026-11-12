import { afterEach, expect, it, vi } from "vitest";
import { keypair, profile } from "../relay/testing";
import {
  resetSharedTimeZones,
  shareDeviceTimeZone,
  withDeviceTimeZone,
} from "./share-time-zone";

const viewer = keypair();
const community = "https://community.example.org";
const zone = "Asia/Kolkata";

afterEach(resetSharedTimeZones);

function share(
  events: Promise<ReturnType<typeof profile>[]>,
  options: { zone?: string | undefined; signal?: AbortSignal } = {},
) {
  const publish = vi.fn(async () => {});
  return {
    publish,
    shared: shareDeviceTimeZone({
      community,
      viewer: viewer.pubkey,
      read: events,
      publish,
      zone,
      ...options,
    }),
  };
}

it("adds the device zone to an existing profile that never had one, keeping its fields", async () => {
  const { publish, shared } = share(
    Promise.resolve([
      profile(viewer, { name: "Old", website: "https://example.org" }, 1),
      profile(
        viewer,
        {
          name: "Mic",
          display_name: "Mic",
          picture: "https://example.org/mic.png",
          website: "https://example.org",
        },
        2,
      ),
    ]),
  );
  expect(await shared).toBe(true);
  expect(publish).toHaveBeenCalledWith(
    { name: "Mic", picture: "https://example.org/mic.png", about: "" },
    {
      name: "Mic",
      display_name: "Mic",
      picture: "https://example.org/mic.png",
      website: "https://example.org",
      tz: zone,
    },
  );
  // Once per launch: a later fresh read in the same community publishes nothing.
  const again = share(Promise.resolve([profile(viewer, { name: "Mic" }, 3)]));
  expect(await again.shared).toBe(false);
  expect(again.publish).not.toHaveBeenCalled();
});

it.each([
  ["an opt-out", { name: "Mic", tz: "" }],
  ["a shared zone", { name: "Mic", tz: "Europe/Paris" }],
  ["a zone this engine rejects", { name: "Mic", tz: "Mars/Olympus" }],
  ["a handle the writer would rename", { name: "mic", display_name: "Mic" }],
])("leaves %s alone", async (_case, content) => {
  const { publish, shared } = share(
    Promise.resolve([profile(viewer, content)]),
  );
  expect(await shared).toBe(false);
  expect(publish).not.toHaveBeenCalled();
});

it("never creates a profile", async () => {
  const other = keypair();
  const { publish, shared } = share(
    Promise.resolve([profile(other, { name: "Someone else" })]),
  );
  expect(await shared).toBe(false);
  expect(publish).not.toHaveBeenCalled();
});

it("publishes nothing after a failed read and tries again on the next one", async () => {
  const failed = share(Promise.reject(new Error("offline")));
  expect(await failed.shared).toBe(false);
  expect(failed.publish).not.toHaveBeenCalled();
  const next = share(Promise.resolve([profile(viewer, { name: "Mic" })]));
  expect(await next.shared).toBe(true);
});

it("publishes nothing when the read was abandoned or the device zone is unusable", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = share(Promise.resolve([profile(viewer, { name: "Mic" })]), {
    signal: controller.signal,
  });
  expect(await aborted.shared).toBe(false);
  const unzoned = share(Promise.resolve([profile(viewer, { name: "Mic" })]), {
    zone: undefined,
  });
  expect(await unzoned.shared).toBe(false);
  expect(unzoned.publish).not.toHaveBeenCalled();
});

it("adds the device zone to a first or untouched profile but keeps an opt-out", () => {
  expect(withDeviceTimeZone({}, zone)).toEqual({ tz: zone });
  expect(withDeviceTimeZone({ tz: "" }, zone)).toEqual({ tz: "" });
  expect(withDeviceTimeZone({ name: "Mic" }, undefined)).toEqual({
    name: "Mic",
  });
});
