import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, metadata, roster } from "./testing";

it("projects ancestry presence, even malformed, as a readback requirement rather than authority", () => {
  const relay = keypair(),
    viewer = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(roster(relay, id, [viewer.pubkey]));
  state.accept(metadata(relay, id, "Chat", 1));
  expect(state.get(id)?.forkClaim).toBeUndefined();
  state.accept(metadata(relay, id, "Chat", 2, [["forked_from"]]));
  expect(state.get(id)?.forkClaim).toBe(true);
  state.accept(metadata(relay, id, "Chat", 3));
  expect(state.get(id)?.forkClaim).toBeUndefined();
});
