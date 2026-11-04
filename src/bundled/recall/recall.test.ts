// biome-ignore-all lint/style/noNonNullAssertion: Fixtures deliberately require their arranged calls, elements and results to exist.
import { afterEach, expect, test, vi } from "vitest";
import type { Candidate, DecisionRequest } from "./types.ts";
import { recall } from "./recall.ts";
import { deps, message, turn } from "./fake.ts";

test("an empty turn recalls nothing", async () => {
  expect(await recall(turn(), deps())).toBeUndefined();
});

const keep = async (request: DecisionRequest) => ({
  outcome: "answered" as const,
  backend: "fake",
  model: "fake",
  answers: Object.fromEntries(
    Object.keys(request.questions).map((k) => [
      k,
      { type: "yes_no" as const, probability: 1 },
    ]),
  ),
});
const vectorHit: Candidate = {
  id: "f".repeat(64),
  kind: "message",
  text: "Bought a Labrador",
  at: 1_700_000_000,
};

test("semantic neighbours join lexical hits; commits the snapshot before its lease ends", async () => {
  let commits = 0;
  let release!: () => void;
  const snapshot = new Promise<() => void>((r) => {
    release = () => r(() => void commits++);
  });
  const t = turn(
    { text: "which pet", deadline: 3_000 },
    { events: async () => [message("m", "which pet: a cat")] },
  );
  const result = recall(
    t,
    deps({
      decide: keep,
      semantic: {
        observe: () => snapshot,
        neighbours: async () => [vectorHit],
      },
    }),
  );
  release();
  const out = await result;
  expect(out).toContain("which pet: a cat"); // control: lexical still recalls
  expect(out).toContain("Bought a Labrador");
  expect(commits).toBe(1);
});

test("failing semantic search or observation leaves lexical recall unchanged", async () => {
  const t = turn(
    { text: "which pet", deadline: 3_000 },
    { events: async () => [message("m", "which pet: a cat")] },
  );
  const out = await recall(
    t,
    deps({
      decide: keep,
      semantic: {
        observe: () => Promise.reject(new Error("lease revoked")),
        neighbours: () => Promise.reject(new Error("server gone")),
      },
    }),
  );
  expect(out).toContain("which pet: a cat");
});

afterEach(() => vi.useRealTimers());

test("a no-keyword turn commits before revoke-on-settle", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let live = true;
  let commits = 0;
  const t = turn(
    { text: "the and of", deadline: 1000 },
    {
      channel: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (!live) throw new Error("revoked");
        return undefined;
      },
    },
  );
  const result = recall(
    t,
    deps({
      now: Date.now,
      semantic: {
        observe: async (turn) => {
          await turn.reads.channel(turn.channel);
          return () => {
            if (live) commits++;
          };
        },
        neighbours: async () => [],
      },
    }),
  ).finally(() => {
    live = false;
  });
  await vi.advanceTimersByTimeAsync(10);
  await result;
  expect(commits).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a hanging snapshot preserves the lexical answer before the lease deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let live = true;
  let answer: string | undefined;
  let settled = false;
  const t = turn(
    { text: "which pet", deadline: 1000 },
    {
      events: async () => {
        if (!live) throw new Error("revoked");
        return [message("m", "which pet: a cat")];
      },
    },
  );
  void recall(
    t,
    deps({
      now: Date.now,
      decide: keep,
      semantic: {
        observe: () => new Promise(() => {}),
        neighbours: async () => [],
      },
    }),
  ).then((value) => {
    answer = Date.now() < t.deadline ? value : undefined;
    live = false;
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(900);
  expect(settled).toBe(true);
  expect(answer).toContain("which pet: a cat");
  expect(vi.getTimerCount()).toBe(0);
});
