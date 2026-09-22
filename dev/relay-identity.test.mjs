import { expect, it, vi } from "vitest";
import { getPublicKey, nip19 } from "nostr-tools";
import { loadIdentity } from "./relay-broker.mjs";
const key = new Uint8Array(32).fill(7);
const pubkey = getPublicKey(key);
const secret = JSON.stringify({ identity: nip19.nsecEncode(key) });
it("reads only the selected Buzz service and enforces its pinned public identity", () => {
  const read = vi.fn(() => Buffer.from(secret));
  const result = loadIdentity(pubkey, {
    service: "buzz-desktop-demo.provider",
    platform: "darwin",
    read,
  });
  expect(getPublicKey(result)).toBe(pubkey);
  expect(read.mock.calls[0][1]).toEqual([
    "find-generic-password",
    "-s",
    "buzz-desktop-demo.provider",
    "-a",
    "secrets",
    "-w",
  ]);
  result.fill(0);
  expect(() =>
    loadIdentity(getPublicKey(new Uint8Array(32).fill(8)), {
      service: "buzz-desktop-dev.consumer",
      platform: "darwin",
      read,
    }),
  ).toThrow("does not match");
  expect(read).toHaveBeenCalledTimes(2);
});
it("refuses invalid public pins or unrelated credential services before reading", () => {
  const read = vi.fn();
  expect(() => loadIdentity("invalid", { read })).toThrow("public key");
  expect(() =>
    loadIdentity(pubkey, { service: "unrelated-service", read }),
  ).toThrow("existing Buzz");
  expect(read).not.toHaveBeenCalled();
});
it("does not fall back when the chosen service is missing or declined", () => {
  const read = vi.fn(() => {
    throw new Error("unavailable");
  });
  expect(() =>
    loadIdentity(pubkey, {
      service: "buzz-desktop-dev.consumer",
      platform: "darwin",
      read,
    }),
  ).toThrow("no credential fallback");
  expect(read).toHaveBeenCalledTimes(1);
});
