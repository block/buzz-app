import { expect, it } from "vitest";
import { completionResult, matchCompletion } from "./completion";
import type { CompletionContext, ComposerCompletion } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
const observation = { revision: 1, text: "@hi", start: 3, end: 3 };
const context = {} as CompletionContext;
const provider = (
  key: string,
  start: number,
  end: number,
  order = 0,
): Contribution<ComposerCompletion> => ({
  key,
  id: key,
  pluginId: key,
  title: key,
  revision: "one",
  order,
  match: () => ({ start, end, query: "hi" }),
  component: () => null,
});
it("validates and deterministically arbitrates optional provider ranges", () => {
  expect(
    matchCompletion(
      [provider("z", 0, 3), provider("a", 0, 3)],
      observation,
      context,
    )?.provider.id,
  ).toBe("a");
  expect(
    matchCompletion(
      [provider("a", -1, 3), provider("z", 0, 3)],
      observation,
      context,
    )?.provider.id,
  ).toBe("z");
  expect(
    matchCompletion([provider("a", 0, 2)], observation, context),
  ).toBeUndefined();
  expect(
    matchCompletion([provider("a", 0, 3)], { ...observation, end: 4 }, context),
  ).toBeUndefined();
});
it("snapshots valid edit primitives, rejects malformed/duplicate candidates and bounds output", () => {
  const recipient = { pubkey: "a".repeat(64), name: "Honey" };
  const input = {
    items: [
      { id: "one", label: "Honey", edit: { mention: recipient } },
      { id: "one", label: "duplicate", edit: { text: "bad" } },
      {
        id: "two",
        label: "bad key",
        edit: { mention: { name: "X", pubkey: "bad" } },
      },
    ],
  };
  const result = completionResult(input);
  recipient.pubkey = "b".repeat(64);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.edit.mention?.pubkey).toBe("a".repeat(64));
  expect(
    completionResult({
      items: Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        label: String(i),
        edit: { text: "text" },
      })),
    }).items,
  ).toHaveLength(50);
});

it("copies and freezes provider-owned query primitives", () => {
  const query = { start: 0, end: 3, query: "hi" };
  const match = matchCompletion(
    [{ ...provider("a", 0, 3), match: () => query }],
    observation,
    context,
  );
  query.start = 2;
  query.query = "changed";
  expect(match?.query).toEqual({ start: 0, end: 3, query: "hi" });
  expect(Object.isFrozen(match?.query)).toBe(true);
});

it("the closest trigger wins over an earlier broad query, then order resolves ties", () => {
  const editor = { revision: 2, text: "@Honey :smile", start: 13, end: 13 };
  expect(
    matchCompletion(
      [provider("mentions", 0, 13, -10), provider("emoji", 7, 13)],
      editor,
      context,
    )?.provider.id,
  ).toBe("emoji");
});
