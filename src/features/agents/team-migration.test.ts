import { describe, expect, it } from "vitest";

import { memoryStorage } from "./test-fakes";
import {
  moveHome,
  syncText,
  TEAM_MOVES_KEY,
  TeamMoves,
} from "./team-migration";

const a = "https://a.example";
const b = "https://b.example";

describe("moveHome", () => {
  const homes: Record<string, string[]> = { x: [a], y: [a], z: [b], w: [] };
  const of = (pubkey: string) => homes[pubkey] ?? [];
  it("moves a team whose members are all in one community there", () => {
    expect(moveHome(["x", "y"], of, undefined)).toEqual({ home: a });
  });
  it("keeps a team whose members span communities", () => {
    expect(moveHome(["x", "z"], of, undefined)).toEqual({
      stay: "communities",
    });
  });
  it("keeps a team with a member that isn't the owner's agent anywhere", () => {
    expect(moveHome(["x", "w"], of, undefined)).toEqual({ stay: "none" });
    expect(moveHome([], of, undefined)).toEqual({ stay: "none" });
  });
  it("keeps a move in the community it began in", () => {
    expect(moveHome(["z"], of, { community: a })).toEqual({ stay: "none" });
    expect(moveHome(["x"], of, { community: a, failed: true })).toEqual({
      home: a,
    });
  });
});

describe("TeamMoves", () => {
  it("saves each move and reads it back, dropping finished ones", async () => {
    const storage = memoryStorage();
    const moves = new TeamMoves(storage);
    await moves.set("one", { community: a });
    await moves.set("two", { community: b, failed: true });
    await moves.set("one", undefined);
    const again = new TeamMoves(storage);
    expect(again.get("one")).toBeUndefined();
    expect(again.get("two")).toEqual({ community: b, failed: true });
  });
  it("starts empty from malformed data", async () => {
    const storage = memoryStorage();
    await storage.set(TEAM_MOVES_KEY, "{");
    expect(new TeamMoves(storage).get("one")).toBeUndefined();
  });
});

describe("syncText", () => {
  it("names the community a synced copy is in", () => {
    expect(syncText({ synced: "https://relay.example" }, "team")).toEqual({
      title: "Synced in relay.example",
    });
  });
  it("says why a team or agent is only here", () => {
    expect(syncText({ local: "communities" }, "team")).toEqual({
      title: "Only on this Mac",
      reason: "Its agents are in different communities.",
    });
    expect(syncText({ local: "failed" }, "agent").reason).toMatch(
      /will try again/,
    );
    expect(syncText({ local: undefined }, "team")).toEqual({
      title: "Only on this Mac",
    });
  });
});
