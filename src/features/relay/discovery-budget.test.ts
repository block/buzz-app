import { expect, it } from "vitest";
import { byteSize } from "./budget";
import { DiscoveryState } from "./discovery";
import { keypair, metadata, roster } from "./testing";

it("retains evidence by bytes and reclaims the space of replaced and cleared records", () => {
  const viewer = keypair(),
    relay = keypair();
  const first = roster(relay, "a", [viewer.pubkey]);
  const next = roster(relay, "a", [viewer.pubkey], first.created_at + 1);
  const other = roster(relay, "b", [viewer.pubkey]);
  const state = new DiscoveryState(
    viewer.pubkey,
    relay.pubkey,
    byteSize(first) + byteSize(other),
  );
  expect(state.accept(first, true)).toBe(true);
  expect(state.accept(next, true)).toBe(true);
  expect(state.accept(other, true)).toBe(true);
  expect(state.accept(roster(relay, "c", [viewer.pubkey]))).toBe(false);
  state.clearCached();
  expect(state.accept(first)).toBe(true);
  expect(state.accept(other)).toBe(true);
  expect(state.canParticipate("a")).toBe(true);
});

it("fails closed when a larger signed roster cannot fit and cannot regrant with its old version", () => {
  const viewer = keypair(),
    relay = keypair();
  const first = roster(relay, "a", [viewer.pubkey]);
  const state = new DiscoveryState(
    viewer.pubkey,
    relay.pubkey,
    byteSize(first),
  );
  state.accept(first);
  const intermediate = roster(
    relay,
    "a",
    [viewer.pubkey],
    first.created_at + 1,
  );
  const replacement = roster(
    relay,
    "a",
    Array.from({ length: 10 }, () => relay.pubkey),
    first.created_at + 2,
  );
  expect(state.accept(replacement)).toBe(false);
  expect(state.canAccess("a")).toBe(false);
  expect(state.accept(first)).toBe(false);
  expect(state.accept(intermediate)).toBe(false);
  expect(state.canParticipate("a")).toBe(false);
  expect(state.overflowRevision).toBe(1);
});

it("fails closed when a public metadata change exceeds the retained byte budget", () => {
  const viewer = keypair(),
    relay = keypair();
  const first = metadata(relay, "a", "A", 1, [["public"]]);
  const state = new DiscoveryState(
    viewer.pubkey,
    relay.pubkey,
    byteSize(first),
  );
  state.accept(first);
  expect(state.canAccess("a")).toBe(true);
  expect(
    state.accept(
      metadata(relay, "a", "A longer private name", 2, [["private"]]),
    ),
  ).toBe(false);
  expect(state.canAccess("a")).toBe(false);
});
