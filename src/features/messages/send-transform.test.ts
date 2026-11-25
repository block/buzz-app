import { afterEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type {
  SendDraft,
  SendTransform,
  SendTransformContext,
} from "../conversation/contracts";
import { transformSend } from "./send-transform";

afterEach(() => {
  vi.useRealTimers();
});

const alice = { pubkey: "a".repeat(64), name: "alice" };
const bob = { pubkey: "b".repeat(64), name: "bob" };
const draft: SendDraft = { text: "hello", mentions: [alice, bob] };

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
  } as unknown as Omit<SendTransformContext, "commit">;
}

it("hands the winner the draft and context, awaiting an async result", async () => {
  const ctx = context();
  const run = vi.fn(async () => ({ text: "later", mentions: [bob] }));
  await expect(
    transformSend(transform("one", { transform: run }), draft, ctx),
  ).resolves.toEqual({
    draft: { text: "later", mentions: [bob] },
    committed: false,
    dropped: "Title one didn't notify alice",
  });
  expect(run).toHaveBeenCalledWith(
    draft,
    expect.objectContaining({ session: ctx.session, channelId: "channel" }),
  );
});

it("treats empty text without recipients as consumed", async () => {
  await expect(
    transformSend(
      transform("one", { transform: () => ({ text: "  \n", mentions: [] }) }),
      draft,
      context(),
    ),
  ).resolves.toEqual({ draft: null, committed: false });
});

it("keeps only drafted recipients, under the host's names, deduped, in the order returned", async () => {
  await expect(
    transformSend(
      transform("one", {
        transform: () =>
          ({
            text: "x",
            mentions: [
              { pubkey: bob.pubkey, name: "Mallory" },
              alice,
              { ...alice, extra: 1 },
            ],
            other: true,
          }) as SendDraft,
      }),
      draft,
      context(),
    ),
  ).resolves.toEqual({
    draft: { text: "x", mentions: [bob, alice] },
    committed: false,
  });
});

const carol = { pubkey: "c".repeat(64), name: "carol" };
const dave = { pubkey: "d".repeat(64), name: "dave" };

it.each([
  [[alice, bob, carol], [carol], "Title one didn't notify alice and bob"],
  [
    [alice, bob, carol, dave],
    [dave],
    "Title one didn't notify alice and 2 others",
  ],
])(
  "names the people it dropped, by the draft's own names: %#",
  async (typed, kept, notice) => {
    const { dropped } = await transformSend(
      transform("one", {
        transform: () => ({
          text: "x",
          // The plugin's own names for the people it kept never reach the notice.
          mentions: kept.map((item) => ({ ...item, name: "Mallory" })),
        }),
      }),
      { text: "hello", mentions: typed },
      context(),
    );
    expect(dropped).toBe(notice);
  },
);

it("says nothing when the plugin keeps everyone, or when it consumes the message", async () => {
  await expect(
    transformSend(
      transform("one", {
        transform: () => ({ text: "rewritten", mentions: [bob, alice] }),
      }),
      draft,
      context(),
    ),
  ).resolves.toEqual({
    draft: { text: "rewritten", mentions: [bob, alice] },
    committed: false,
  });
  const consumed = await transformSend(
    transform("one", { transform: () => ({ text: "", mentions: [] }) }),
    draft,
    context(),
  );
  expect(consumed.dropped).toBeUndefined();
});

it("fails the send, naming the plugin, for a recipient the person did not address", async () => {
  const stranger = { pubkey: "c".repeat(64), name: "carol" };
  await expect(
    transformSend(
      transform("one", {
        transform: () => ({ text: "x", mentions: [alice, stranger] }),
      }),
      draft,
      context(),
    ),
  ).rejects.toThrow("test.plugin: returned a recipient you did not address");
});

