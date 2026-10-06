import { expect, it } from "vitest";
import { identityTiles } from "./identity-tiles";
import { inheritDefinitionAvatars } from "../../features/agents/library";
it("shows one tile per visible key and only truly identity-free profiles", () => {
  const library = {
    definitions: [
      { id: "shared", name: "Larry", avatar: "art" },
      { id: "archived", name: "Hidden" },
      { id: "empty", name: "Profile only" },
    ],
    identities: [
      { pubkey: "a", name: "One", definitionId: "shared" },
      { pubkey: "b", name: "Two", definitionId: "shared", avatar: "own" },
      { pubkey: "c", name: "Hidden", definitionId: "archived" },
      { pubkey: "d", name: "Missing", definitionId: "missing" },
      { pubkey: "e", name: "Custom" },
    ],
  };
  const tiles = identityTiles(
    inheritDefinitionAvatars(library),
    (key) => key === "c",
  );
  expect(tiles.identities.map((row) => row.pubkey)).toEqual([
    "a",
    "b",
    "d",
    "e",
  ]);
  expect(tiles.identities.map((row) => row.avatar)).toEqual([
    "art",
    "own",
    undefined,
    undefined,
  ]);
  expect(tiles.profiles).toEqual([library.definitions[2]]);
});
