import { expect, it } from "vitest";
import { parseGitHubReference } from "./references";

it("recognizes typed GitHub references while refusing lookalike hosts and invalid targets", () => {
  for (const [path, kind] of [
    ["block/buzz", "repository"],
    ["block/buzz/pull/23", "pull"],
    ["block/buzz/issues/12", "issue"],
    ["block/buzz/commit/abcdef1234", "commit"],
  ]) {
    expect(parseGitHubReference(`https://github.com/${path}`)?.kind).toBe(kind);
  }
  for (const url of [
    "https://github.com.evil.test/block/buzz/pull/23",
    "https://someone@github.com/block/buzz",
    "http://github.com/block/buzz",
    "https://github.com/block/buzz/tree/main",
    "https://github.com/block/buzz/blob/main/README.md",
    "https://github.com/block/buzz/pull/0",
    "https://github.com/block/buzz/commit/nope",
  ])
    expect(parseGitHubReference(url)).toBeUndefined();
});
