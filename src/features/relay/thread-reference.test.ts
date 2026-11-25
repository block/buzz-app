import { expect, it } from "vitest";
import { replyPlacement, subthreadReplyParent } from "./thread-reference";

const root = "a".repeat(64);
const reply = "b".repeat(64);
const id = "c".repeat(64);

it.each([
  { tags: [["buzz:reply", "top"]], expected: "top" },
  { tags: [["buzz:reply", "thread"]], expected: "thread" },
  { tags: [["buzz:reply", "sideways"]], expected: undefined },
  { tags: [], expected: undefined },
  // Only a top-level message can ask for the top level.
  {
    tags: [
      ["e", root, "", "reply"],
      ["buzz:reply", "top"],
    ],
    expected: undefined,
  },
])(
  "reads the reply placement a message asks for: $expected",
  ({ tags, expected }) => {
    expect(replyPlacement({ tags })).toBe(expected);
  },
);

it("starts a subthread under a thread reply that asks for one", () => {
  expect(
    subthreadReplyParent({
      id,
      tags: [
        ["e", root, "", "reply"],
        ["buzz:reply", "subthread"],
      ],
    }),
  ).toBe(id);
  expect(
    subthreadReplyParent({
      id,
      tags: [
        ["e", root, "", "reply"],
        ["buzz:reply", "thread"],
      ],
    }),
  ).toBeUndefined();
});

it.each([["subthread"], ["thread"], [undefined]])(
  "keeps an answer in the subthread a message is already in, whatever it asks (%s)",
  (placement) => {
    expect(
      subthreadReplyParent({
        id,
        tags: [
          ["e", root, "", "root"],
          ["e", reply, "", "reply"],
          ...(placement ? [["buzz:reply", placement]] : []),
        ],
      }),
    ).toBe(reply);
  },
);
