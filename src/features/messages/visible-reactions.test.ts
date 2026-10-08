import { expect, it } from "vitest";
import { visibleReactions } from "./visible-reactions";
it("hides agent status glyphs while retaining people, other agent reactions and source evidence", () => {
  const agent = { id: "agent-reaction", authorId: "agent" };
  const human = { id: "human-reaction", authorId: "human" };
  const reactions = [
    { content: "👀", events: [agent, human] },
    { content: "💬", events: [agent] },
    { content: "✅", events: [agent] },
    {
      content: "💬",
      emoji: { shortcode: "custom", url: "https://a.test/custom" },
      events: [agent],
    },
  ];
  expect(visibleReactions(reactions, new Set(["agent"]))).toEqual([
    { content: "👀", events: [human] },
    reactions[2],
    reactions[3],
  ]);
  expect(reactions[0]?.events).toEqual([agent, human]);
  expect(visibleReactions(reactions, new Set())).toEqual(reactions);
});
