import { expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type {
  SendDraft,
  SendTransform,
  SendTransformContext,
} from "../conversation/contracts";
import { transformRecipients, transformSend } from "./send-transform";

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

it("dedupes recipients by key and drops stray fields", async () => {
  await expect(
    transformSend(
      transform("one", {
        transform: () =>
          ({
            text: "x",
            mentions: [alice, { ...alice, extra: 1 }, bob],
            other: true,
          }) as SendDraft,
      }),
      draft,
      context(),
    ),
  ).resolves.toEqual({ text: "x", mentions: [alice, bob] });
});

it("reads each recipient once, so a getter cannot change after validation", async () => {
  let reads = 0;
  const shifty = {
    get pubkey() {
      return reads++ === 0 ? alice.pubkey : "not-a-key";
    },
    name: "alice",
  };
  await expect(
    transformSend(
      transform("one", {
        transform: () => ({ text: "x", mentions: [shifty] }),
      }),
      draft,
      context(),
    ),
  ).resolves.toEqual({ text: "x", mentions: [alice] });
});

it.each([
  ["not an object", "text"],
  ["null", null],
  ["missing text", { mentions: [] }],

  ["omitted mentions", { text: "x" }],
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

it("names the plugin in a thrown or invalid-result error", async () => {
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
  ).rejects.toThrow("test.plugin: boom");
  await expect(
    transformSend(
      transform("one", { transform: () => ({}) as SendDraft }),
      draft,
      context(),
    ),
  ).rejects.toThrow("test.plugin: Title one returned an invalid message.");
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

it("settles on abort for a transform that ignores the signal, and drops its late result", async () => {
  const abort = new AbortController();
  let finish!: (value: SendDraft) => void;
  const pending = transformSend(
    transform("one", {
      transform: () =>
        new Promise<SendDraft>((resolve) => {
          finish = resolve;
        }),
    }),
    draft,
    context(abort.signal),
  );
  abort.abort();
  await expect(pending).rejects.toThrow();
  finish({ text: "late", mentions: [] });
  await Promise.resolve();
});

it("does not run a transform for an attempt already aborted", async () => {
  const abort = new AbortController();
  abort.abort();
  const run = vi.fn((value: SendDraft) => value);
  await expect(
    transformSend(
      transform("one", { transform: run }),
      draft,
      context(abort.signal),
    ),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

const plugin = { pluginId: "test.plugin" };
function rules(overrides = {}) {
  return {
    mayAdd: true,
    admitted: () => true,
    nameOf: (pubkey: string) => (pubkey === bob.pubkey ? "Robert" : undefined),
    ...overrides,
  };
}

it("names a new recipient from host data, never the plugin's label", () => {
  expect(
    transformRecipients(
      plugin,
      [alice, { pubkey: bob.pubkey, name: "Alice" }],
      [{ pubkey: alice.pubkey, name: "Alice (typed)" }],
      rules(),
    ),
  ).toEqual([
    { pubkey: alice.pubkey, name: "Alice (typed)" },
    { pubkey: bob.pubkey, name: "Robert" },
  ]);
});

it.each([
  ["a key the host cannot admit", rules({ admitted: () => false })],
  ["a key the host cannot name", rules({ nameOf: () => undefined })],
])("refuses %s, naming the plugin", (_name, ruleset) => {
  expect(() => transformRecipients(plugin, [bob], [], ruleset)).toThrow(
    "test.plugin: tagged someone who can't be tagged here.",
  );
});

it("refuses more than 32 recipients and, where adding is barred, any new one", () => {
  const many = Array.from({ length: 33 }, (_, index) => ({
    pubkey: index.toString(16).padStart(64, "0"),
    name: "x",
  }));
  expect(() => transformRecipients(plugin, many, [], rules())).toThrow(
    "test.plugin: tagged more than 32 recipients",
  );
  expect(() =>
    transformRecipients(plugin, [bob], [alice], rules({ mayAdd: false })),
  ).toThrow("test.plugin: tried to tag someone you did not choose");
  expect(
    transformRecipients(plugin, [alice], [alice], rules({ mayAdd: false })),
  ).toEqual([alice]);
});
