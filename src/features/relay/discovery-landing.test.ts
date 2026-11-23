import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, metadata, roster } from "./testing";

it("marks the welcome channel and its message and title from relay-signed metadata", () => {
  const viewer = keypair(),
    relay = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(roster(relay, "general", [viewer.pubkey]));
  state.accept(metadata(relay, "general", "General"));
  expect(state.get("general")?.landing).toBeUndefined();

  state.accept(
    metadata(relay, "general", "General", 1_700_000_001, [
      ["landing"],
      ["welcome", "Say hi"],
      ["welcome_title", "Hello"],
    ]),
  );
  expect(state.get("general")).toMatchObject({
    landing: true,
    welcome: "Say hi",
    welcomeTitle: "Hello",
  });

  // Moving the designation re-emits this channel without it; a surviving
  // message no longer applies.
  state.accept(
    metadata(relay, "general", "General", 1_700_000_002, [
      ["welcome", "Say hi"],
      ["welcome_title", "Hello"],
    ]),
  );
  expect(state.get("general")?.landing).toBeUndefined();
  expect(state.get("general")?.welcome).toBeUndefined();
  expect(state.get("general")?.welcomeTitle).toBeUndefined();
});

it("ignores a non-relay-authored landing tag", () => {
  const viewer = keypair(),
    relay = keypair(),
    stranger = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  state.accept(roster(relay, "general", [viewer.pubkey]));
  state.accept(metadata(relay, "general", "General"));
  expect(
    state.accept(
      metadata(stranger, "general", "General", 1_700_000_001, [["landing"]]),
    ),
  ).toBe(false);
  expect(state.get("general")?.landing).toBeUndefined();
});
