import { expect, it } from "vitest";
import { sessionLinkTarget } from "./SessionsPage";

it("routes internal links from a standalone session through its community", () => {
  const viewer = "a".repeat(64);
  expect(
    sessionLinkTarget(
      "buzz://channel/planning",
      `https://buzz.block.builderlab.xyz:${viewer}`,
      viewer,
    ),
  ).toEqual({
    version: 1,
    kind: "conversation",
    scope: {
      viewer,
      communityOrigin: "https://buzz.block.builderlab.xyz",
    },
    channelId: "planning",
  });
  expect(
    sessionLinkTarget(
      "https://example.com",
      `https://buzz.block.builderlab.xyz:${viewer}`,
      viewer,
    ),
  ).toBeNull();
});
