import { expect, it } from "vitest";
import {
  conversationReplies,
  isAgentCoordination,
} from "./conversation-visibility";
import type { ChannelMessage } from "../relay/contracts";
const row = (id: string, parent?: string) =>
  ({
    id,
    replyParentId: parent,
    authorId: "agent",
    content: id,
    audience: "agents",
  }) as ChannelMessage;
it("uses exact audience/identity evidence, never prose, and preserves the viewer", () => {
  const known = new Set(["agent"]);
  expect(isAgentCoordination(row("coord"), known)).toBe(true);
  const { audience: _audience, ...legacy } = row("coord");
  expect(isAgentCoordination(legacy, known)).toBe(false);
  expect(isAgentCoordination(row("coord"), new Set())).toBe(false);
  expect(
    isAgentCoordination({ ...row("coord"), agentEnvelope: true }, new Set()),
  ).toBe(true);
  expect(isAgentCoordination(row("coord"), known, "agent")).toBe(false);
});
it("skips chains of hidden parents while retaining visible ancestry and original signed objects", () => {
  const parent = row("parent", "root"),
    hidden = row("hidden", "parent"),
    deep = row("deep", "hidden"),
    answer = row("answer", "deep");
  const projected = conversationReplies(
    [parent, hidden, deep, answer],
    new Set(["hidden", "deep"]),
    "root",
  );
  expect(projected).toEqual([parent, { ...answer, replyParentId: "parent" }]);
  expect(answer.replyParentId).toBe("deep");
  expect(
    conversationReplies(
      [hidden, deep, answer],
      new Set(["hidden", "deep"]),
      "root",
    ),
  ).toEqual([{ ...answer, replyParentId: "root" }]);
});
it("keeps visible children of missing or cyclic hidden ancestry without recursion", () => {
  const input = [row("a", "b"), row("b", "a"), row("answer", "a")];
  expect(conversationReplies(input, new Set(["a", "b"]), "root")).toEqual([
    { ...input[2], replyParentId: "root" },
  ]);
  expect(
    conversationReplies([row("answer", "missing")], new Set(), "root"),
  ).toEqual([row("answer", "missing")]);
});