it("reads each recipient once, so a getter cannot swap in someone else", async () => {
  let reads = 0;
  const shifty = {
    get pubkey() {
      return reads++ === 0 ? alice.pubkey : "c".repeat(64);
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
  ).resolves.toEqual({
    draft: { text: "x", mentions: [alice] },
    committed: false,
    dropped: "Title one didn't notify bob",
  });
});

it.each([
  ["not an object", "text"],
  ["null", null],
  ["missing text", { mentions: [] }],
  ["omitted mentions", { text: "x" }],
  ["non-string text", { text: 1, mentions: [] }],
  ["non-array mentions", { text: "x", mentions: alice }],
  ["mention without a key", { text: "x", mentions: [{ name: "alice" }] }],
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

it("times out a transform that never settles, aborting its signal and dropping its late result", async () => {
  vi.useFakeTimers();
  let seen!: AbortSignal;
  let finish!: (value: SendDraft) => void;
  const pending = transformSend(
    transform("one", {
      transform: (_value, { signal }) => {
        seen = signal;
        return new Promise<SendDraft>((resolve) => {
          finish = resolve;
        });
      },
    }),
    draft,
    context(),
  );
  const failure = expect(pending).rejects.toThrow("test.plugin: timed out");
  await vi.advanceTimersByTimeAsync(9_999);
  expect(seen.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(seen.aborted).toBe(true);
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

it("keeps a committed write from being replayed: timeout, abort or a throw spend the draft", async () => {
  vi.useFakeTimers();
  const never = (): Promise<SendDraft> => new Promise(() => {});
  const committing = (after: () => Promise<SendDraft>) =>
    transform("one", {
      transform: (_value, { commit }) => {
        commit();
        commit();
        return after();
      },
    });
  const timed = transformSend(committing(never), draft, context());
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(timed).resolves.toEqual({
    draft: null,
    committed: true,
    notice: "test.plugin: still finishing",
  });
  const abort = new AbortController();
  const escaped = transformSend(
    committing(never),
    draft,
    context(abort.signal),
  );
  abort.abort();
  await expect(escaped).resolves.toMatchObject({
    committed: true,
    notice: "test.plugin: still finishing",
  });
  await expect(
    transformSend(
      committing(async () => {
        throw new Error("relay said no");
      }),
      draft,
      context(),
    ),
  ).resolves.toEqual({
    draft: null,
    committed: true,
    error: "test.plugin: relay said no",
  });
});

it("validates against the recipients the person addressed, however a plugin edits its input", async () => {
  const stranger = { pubkey: "c".repeat(64), name: "carol" };
  const original = { text: "hello", mentions: [alice, bob] };
  let edited = true;
  await expect(
    transformSend(
      transform("one", {
        transform: (value) => {
          // A plugin in strict mode throws here; a careless one carries on.
          try {
            (value.mentions as { pubkey: string; name: string }[]).push(
              stranger,
            );
          } catch {
            edited = false;
          }
          return { text: "x", mentions: [alice, stranger] };
        },
      }),
      original,
      context(),
    ),
  ).rejects.toThrow("test.plugin: returned a recipient you did not address");
  expect(edited).toBe(false);
  expect(original.mentions).toEqual([alice, bob]);
});

it("refuses a late commit() once Esc or the timeout won, so the write never starts", async () => {
  vi.useFakeTimers();
  const lookups: (() => void)[] = [];
  const writes = vi.fn();
  const lateWriter = transform("one", {
    transform: (_value, { commit }) =>
      new Promise<SendDraft>((resolve) => {
        lookups.push(() => {
          commit();
          writes();
          resolve({ text: "", mentions: [] });
        });
      }),
  });
  const abort = new AbortController();
  const escaped = expect(
    transformSend(lateWriter, draft, context(abort.signal)),
  ).rejects.toThrow();
  abort.abort();
  await escaped;
  const timed = expect(
    transformSend(lateWriter, draft, context()),
  ).rejects.toThrow("test.plugin: timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await timed;
  for (const lookup of lookups) expect(lookup).toThrow();
  expect(writes).not.toHaveBeenCalled();
});

it("refuses a commit() after the transform settled", async () => {
  let commit!: () => void;
  await transformSend(
    transform("one", {
      transform: (value, context) => {
        commit = context.commit;
        return value;
      },
    }),
    draft,
    context(),
  );
  expect(commit).toThrow();
});
