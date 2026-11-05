import { expect, it } from "vitest";
import { projectReactions } from "./row";

const id = (n: number) => n.toString(16).padStart(64, "0");
const VIEWER = "a".repeat(64);
const group = (content: string, authors: string[], emoji?: string) => ({
  content,
  ...(emoji ? { emoji: { shortcode: emoji, url: `https://m/${emoji}` } } : {}),
  events: authors.map((authorId, i) => ({ id: id(i + 1), authorId })),
});

it("keeps the viewer's own reaction events first so a capped list still toggles correctly", () => {
  const others = Array.from({ length: 200 }, (_, i) => id(1000 + i));
  const { reactions, reactionsLimited } = projectReactions(
    [group("👍", [...others, VIEWER])],
    VIEWER,
  );
  expect(reactionsLimited).toBe(true);
  expect(reactions?.[0]?.events).toHaveLength(128);
  expect(reactions?.[0]?.events[0]?.authorId).toBe(VIEWER);
});

it("bounds groups, drops invalid content and oversized custom emoji, and keeps valid custom ones", () => {
  const many = Array.from({ length: 70 }, (_, i) => group(`${i}`, [VIEWER]));
  const { reactions, reactionsLimited } = projectReactions(many, VIEWER);
  expect(reactions).toHaveLength(64);
  expect(reactionsLimited).toBe(true);
  const { reactions: filtered, reactionsLimited: limited } = projectReactions(
    [
      group("x".repeat(65), [VIEWER]),
      group(":party_blob:", [VIEWER], "party_blob"),
      {
        ...group(":big:", [VIEWER], "big"),
        emoji: { shortcode: "big", url: "u".repeat(9000) },
      },
      { content: "👍", events: [{ id: "short", authorId: VIEWER }] },
    ],
    VIEWER,
  );
  expect(filtered?.map((r) => r.content)).toEqual([":party_blob:", "👍"]);
  expect(filtered?.[1]?.events).toEqual([]);
  expect(limited).toBeUndefined();
});
