import { expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type {
  SendDraft,
  SendTransform,
  SendTransformContext,
} from "../conversation/contracts";
import { transformSend } from "./send-transform";

const alice = { pubkey: "a".repeat(64), name: "alice" };
const bob = { pubkey: "b".repeat(64), name: "bob" };
const draft: SendDraft = { text: "hello", mentions: [alice] };

function transform(
  key: string,
  overrides: Partial<SendTransform> = {},
): Contribution<SendTransform> {
  return {
    id: key,
    title: `Title ${key}`,
    key,
    pluginId: "test.plugin",
    revision: "one",
    matches: () => true,
    transform: (value) => value,
    ...overrides,
  };
}
function context(signal = new AbortController().signal) {
  return {
    session: {},
    channelId: "channel",
    signal,
  } as unknown as SendTransformContext;
}

it("hands the winner the draft and context, awaiting an async result", async () => {
  const ctx = context();
  const run = vi.fn(async () => ({ text: "later", mentions: [bob] }));
  await expect(
    transformSend(transform("one", { transform: run }), draft, ctx),
  ).resolves.toEqual({ text: "later", mentions: [bob] });
  expect(run).toHaveBeenCalledWith(draft, ctx);
});

it("treats empty text without recipients as consumed", async () => {
  await expect(
    transformSend(
      transform("one", { transform: () => ({ text: "  \n", mentions: [] }) }),
      draft,
      context(),
    ),
  ).resolves.toBeNull();
});

it("defaults omitted mentions, dedupes by key and drops stray fields", async () => {
  const result = (value: unknown) =>
    transformSend(
      transform("one", { transform: () => value as SendDraft }),
      draft,
      context(),
    );
  await expect(result({ text: "x" })).resolves.toEqual({
    text: "x",
    mentions: [],
  });
  await expect(
    result({
      text: "x",
      mentions: [alice, { ...alice, extra: 1 }, bob],
      other: true,
    }),
  ).resolves.toEqual({ text: "x", mentions: [alice, bob] });
});

it.each([
  ["not an object", "text"],
  ["null", null],
  ["missing text", { mentions: [] }],
  ["non-string text", { text: 1, mentions: [] }],
  ["non-array mentions", { text: "x", mentions: alice }],
  [
    "mention without a name",
    { text: "x", mentions: [{ pubkey: alice.pubkey }] },
  ],
  [
    "mention with a bad pubkey",
    { text: "x", mentions: [{ pubkey: "ABC", name: "alice" }] },
  ],
  ["recipients without a message", { text: " ", mentions: [alice] }],
])("rejects a malformed result: %s", async (_name, value) => {
  await expect(
    transformSend(
      transform("one", { transform: () => value as SendDraft }),
      draft,
      context(),
    ),
  ).rejects.toThrow("Title one returned an invalid message");
});

it("propagates a throwing transform", async () => {
  await expect(
    transformSend(
      transform("one", {
        transform: () => {
          throw new Error("boom");
        },
      }),
      draft,
      context(),
    ),
  ).rejects.toThrow("boom");
});

it("does not return a result once the send was aborted", async () => {
  const abort = new AbortController();
  await expect(
    transformSend(
      transform("one", {
        transform: (value) => {
          abort.abort();
          return value;
        },
      }),
      draft,
      context(abort.signal),
    ),
  ).rejects.toThrow();
});
